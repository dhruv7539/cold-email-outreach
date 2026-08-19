import { complete, type LlmConfig } from "./provider";
import { COPY_SYSTEM_PROMPT, proofGuidance } from "./prompts";
import type { ScoredCandidate } from "./select-contacts";
import type { ContactBrief } from "./write-brief";
import type { ParsedJob } from "./parse-job";

export type DraftProfile = {
  firstName: string;
  fullName: string;
  proofs?: { id: string; kind: string; text: string; roleTypes: string[] }[];
  stackPositioning?: string;
};

export type DraftEmail = {
  to?: string;
  subject: string;
  html: string;
  followUp1Html: string;
  ctaType: string;
  leadProof: string;
  copyStructure: string;
  subjectVariant: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    html: { type: "string", description: "The main email body as HTML <p> paragraphs, ending with the signature." },
    followUp1Html: { type: "string", description: "A short follow-up with a NEW angle plus a soft referral ask, HTML." },
    ctaType: { type: "string", enum: ["routing", "fit", "scheduling"], description: "Shape of the ask." },
    leadProof: { type: "string", description: "Which proof you led with (short label)." },
    copyStructure: { type: "string", description: "Short tag for the scaffold used, e.g. 'hook-proof-ask'." },
    subjectVariant: { type: "string", enum: ["role", "team", "plain"] },
  },
  required: ["subject", "html", "followUp1Html", "ctaType"],
} as const;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, " ").replace(/—/g, "-").trim().slice(0, 120);
}

export async function draftEmail(
  llm: LlmConfig,
  input: {
    contact: ScoredCandidate;
    brief: ContactBrief;
    job: ParsedJob;
    profile: DraftProfile;
    signature: string;
    avoidSentences?: string[];
    priorFindings?: { code: string; message: string }[];
    priorAttempt?: { subject: string; html: string; followUp1Html: string };
  }
): Promise<DraftEmail> {
  const { contact, brief, job, profile, signature, avoidSentences = [], priorFindings = [], priorAttempt } = input;

  const context = [
    `Recipient: ${contact.name}, ${contact.title} at ${job.company}.`,
    `They are a ${contact.contactType.replace(/_/g, " ")}.`,
    brief.hook && brief.hookConfidence !== "none" ? `Confident hook: ${brief.hook}` : "No confident personal hook; open on honest team/role relevance.",
    brief.teamRelevance ? `Team relevance: ${brief.teamRelevance}` : "",
    brief.suggestedAngle ? `Suggested angle: ${brief.suggestedAngle}` : "",
    `Target role: ${job.roleTitle}${job.team ? ` on ${job.team}` : ""}.`,
    job.stack.length ? `Role stack: ${job.stack.join(", ")}.` : "",
    profile.stackPositioning ? `Candidate stack positioning: ${profile.stackPositioning}` : "",
    "",
    proofGuidance(profile.proofs ?? []),
    "",
    `Sign the email with exactly this signature HTML: ${signature}`,
  ].filter(Boolean).join("\n");

  const avoidance = avoidSentences.length
    ? `\n\nDo NOT reuse any of these sentences (already used for other contacts at this company):\n${avoidSentences.map((s) => `- ${s}`).join("\n")}`
    : "";

  const repair = priorFindings.length && priorAttempt
    ? `\n\nYour previous attempt failed these checks. Fix EACH one:\n${priorFindings.map((f) => `- ${f.code}: ${f.message}`).join("\n")}\n\nPrevious subject: ${priorAttempt.subject}\nPrevious body:\n${priorAttempt.html}`
    : "";

  const raw = await complete<Partial<DraftEmail>>(llm, {
    system: COPY_SYSTEM_PROMPT,
    prompt: `Write a first-touch cold email and a follow-up for this contact.\n\n${context}${avoidance}${repair}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    tier: "smart",
    temperature: priorFindings.length ? 0.4 : 0.7,
    maxTokens: 1500,
  });

  return {
    subject: sanitizeSubject(raw.subject ?? `${job.roleTitle} at ${job.company}`),
    html: (raw.html ?? "").trim(),
    followUp1Html: (raw.followUp1Html ?? "").trim(),
    ctaType: raw.ctaType ?? "fit",
    leadProof: raw.leadProof ?? "",
    copyStructure: raw.copyStructure ?? "hook-proof-ask",
    subjectVariant: raw.subjectVariant ?? "plain",
  };
}

export { escapeHtml };
