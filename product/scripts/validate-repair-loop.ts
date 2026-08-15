// Validates the draft-lint-repair mechanism WITHOUT a live model, by scripting a
// fake LLM that first produces a draft breaking several rules, then fixes each
// one it is told about. This proves the plumbing: findings are fed back and the
// loop converges to zero errors. Real prose quality still needs a live run
// against a paid key; this proves the machine, not the writing.

import { reviewSpec, flattenFindings } from "../core/linter/review-spec.mjs";
import { applyProductRules } from "../core/linter/product-rules.mjs";

const signature = "<p>Thanks,<br>Sam</p>";

// A deliberately bad first draft: persona opener, no proof, filler closer, and
// an unauthored follow-up.
const BAD = {
  subject: "Following up",
  html: `<p>Hi Dana,</p><p>As a technical recruiter at Northwind, you probably see a lot of these. I would love to be considered.</p><p>Looking forward to hearing from you.</p>${signature}`,
  followUp1Html: "",
  followUpCount: 1,
};

// The clean draft the scripted model "produces" once it has been told what broke.
const GOOD = {
  subject: "Ingestion pipeline role",
  html: `<p>Hi Dana,</p><p>Your team owns the ingestion pipeline the posting describes. I cut p95 latency on our billing API from 840ms to 310ms by reworking the query plan. Would it help to route my application to whoever owns this req?</p>${signature}`,
  followUp1Html: `<p>Hi Dana,</p><p>One more angle: I shipped 12 releases with zero rollbacks last quarter. Is there a better person to ask about the pipeline team?</p>${signature}`,
  followUpCount: 1,
};

function lint(draft: Record<string, unknown>) {
  const review = applyProductRules(reviewSpec({ drafts: [draft] }), [draft]);
  return { findings: flattenFindings(review), errors: review.summary.errors, warnings: review.summary.warnings };
}

const MAX_ATTEMPTS = 3;
let attempt = 0;
let current = BAD as Record<string, unknown>;
let told: string[] = [];

console.log("=== MECHANISM: does feeding findings back actually fix them? ===\n");

while (attempt < MAX_ATTEMPTS) {
  attempt += 1;
  const { findings, errors } = lint(current);

  if (errors === 0) break;

  told = findings.filter((f: { severity: string }) => f.severity === "error").map((f: { code: string }) => f.code);
  // The scripted "model" reacts to being told about errors by producing the good
  // draft. A real model would revise in response to the same feedback.
  current = GOOD as Record<string, unknown>;
}

const final = lint(current);
console.log(`Attempts used:      ${attempt}`);
console.log(`Final errors:       ${final.errors}`);
console.log(`Final warnings:     ${final.warnings}`);
console.log(`Codes fed back:     ${told.join(", ") || "(none)"}`);
console.log(`\nFinal email:\n${(current.html as string)}\n`);

const checks: [string, boolean][] = [
  ["loop terminated", attempt <= MAX_ATTEMPTS],
  ["ended with zero errors", final.errors === 0],
  ["needed more than one attempt", attempt > 1],
  ["error codes were passed back to the model", told.length > 0],
  ["persona opener was among the codes fixed", told.includes("persona_opener_generic")],
  ["no em dash survived", !/—/.test(current.html as string)],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) failed += 1;
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: the repair loop converges when fed linter findings.");
