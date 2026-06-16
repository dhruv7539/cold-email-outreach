#!/usr/bin/env node

import { loadSpec } from "./gmail-api.mjs";
import { evaluateExplicitAsk } from "./cta-classifier.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitParagraphs(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .split(/\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function wordCount(value) {
  const text = stripHtml(value);
  return text ? text.split(/\s+/).length : 0;
}

// Em dashes (—) read AI-polished in short cold emails. Prefer commas,
// periods, or two short sentences. Applies to outbound HTML only.
const EM_DASH_PATTERN = /—|&mdash;|&#8212;/;

function lintHumanVoice(html, label = "email") {
  const findings = [];
  if (EM_DASH_PATTERN.test(String(html || ""))) {
    findings.push({
      severity: "error",
      code: "em_dash",
      message: `${label}: no em dashes (—). Use a comma, period, or two short sentences. Write like a person, not an essay.`,
    });
  }
  return findings;
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.regex.test(text));
}

const BANNED_PATTERNS = [
  {
    severity: "error",
    code: "hedge_directionally_relevant",
    regex: /\bdirectionally relevant\b/i,
    message: "Avoid 'directionally relevant'; use a clearer ask.",
  },
  {
    severity: "warning",
    code: "generic_background_strongest",
    regex: /\bmy background is strongest in\b/i,
    message: "Replace generic skills-list phrasing with one concrete proof line.",
  },
  {
    severity: "warning",
    code: "generic_closest_match",
    regex: /\bmy closest match is\b/i,
    message: "Replace 'my closest match is' with a specific accomplishment.",
  },
  {
    severity: "warning",
    code: "self_focused_goal",
    regex: /\bthe kind of work i want to keep doing\b/i,
    message: "Avoid framing around your goals instead of the team's problem.",
  },
  {
    severity: "warning",
    code: "generic_praise",
    regex: /\byour background stood out to me\b/i,
    message: "Use a concrete person-specific trigger instead of generic praise.",
  },
  {
    severity: "warning",
    code: "background_relevant_question",
    regex: /\bwould my background be (?:worth considering|relevant)\b/i,
    message: "Use a firmer ask like 'Does this align with what your team is looking for?'",
  },
];

// Openers that lead with the sender / the role / the application instead of a
// person-specific trigger. Combined with a "no second-person reference" check
// below to flag weak, role-generic first sentences before export.
const GENERIC_OPENER_PATTERNS = [
  /^i'?\s*a?m\b/i, // "I'm a ...", "I am a ..."
  /^i (?:came across|saw|noticed|found|spotted)\b.*\b(role|position|opening|posting|req|job|listing)\b/i,
  /^i'?m (?:reaching out|writing)\b/i,
  /^i'?m (?:finishing|completing|wrapping up|about to finish) my\b/i,
  /^i (?:recently )?applied\b/i,
  /^i wanted to (?:reach out|introduce|share)\b/i,
];

// Phrases that mark a follow-up as a content-free "just checking in" bump —
// exactly what the playbook warns against. A follow-up should add a NEW angle.
const GENERIC_FOLLOWUP_PATTERNS = [
  /\bjust checking in\b/i,
  /\bwanted to follow up on my earlier note\b/i,
  /\bin case (?:it|my note) got buried\b/i,
  /\bcircling back\b/i,
  /\bbumping this\b/i,
  /\bfollowing up again\b/i,
  /\bany update\b/i,
  /\bdid you (?:get|see) my (?:last )?(?:note|email|message)\b/i,
];

const METRIC_PATTERNS = [
  // No trailing \b: `%` is itself a non-word char, so `%\b` only matches when a
  // word char immediately follows — which never happens in prose ("80% of",
  // "40%."). Drop it so end-of-clause percentages are detected.
  /\b\d+(?:\.\d+)?%/i,
  /\b\d+(?:\.\d+)?x\b/i,
  /\bp(?:95|99)\b/i,
  /\b\d[\d,]*\+?\s*(?:records|tokens|data points|ops\/sec|ops|releases|tests|modules|clients|daus)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:ms|min|minutes|sec|seconds)\b/i,
  /\bPR\s*#?\d+\b/i,
  /\bv1\.\d+\b/i,
];

const ARTIFACT_PATTERNS = [
  /\bkubernetes\b/i,
  /\bworld bank\b/i,
  /\bgates foundation\b/i,
  /\bieee\b/i,
  /\bcalhacks\b/i,
  /\braft\b/i,
  /@liggitt/i,
];

