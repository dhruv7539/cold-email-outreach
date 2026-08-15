import { getLlmConfigForUser } from "@/lib/llm/config";
import {
  getCredentials,
  getProfile,
  getSkipEmails,
  getKnownAddressesForDomains,
  recordKnownAddresses,
} from "@/lib/repo";
import { parseJob } from "@/lib/llm/parse-job";
import { scoreIntake } from "@/lib/llm/score-intake";
import { selectContacts, type Candidate } from "@/lib/llm/select-contacts";
import { writeBriefs } from "@/lib/llm/write-brief";
import { draftWithRepair, extractReusableSentences } from "@/lib/llm/repair-loop";
import { createCampaign, updateCampaign, replaceContacts, getCampaign, getContacts, upsertDraft } from "./repo";
import { searchPeople, enrichPeople } from "@core/apollo/client.mjs";
import { resolveAddresses } from "@core/enrichment/resolve.mjs";
import { checkEligibility, signatureHtml, profileForPrompt } from "@core/profile/schema.mjs";

// The steps a campaign moves through, each a discrete unit so the UI can show
// progress and a failure can be retried without redoing the whole thing.

export async function runIntake(userId: string, jobText: string) {
  const llm = await getLlmConfigForUser(userId);
  if (!llm) throw new Error("Add your AI key in Settings before starting a campaign.");

  const profile = await getProfile(userId);
  if (!profile) throw new Error("Finish your profile before starting a campaign.");

  const campaign = await createCampaign(userId, jobText);
  const parsedJob = await parseJob(llm, jobText);

  // Eligibility is checked before scoring: a job the candidate cannot legally
  // hold is refused outright rather than scored and discussed.
  const eligibility = checkEligibility(profile, parsedJob);
  const intake = scoreIntake(parsedJob, profile as never);

  await updateCampaign(userId, campaign.id, {
    company: parsedJob.company,
    role_title: parsedJob.roleTitle,
    req_id: parsedJob.reqId,
    apply_url: parsedJob.applyUrl,
    parsed_job: parsedJob,
    intake_score: intake.total,
    intake_verdict: eligibility.eligible ? intake.verdict : "skip",
    intake_rationale: eligibility.eligible ? intake.rationale : eligibility.blockers.join(" "),
    status: eligibility.eligible ? "scored" : "blocked",
    status_detail: eligibility.eligible ? "" : "Ineligible role",
  });

  return { campaignId: campaign.id, eligible: eligibility.eligible, blockers: eligibility.blockers, parsedJob, intake };
}

export async function runDiscovery(userId: string, campaignId: string) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new Error("Campaign not found.");

  const creds = await getCredentials(userId);
  if (!creds.apolloApiKey) throw new Error("Add your Apollo key in Settings to find contacts.");
  const apolloKey = creds.apolloApiKey;

  const job = campaign.parsed_job as Awaited<ReturnType<typeof parseJob>>;
  await updateCampaign(userId, campaignId, { status: "discovering" });

  const domains = job.companyDomain ? [job.companyDomain] : [];

  const found: Candidate[] = await searchPeople(
    apolloKey,
    { domains, titles: buildTitleFilters(job), keywords: job.teamTerms.join(" ") },
    { limit: 40 }
  );

  const { selected } = selectContacts(found, job, {
    min: job.seniority === "new_grad" ? 4 : 2,
    max: campaign.intake_verdict === "full" ? 6 : 4,
    companyIsSmall: job.companySizeGuess === "small" || job.companySizeGuess === "startup",
  });

  const known = await getKnownAddressesForDomains(userId, domains);
  const skip = await getSkipEmails(userId);

  const resolution = await resolveAddresses(
    selected.map((c) => ({
      id: c.id,
      name: c.name,
      firstName: c.firstName,
      lastName: c.lastName,
      domain: c.organizationDomain || job.companyDomain,
    })),
    {
      knownAddresses: known.map((k) => ({
        email: k.email,
        domain: k.domain,
        name: k.full_name,
        firstName: k.first_name,
        lastName: k.last_name,
      })),
      millionVerifierKey: creds.millionVerifierApiKey ?? undefined,
      enrich: async (contacts: { id: string }[]) => enrichPeople(apolloKey, contacts.map((c) => ({ id: c.id }))),
    }
  );

  const addressById = new Map(resolution.resolved.map((r: { id: string }) => [r.id, r]));

  // Record freshly verified addresses so the next campaign at this company can
  // learn the format for free.
  await recordKnownAddresses(
    userId,
    resolution.resolved
      .filter((r: { email?: string; source: string }) => r.email && r.source !== "unresolved")
      .map((r: { email: string; firstName?: string; lastName?: string; name?: string }) => ({
        email: r.email,
        firstName: r.firstName,
        lastName: r.lastName,
        fullName: r.name,
      }))
  );

  const withAddresses = selected
    .map((c) => ({ contact: c, resolved: addressById.get(c.id) as { email?: string; source?: string; verification?: unknown } | undefined }))
    .filter(({ resolved }) => resolved?.email && !skip.has(resolved.email!.toLowerCase()));

  await replaceContacts(
    userId,
    campaignId,
    withAddresses.map(({ contact, resolved }) => ({
      apollo_id: contact.id,
      first_name: contact.firstName,
      last_name: contact.lastName,
      full_name: contact.name,
      title: contact.title,
      headline: contact.headline ?? "",
      contact_type: contact.contactType,
      email: resolved!.email!,
      email_source: resolved!.source ?? null,
      email_verification: (resolved!.verification as Record<string, unknown>) ?? null,
      linkedin_url: contact.linkedinUrl ?? null,
      city: contact.city ?? "",
      state: contact.state ?? "",
      selected: true,
      brief: "",
    }))
  );

  await updateCampaign(userId, campaignId, {
    status: "discovered",
    status_detail: `${withAddresses.length} contacts, ${resolution.creditsUsed} enrichment credits used`,
  });

  return { contactCount: withAddresses.length, creditsUsed: resolution.creditsUsed };
}

