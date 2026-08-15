"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { runIntake, runDiscovery, runDrafting } from "@/lib/campaign/orchestrate";
import { queueApprovedDrafts } from "@/lib/campaign/queue";
import { saveDraftEdit, approveDraft, getDrafts } from "@/lib/campaign/repo";
import { addToBlacklist } from "@/lib/repo";
import { reviewSpec } from "@core/linter/review-spec.mjs";
import { applyProductRules } from "@core/linter/product-rules.mjs";

type StartState = { ok: boolean; error: string | null; campaignId?: string };

export async function startCampaignAction(_prev: StartState, formData: FormData): Promise<StartState> {
  const user = await requireUser();
  const jobText = String(formData.get("jobText") ?? "").trim();

  if (jobText.length < 80) {
    return { ok: false, error: "Paste the full job description, not just a title." };
  }

  try {
    const result = await runIntake(user.id, jobText);
    return { ok: true, error: null, campaignId: result.campaignId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export async function discoverAction(campaignId: string) {
  const user = await requireUser();
  try {
    const result = await runDiscovery(user.id, campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Discovery failed." };
  }
}

export async function draftAction(campaignId: string) {
  const user = await requireUser();
  try {
    const result = await runDrafting(user.id, campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Drafting failed." };
  }
}

export async function saveDraftEditAction(
  draftId: string,
  campaignId: string,
  patch: { subject: string; main_html: string; follow_up_1_html: string }
) {
  const user = await requireUser();

  // Re-lint the edited copy so the badge reflects what the user actually wrote,
  // including the product-only rules.
  const review = applyProductRules(
    reviewSpec({ drafts: [{ subject: patch.subject, html: patch.main_html, followUp1Html: patch.follow_up_1_html, followUpCount: 1 }] }),
    [{ html: patch.main_html, followUp1Html: patch.follow_up_1_html }]
  );

  const findings = [
    ...review.results.flatMap((r: { findings: unknown[] }) => r.findings),
    ...review.specFindings,
  ];

  await saveDraftEdit(user.id, draftId, {
    ...patch,
    lint_findings: findings,
    lint_errors: review.summary.errors,
  });

  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, errors: review.summary.errors, findings };
}

export async function approveDraftAction(draftId: string, campaignId: string, approved: boolean) {
  const user = await requireUser();
  await approveDraft(user.id, draftId, approved);
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

export async function removeContactAction(email: string, campaignId: string) {
  const user = await requireUser();
  // Manually removing a contact suppresses them so they are not re-added later.
  await addToBlacklist(user.id, email, "removed by user", "manual");
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

export async function queueAction(campaignId: string) {
  const user = await requireUser();

  // Guard: nothing queues unless at least one draft is approved and error-free.
  const drafts = await getDrafts(user.id, campaignId);
  const approvedClean = drafts.filter((d) => d.approved_at && d.lint_errors === 0);
  if (!approvedClean.length) {
    return { ok: false, error: "Approve at least one draft with no blocking issues before queueing." };
  }

  try {
    const result = await queueApprovedDrafts(user.id, campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/dashboard");
    if (result.blocked) {
      return { ok: false, error: `Queueing is paused: ${result.health.alerts.join(" ")}` };
    }
    return { ok: true, queued: result.queued };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not queue." };
  }
}