const TECH_TERM_PATTERNS = [
  /\baws\b/i,
  /\breact\b/i,
  /\btypescript\b/i,
  /\bpython\b/i,
  /\bdjango\b/i,
  /\bpostgres(?:ql)?\b/i,
  /\bnode(?:\.js)?\b/i,
  /\bkafka\b/i,
  /\bredis\b/i,
  /\bkubernetes\b/i,
  /\bgraphql\b/i,
  /\bflask\b/i,
  /\bgo\b/i,
];

function hasConcreteProof(text) {
  return matchesAny(text, METRIC_PATTERNS.map((regex) => ({ regex }))) ||
    matchesAny(text, ARTIFACT_PATTERNS.map((regex) => ({ regex })));
}

// Extract normalized proof tokens (the actual metric strings) so the spec-
// level pass can flag the same proof line being reused across most drafts —
// a structural fingerprint that reads as mass outreach.
function extractProofTokens(text) {
  const tokens = new Set();
  for (const re of METRIC_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    for (const match of text.matchAll(global)) {
      tokens.add(match[0].toLowerCase().replace(/[\s,]+/g, ""));
    }
  }
  return tokens;
}

function countTechTerms(text) {
  return TECH_TERM_PATTERNS.reduce((count, regex) => (regex.test(text) ? count + 1 : count), 0);
}

// Pull the first body sentence — the actual opener — skipping the "Hi Name,"
// greeting paragraph. This is what we inspect for a person-specific trigger.
function firstBodySentence(paragraphs) {
  const body = paragraphs.filter((p) => !/^(hi|hello|hey|dear)\b/i.test(p));
  const para = body[0] || "";
  const sentence = para.split(/(?<=[.!?])\s+/)[0] || para;
  return sentence.trim();
}

// A person-specific opener references THEM (their work, team, or "you/your"),
// not just the sender or the role. Used to flag generic openers.
function hasPersonSpecificOpener(sentence) {
  return /\byou(?:r|'re|'ve|rself)?\b/i.test(sentence) ||
    /\byour team\b/i.test(sentence) ||
    /\b(?:github|repo|talk|blog post|paper|commit|pull request|pr)\b/i.test(sentence);
}

// Lint an authored follow-up. Returns findings prefixed with the sequence
// label. When the follow-up is absent (and not explicitly disabled), warns
// that the generic template will ship instead of an authored, new-angle note.
function reviewFollowUp(draft, sequenceNumber, mainText) {
  const field = sequenceNumber === 1 ? "followUp1Html" : "followUp2Html";
  const disabled =
    (sequenceNumber === 1 && draft.disableFollowUp1 === true) ||
    (sequenceNumber === 2 &&
      (draft.disableFollowUp2 === true || draft.followUpCount === 1));
  const html = typeof draft[field] === "string" ? draft[field].trim() : "";
  const label = `follow-up ${sequenceNumber}`;
  const findings = [];

  if (!html) {
    if (!disabled) {
      findings.push({
        severity: "error",
        code: `followup${sequenceNumber}_not_authored`,
        message: `${label}: not authored. Authored follow-ups are required (the exporter no longer generates a generic fallback). Author ${field} with a new angle, or disable this step explicitly.`,
      });
    }
    return findings;
  }

  const text = stripHtml(html);
  const words = wordCount(html);

  if (words > 90) {
    findings.push({
      severity: "warning",
      code: `followup${sequenceNumber}_too_long`,
      message: `${label}: ${words} words; keep follow-ups under ~80 words.`,
    });
  }

  if (matchesAny(text, GENERIC_FOLLOWUP_PATTERNS.map((regex) => ({ regex })))) {
    findings.push({
      severity: "error",
      code: `followup${sequenceNumber}_generic_bump`,
      message: `${label}: reads as a content-free "just checking in" bump. Add a new proof angle or role mapping.`,
    });
  }

  if (mainText && text && text === mainText) {
    findings.push({
      severity: "error",
      code: `followup${sequenceNumber}_identical_to_main`,
      message: `${label}: identical to the main email. It must add something new.`,
    });
  }

  // Follow-up 1 should carry a fresh, concrete angle (a new proof/metric).
  if (sequenceNumber === 1 && !hasConcreteProof(text)) {
    findings.push({
      severity: "warning",
      code: "followup1_no_new_angle",
      message:
        "follow-up 1: no concrete metric/artifact; lead with a NEW proof angle, not a restatement.",
    });
  }

  findings.push(...lintHumanVoice(html, label));

  return findings;
}