export async function runDrafting(userId: string, campaignId: string) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new Error("Campaign not found.");

  const llm = await getLlmConfigForUser(userId);
  if (!llm) throw new Error("Add your AI key in Settings.");

  const profile = await getProfile(userId);
  if (!profile) throw new Error("Finish your profile before drafting.");
  const job = campaign.parsed_job as Awaited<ReturnType<typeof parseJob>>;
  const contacts = await getContacts(userId, campaignId);
  if (!contacts.length) throw new Error("No contacts to draft for. Run discovery first.");

  await updateCampaign(userId, campaignId, { status: "drafting" });

  const scored = contacts.map((c) => ({
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    name: c.full_name,
    title: c.title,
    headline: c.headline,
    linkedinUrl: c.linkedin_url,
    city: c.city,
    state: c.state,
    organizationDomain: job.companyDomain,
    contactType: c.contact_type,
    score: 0,
    teamMatch: false,
    reasons: [] as string[],
  }));

  const briefs = await writeBriefs(llm, scored as never[], job);
  const signature = signatureHtml(profile);
  const promptProfile = profileForPrompt(profile);

  // The avoid list grows as we draft, so no two people at this company get the
  // same sentence, which is what keeps a campaign from reading as a mail merge.
  const avoid: string[] = [];

  for (const contact of contacts) {
    const scoredContact = scored.find((s) => s.id === contact.id)!;
    const brief = briefs.get(contact.id)!;

    const result = await draftWithRepair({
      llm,
      contact: scoredContact as never,
      brief,
      job,
      profile: {
        ...promptProfile,
        firstName: (profile as { firstName?: string }).firstName ?? "",
        fullName: (profile as { fullName?: string }).fullName ?? "",
      } as never,
      signature,
      recipientEmail: contact.email!,
      avoidSentences: avoid.slice(-20),
    });

    avoid.push(...extractReusableSentences(result.draft));

    await upsertDraft(userId, campaignId, contact.id, {
      subject: result.draft.subject,
      main_html: result.draft.html,
      follow_up_1_html: result.draft.followUp1Html,
      cta_type: result.draft.ctaType,
      lead_proof: result.draft.leadProof,
      copy_structure: result.draft.copyStructure,
      subject_variant: result.draft.subjectVariant,
      lint_findings: result.findings,
      lint_errors: result.errors,
      repair_attempts: result.attempts,
    });
  }

  await updateCampaign(userId, campaignId, { status: "review", status_detail: "" });
  return { drafted: contacts.length };
}

function buildTitleFilters(job: Awaited<ReturnType<typeof parseJob>>): string[] {
  const base = ["recruiter", "technical recruiter", "university recruiter", "talent acquisition", "sourcer"];
  // A manager or engineer is only worth pulling when there is a real team to match.
  if (job.team || job.teamTerms.length) {
    base.push("engineering manager", "software engineer", "engineering lead");
  }
  return base;
}
