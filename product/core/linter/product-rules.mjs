// Product-only linter rules.
//
// These are NOT in the CLI linter (review-spec.mjs), which is a frozen verbatim
// port. Keeping product-specific rules here preserves that port's fidelity while
// letting the hosted product close gaps the CLI never needed, because the CLI
// always had a human reading each draft and the product does not.
//
// applyProductRules() takes an existing review (from reviewSpec) plus the raw
// drafts, appends any product findings onto the matching per-draft result, and
// updates the summary + ok flag in place.

import { stripHtmlToText } from "./cta-classifier.mjs";

// Generic persona openers: "As a technical recruiter at X, you probably see a
// lot of these." This flatters a role rather than referencing anything the
// person actually did, and it is the tell of a mail merge. The CLI's
// persona_opener rule was narrower; this catches the general shape.
const PERSONA_OPENER = /^(?:as|being) (?:a|an|the)\b[^.?!]*\b(?:you (?:probably|likely|no doubt|surely|must)|i (?:know|imagine|bet))\b/i;

// Filler closers that add nothing and read as templated politeness.
const FILLER_CLOSERS = [
  /\blooking forward to hearing (?:from|back)\b/i,
  /\bthanks in advance\b/i,
  /\bhope (?:this|my) (?:email|note|message) finds you well\b/i,
  /\bhope you(?:'re| are) (?:doing )?well\b/i,
];

function firstSentence(html) {
  const text = stripHtmlToText(html || "").replace(/\s+/g, " ").trim();
  // Skip the greeting, which ends at its own comma. The character class must
  // exclude the comma or it swallows the first real sentence too.
  const withoutGreeting = text.replace(/^(hi|hello|hey|dear)\b[^,.!?]*[,.!?]\s*/i, "");
  const match = /^[^.!?]+[.!?]/.exec(withoutGreeting);
  return (match ? match[0] : withoutGreeting).trim();
}

/** Product-only findings for one draft. */
export function reviewDraftProductRules(draft) {
  const findings = [];
  const opener = firstSentence(draft.html || "");

  if (opener && PERSONA_OPENER.test(opener)) {
    findings.push({
      severity: "error",
      code: "persona_opener_generic",
      message:
        "Opener addresses their role generically (\"As a <role>, you probably...\"), not anything they did. Lead with a specific fact about their work, team, or a public signal.",
    });
  }

  const text = stripHtmlToText(draft.html || "");
  for (const pattern of FILLER_CLOSERS) {
    if (pattern.test(text)) {
      findings.push({
        severity: "warning",
        code: "filler_closer",
        message: "Closing line is filler (\"looking forward to hearing from you\" / \"hope you're well\"). Cut it or replace with the ask.",
      });
      break;
    }
  }

  return findings;
}

/**
 * Merge product findings into an existing review. Mutates and returns `review`.
 * `drafts` must be in the same order as `review.results`.
 */
export function applyProductRules(review, drafts) {
  const bySeverity = { errors: 0, warnings: 0 };

  drafts.forEach((draft, index) => {
    const extra = reviewDraftProductRules(draft);
    if (!extra.length) return;

    const target = review.results[index];
    if (target) target.findings.push(...extra);

    for (const finding of extra) {
      if (finding.severity === "error") bySeverity.errors += 1;
      else bySeverity.warnings += 1;
    }
  });

  review.summary.errors += bySeverity.errors;
  review.summary.warnings += bySeverity.warnings;
  review.ok = review.summary.errors === 0;

  return review;
}