function reviewDraft(draft) {
  const text = stripHtml(draft.html || "");
  const paragraphs = splitParagraphs(draft.html || "");
  const findings = [];
  const words = wordCount(draft.html || "");
  const concreteProof = hasConcreteProof(text);
  const techTermCount = countTechTerms(text);
  const hasQuestion = /\?/.test(text);
  const hasPullLine = /\b(happy to share|happy to send|if helpful,? i['’]m happy to)\b/i.test(text);
  const explicitAsk = evaluateExplicitAsk(text);

  findings.push(...lintHumanVoice(draft.html || "", "main email"));

  if (words > 120) {
    findings.push({
      severity: "warning",
      code: "too_long",
      message: `Email is ${words} words; keep first touch closer to 50-90 words.`,
    });
  }

  if (!concreteProof) {
    findings.push({
      severity: "error",
      code: "missing_concrete_proof",
      message: "Missing a concrete metric or verifiable artifact in the proof line.",
    });
  }

  if (!hasQuestion) {
    findings.push({
      severity: "warning",
      code: "missing_micro_ask",
      message: "Email does not end with a clear low-friction ask.",
    });
  }

  // Explicit-ask gate (the Sankhesh failure mode): an email whose only
  // question is a curiosity question and which never states candidacy leaves
  // the recipient unable to decode what is being asked of them. Require a
  // candidacy anchor ("before I apply...", "the right first ask for the X
  // opening", req #) OR a decision-shaped CTA (routing / fit / scheduling).
  if (!explicitAsk.pass) {
    findings.push({
      severity: "error",
      code: "missing_explicit_ask",
      message: `No explicit candidacy statement and CTA is ${explicitAsk.ctaType}${
        explicitAsk.ctaQuestion ? ` ("${explicitAsk.ctaQuestion}")` : ""
      }. State that you're a candidate (e.g. "before I apply", name the opening as YOUR target) or use a routing/fit/scheduling ask.`,
    });
  }

  // Excessive bolding is a visual spam cue and part of the structural
  // fingerprint. Keep at most 2 <strong> spans in a first-touch email.
  const strongCount = (String(draft.html || "").match(/<strong>/gi) || []).length;
  if (strongCount > 2) {
    findings.push({
      severity: "warning",
      code: "excessive_bolding",
      message: `${strongCount} <strong> spans; cap bolding at 2 per email (one metric, max).`,
    });
  }

  if (techTermCount >= 4 && !concreteProof) {
    findings.push({
      severity: "warning",
      code: "likely_stack_list",
      message: "Looks like a generic technology list rather than a proof-driven sentence.",
    });
  }

  if (paragraphs.length > 1 && /i(?:'|’)m finishing my ms in cs at usc/i.test(paragraphs[1] || "") && !concreteProof) {
    findings.push({
      severity: "warning",
      code: "generic_middle_paragraph",
      message: "Middle paragraph anchors on degree but not on a concrete accomplishment.",
    });
  }

  // Generic-opener check: a strong cold email opens on a person-specific
  // trigger (their work / team / a GitHub signal), not "I'm a..." or "I came
  // across the role." Flag when sentence 1 matches a generic opener AND has no
  // second-person / person-specific reference.
  const opener = firstBodySentence(paragraphs);
  const openerIsGeneric =
    matchesAny(opener.toLowerCase(), GENERIC_OPENER_PATTERNS.map((regex) => ({ regex })));
  if (opener && openerIsGeneric && !hasPersonSpecificOpener(opener)) {
    findings.push({
      severity: "warning",
      code: "generic_opener",
      message:
        "Sentence 1 opens on you/the role, not a person-specific trigger. Lead with their work, team, or a GitHub signal (see CONTACT_RESEARCH_BRIEF_TEMPLATE.md `trigger`).",
    });
  }

  // Templated title-trigger: "Your <title> seat/path aligned with <X> in the
  // <Y> JD" is a mail-merge construction, not genuine personalization. It
  // reads grammatically off and contributed to confused replies.
  if (
    /^your\b.{0,70}\b(?:seat|path|tenure|title|role)\b.{0,90}\b(?:aligned|matched|lined up)\b/i.test(
      opener
    )
  ) {
    findings.push({
      severity: "warning",
      code: "templated_title_trigger",
      message:
        'Opener is a templated "Your <title> seat aligned with..." construction. Rewrite as a natural sentence about something they actually did or own.',
    });
  }

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.regex.test(text)) {
      findings.push({
        severity: pattern.severity,
        code: pattern.code,
        message: pattern.message,
      });
    }
  }

  findings.push(...reviewFollowUp(draft, 1, text));
  findings.push(...reviewFollowUp(draft, 2, text));

  const followUp1Authored =
    typeof draft.followUp1Html === "string" && draft.followUp1Html.trim() !== "";
  const followUp2Authored =
    typeof draft.followUp2Html === "string" && draft.followUp2Html.trim() !== "";

  return {
    key: draft.key || draft.contactName || draft.to,
    to: draft.to,
    subject: draft.subject,
    wordCount: words,
    hasConcreteProof: concreteProof,
    hasQuestion,
    hasPullLine,
    ctaType: explicitAsk.ctaType,
    candidacyAnchor: explicitAsk.candidacyAnchor,
    followUp1Authored,
    followUp2Authored,
    findingCount: findings.length,
    findings,
  };
}

function summarize(results, specFindings = []) {
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === "error") {
        errors += 1;
      } else {
        warnings += 1;
      }
    }
  }
  for (const finding of specFindings) {
    if (finding.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

// Spec-level checks that only make sense across the whole campaign:
//  - proof-line reuse: the same metric token in most drafts is a structural
//    fingerprint (everyone at the company comparing notes sees clones).
//  - CTA monoculture: every draft using the same CTA shape compounds it.
function reviewSpecLevel(spec, results) {
  const findings = [];
  const draftCount = spec.drafts.length;
  if (draftCount < 6) return findings;

  const tokenCounts = new Map();
  for (const draft of spec.drafts) {
    const text = stripHtml(draft.html || "");
    for (const token of extractProofTokens(text)) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
  }
  for (const [token, count] of [...tokenCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count / draftCount > 0.5) {
      findings.push({
        severity: "warning",
        code: "proof_token_overused",
        message: `Proof token "${token}" appears in ${count}/${draftCount} drafts. Rotate proof lines — cap any single metric to ~half the campaign.`,
      });
    }
  }

  const ctaCounts = new Map();
  for (const result of results) {
    ctaCounts.set(result.ctaType, (ctaCounts.get(result.ctaType) || 0) + 1);
  }
  for (const [type, count] of ctaCounts.entries()) {
    if (type !== "none" && count === draftCount) {
      findings.push({
        severity: "warning",
        code: "cta_monoculture",
        message: `All ${draftCount} drafts use the "${type}" CTA shape. Rotate at least 2 CTA shapes per campaign.`,
      });
    }
  }

  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args._[0];

  if (!specPath) {
    throw new Error("Usage: node scripts/review-cold-email-spec.mjs <spec-file> [--json] [--strict]");
  }

  const spec = await loadSpec(specPath);
  const results = spec.drafts.map(reviewDraft);
  const specFindings = reviewSpecLevel(spec, results);
  const summary = summarize(results, specFindings);

  if (args.json === "true") {
    console.log(JSON.stringify({ specPath, summary, specFindings, results }, null, 2));
  } else {
    console.log(`Reviewing ${specPath}`);
    console.log(`Errors: ${summary.errors} | Warnings: ${summary.warnings}`);
    for (const result of results) {
      console.log(`\n- ${result.key} -> ${result.to}`);
      console.log(`  subject: ${result.subject}`);
      console.log(`  words: ${result.wordCount} | proof: ${result.hasConcreteProof ? "yes" : "no"} | pull line: ${result.hasPullLine ? "yes" : "no"}`);
      console.log(`  cta: ${result.ctaType} | candidacy anchor: ${result.candidacyAnchor ? "yes" : "no"}`);
      console.log(`  follow-ups authored: f1=${result.followUp1Authored ? "yes" : "no"} f2=${result.followUp2Authored ? "yes" : "no"}`);
      if (result.findings.length === 0) {
        console.log("  pass");
        continue;
      }
      for (const finding of result.findings) {
        console.log(`  ${finding.severity}: ${finding.message}`);
      }
    }
    if (specFindings.length > 0) {
      console.log("\nSpec-level findings:");
      for (const finding of specFindings) {
        console.log(`  ${finding.severity}: ${finding.message}`);
      }
    }
  }

  if (args.strict === "true" && summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
