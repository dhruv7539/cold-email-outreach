import { draftEmail, type DraftEmail, type DraftProfile } from "./draft-emails";
import type { LlmConfig } from "./provider";
import type { ScoredCandidate } from "./select-contacts";
import type { ContactBrief } from "./write-brief";
import type { ParsedJob } from "./parse-job";
import { reviewSpec, flattenFindings } from "@core/linter/review-spec.mjs";
import { applyProductRules } from "@core/linter/product-rules.mjs";

// Draft, lint, feed the errors back, redraft.
//
// This is the mechanism that replaces the human in the loop. The linter is
// deterministic, so it can be used as a reward signal: the model is not asked to
// self-assess, it is told exactly which coded rule it broke and given another
// attempt. Three attempts is the cap; past that the failures are almost always a
// missing input (no usable hook, no fitting proof) rather than something a
// rewrite fixes, so the best attempt is surfaced with its findings for the user.

const MAX_ATTEMPTS = 3;

export type DraftResult = {
  draft: DraftEmail;
  findings: { severity: string; code: string; message: string; draftKey?: string | null }[];
  errors: number;
  warnings: number;
  attempts: number;
  clean: boolean;
};

export async function draftWithRepair(options: {
  llm: LlmConfig;
  contact: ScoredCandidate;
  brief: ContactBrief;
  job: ParsedJob;
  profile: DraftProfile;
  signature: string;
  recipientEmail: string;
  avoidSentences?: string[];
}): Promise<DraftResult> {
  const { llm, contact, brief, job, profile, signature, recipientEmail, avoidSentences = [] } = options;

  let attempt = 0;
  let priorFindings: { code: string; message: string }[] = [];
  let priorAttempt: { subject: string; html: string; followUp1Html: string } | undefined;
  let best: DraftResult | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;

    const draft = await draftEmail(llm, {
      contact,
      brief,
      job,
      profile,
      signature,
      avoidSentences,
      priorFindings,
      priorAttempt,
    });
    draft.to = recipientEmail;

    const review = applyProductRules(reviewSpec({ drafts: [{ ...draft }] }), [draft]);
    const findings = flattenFindings(review) as DraftResult["findings"];
    const errors = review.summary.errors;
    const warnings = review.summary.warnings;

    const result: DraftResult = { draft, findings, errors, warnings, attempts: attempt, clean: errors === 0 };

    if (!best || errors < best.errors || (errors === best.errors && warnings < best.warnings)) {
      best = result;
    }

    if (errors === 0) return result;

    priorFindings = findings.filter((f) => f.severity === "error").map((f) => ({ code: f.code, message: f.message }));
    priorAttempt = { subject: draft.subject, html: draft.html, followUp1Html: draft.followUp1Html };
  }

  return best!;
}

/**
 * Campaign-level pass. Some rules only exist across drafts, most importantly the
 * ban on reusing a sentence between two people at the same company.
 */
export function reviewCampaign(drafts: DraftEmail[]) {
  const review = applyProductRules(reviewSpec({ drafts }), drafts);
  return {
    errors: review.summary.errors,
    warnings: review.summary.warnings,
    findings: flattenFindings(review) as DraftResult["findings"],
    ok: review.ok,
  };
}

/** Sentences long enough for the duplication rule to notice, for the avoid list. */
export function extractReusableSentences(draft: DraftEmail): string[] {
  const text = `${draft.html} ${draft.followUp1Html}`
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 8);
}
