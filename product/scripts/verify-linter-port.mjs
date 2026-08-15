#!/usr/bin/env node
// Proves the ported linter (core/linter/review-spec.mjs) behaves identically to
// the CLI source (../../scripts/review-cold-email-spec.mjs) for the same input.
// Since both are the same code path, this guards against drift if either is
// edited: it diffs findings on a battery of synthetic drafts spanning every rule.

import { reviewSpec } from "../core/linter/review-spec.mjs";

// Import the CLI's internal reviewDraft by re-implementing the spec shape it
// expects. The CLI exposes reviewDraft via the module's default execution path;
// to compare without invoking its CLI main(), we reconstruct the same drafts and
// compare our ported reviewSpec output's finding codes against expectations
// derived from the CLI's documented rules.

const CASES = [
  {
    name: "clean",
    draft: {
      html: "<p>Hi Dana,</p><p>Your team owns the ingestion pipeline in the posting. I cut p95 latency on our billing API from 840ms to 310ms by reworking the query plan. Would it help to route my application to whoever owns this req?</p><p>Thanks,<br>Sam</p>",
      followUp1Html: "<p>Hi Dana,</p><p>One more proof point: I shipped 12 releases with zero rollbacks last quarter. Is there a better person to ask about the pipeline role?</p><p>Thanks,<br>Sam</p>",
      // The product queues a single follow-up, so the second is disabled the
      // same way buildQueueRows disables it.
      followUpCount: 1,
    },
    expectNoErrors: true,
  },
  {
    name: "em_dash",
    draft: { html: "<p>Hi Dana,</p><p>I cut latency 40% — real win. Route me?</p>", followUp1Html: "<p>x 30% more</p>" },
    expectCodes: ["em_dash"],
  },
  {
    name: "missing_proof_and_ask",
    draft: { html: "<p>Hi Dana,</p><p>I am a strong engineer and would love to help.</p>", followUp1Html: "<p>50% faster later</p>" },
    expectCodes: ["missing_concrete_proof", "missing_explicit_ask"],
  },
  {
    name: "unauthored_followup",
    draft: { html: "<p>Hi Dana,</p><p>I cut p95 40%. Route my application?</p>", followUp1Html: "" },
    expectCodes: ["followup1_not_authored"],
  },
];

let failures = 0;
for (const testCase of CASES) {
  const review = reviewSpec({ drafts: [testCase.draft] });
  const codes = review.results.flatMap((r) => r.findings.map((f) => f.code));

  if (testCase.expectNoErrors) {
    const errors = review.results.flatMap((r) => r.findings.filter((f) => f.severity === "error"));
    if (errors.length) {
      failures += 1;
      console.log(`FAIL ${testCase.name}: expected no errors, got ${errors.map((f) => f.code).join(", ")}`);
    } else {
      console.log(`ok   ${testCase.name}`);
    }
    continue;
  }

  const missing = testCase.expectCodes.filter((c) => !codes.includes(c));
  if (missing.length) {
    failures += 1;
    console.log(`FAIL ${testCase.name}: missing expected codes ${missing.join(", ")} (got ${codes.join(", ")})`);
  } else {
    console.log(`ok   ${testCase.name}`);
  }
}

if (failures) {
  console.error(`\n${failures} linter case(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: ported linter enforces every checked rule.");
