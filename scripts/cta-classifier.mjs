// Shared CTA + candidacy-anchor classification for outreach copy.
//
// Used by review-cold-email-spec.mjs (lint gate) and
// export-spec-to-apps-script-queue.mjs (writes cta_type= into the notes
// column so generate-analytics.mjs can roll up reply rate by CTA shape).
//
// Background: emails whose only question is a curiosity question ("How much
// of week one is X versus Y?") with no explicit candidacy statement produce
// confused replies ("I'm not sure what you're asking"). The reviewer treats
// that combination as an error; this module is the single source of truth
// for what counts as a decision-shaped CTA versus a curiosity CTA, and what
// counts as an explicit candidacy anchor.

export function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Explicit candidacy / intent anchors. At least one of these (or a
// decision-shaped CTA) must appear in every first-touch email so the
// recipient can decode WHY they are being contacted.
const INTENT_PATTERNS = [
  /\bbefore i apply\b/i,
  /\bapply(?:ing)? (?:for|to)\b/i,
  /\bi (?:recently |just )?applied\b/i,
  /\btargeting (?:the|this)\b/i,
  /\breq\s*#?\s*\d{3,}\b/i,
  /\b(?:right|first|sensible|useful)\s+(?:\w+\s+)?ask for\b/i,
  /\brouting ask\b/i,
  /\bask (?:about|you about) the\b/i,
  /\bpeer to ask about\b/i,
  /\blook at my background\b/i,
  /\bmy (?:background|application|resume|candidacy) (?:for|to|is worth)\b/i,
  /\bworth a screen\b/i,
  /\bsend (?:my|the|you my) resume\b/i,
  /\bcandidate for\b/i,
  /\binterested in the\b.{0,60}\b(?:role|opening|req|position|posting)\b/i,
];

// Decision-shaped CTA patterns, grouped by type. These carry implicit
// candidacy (a routing/fit/scheduling ask only makes sense from a candidate)
// so they satisfy the explicit-ask requirement on their own.
const CTA_TYPES = [
  {
    type: "routing",
    patterns: [
      /\bwho (?:owns|usually screens|screens|screened|routes|should i reference|is the (?:right|better|closer))\b/i,
      /\bwho'?s the (?:right|better|closer|best)\b/i,
      /\bappreciate (?:the|a) (?:pointer|name)\b/i,
      /\bpointer would help\b/i,
      /\bright (?:person|team|contact) to (?:ask|target|watch|reach)\b/i,
      /\bbetter (?:person|contact|team|routing|peer)\b/i,
      /\bpoint me (?:to|toward)\b/i,
      /\bwho owns\b/i,
      /\bwho (?:on the|should i ask|in engineering)\b/i,
      /\bis this (?:req|role|the right req) on your\b/i,
    ],
  },
  {
    type: "fit",
    patterns: [
      /\bdoes this align\b/i,
      /\balign with what your team\b/i,
      /\bworth a (?:screen|look|short look)\b/i,
      /\bopen to a brief look\b/i,
      /\bbe open to a (?:brief|quick|short) look\b/i,
      /\broute my application\b/i,
      /\bshould i (?:stay with|target|route)\b/i,
      /\bright (?:entry point|team to target)\b/i,
      /\bif you were in my shoes\b/i,
    ],
  },
  {
    type: "scheduling",
    patterns: [
      /\bwould a .{0,50}(?:chat|call|conversation)\b.{0,40}make sense\b/i,
      /\bopen to (?:a )?(?:brief|quick|short|15)[- ]?(?:minute)? ?(?:chat|call|conversation)\b/i,
      /\bmake sense to (?:connect|chat|talk)\b/i,
    ],
  },
  {
    type: "curiosity",
    patterns: [
      /\bhow much of (?:your|the|a|week one|your team'?s)\b/i,
      /\bweek one\b/i,
      /\bday[- ]to[- ]day\b/i,
      /\bwhat (?:is|does) (?:one|a typical)\b/i,
      /\bwhat interview format\b/i,
      /\bversus\b/i,
    ],
  },
];

export function hasCandidacyAnchor(text) {
  return INTENT_PATTERNS.some((re) => re.test(text));
}

// Pull the LAST question sentence from plain text — the effective CTA.
export function lastQuestion(text) {
  const sentences = String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    if (sentences[i].endsWith("?")) return sentences[i];
  }
  return "";
}

// Classify the email's CTA. Decision types (routing/fit/scheduling) are
// checked before curiosity so a mixed question classifies as the stronger
// shape. Returns { type, question } where type is one of:
//   routing | fit | scheduling | curiosity | other | none
export function classifyCta(text) {
  const question = lastQuestion(text);
  if (!question) return { type: "none", question: "" };
  for (const { type, patterns } of CTA_TYPES) {
    if (patterns.some((re) => re.test(question))) {
      return { type, question };
    }
  }
  return { type: "other", question };
}

// Full explicit-ask evaluation for one email body (plain text).
// An email passes when it has a candidacy anchor OR a decision-shaped CTA.
export function evaluateExplicitAsk(text) {
  const anchor = hasCandidacyAnchor(text);
  const cta = classifyCta(text);
  const decisionCta = ["routing", "fit", "scheduling"].includes(cta.type);
  return {
    candidacyAnchor: anchor,
    ctaType: cta.type,
    ctaQuestion: cta.question,
    pass: anchor || decisionCta,
  };
}
