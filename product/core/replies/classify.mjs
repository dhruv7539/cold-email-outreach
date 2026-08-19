// Reply classification, ported from scripts/classify-replies.mjs.
//
// One deliberate change from the CLI: unsubscribe / do-not-contact language is
// pulled out of the "not_interested" bucket into its own "unsubscribe"
// classification. In the CLI a human read every reply, so an opt-out was handled
// by eye. In the product nobody is watching, so an opt-out has to be a distinct,
// machine-actionable outcome that suppresses the address. Honoring it is both
// the law (CAN-SPAM) and basic decency.

const UNSUBSCRIBE_RULES = [
  { pattern: /\bplease (remove|unsubscribe|take me off)\b/, weight: 5 },
  { pattern: /\b(remove|take) me (off|from)\b/, weight: 5 },
  { pattern: /\bunsubscribe\b/, weight: 5 },
  { pattern: /\bdo not (contact|email|reach out|message)\b/, weight: 5 },
  { pattern: /\bstop (emailing|contacting|messaging) me\b/, weight: 5 },
  { pattern: /\bopt(ed)? out\b/, weight: 4 },
  { pattern: /\bno longer wish to\b/, weight: 3 },
];

const CLASSIFIER_RULES = {
  positive: [
    { pattern: /\bhappy to (chat|connect|talk|help)\b/, weight: 4 },
    { pattern: /\blet'?s (chat|connect|set up|schedule|talk)\b/, weight: 4 },
    { pattern: /\b(are|is) you available\b/, weight: 3 },
    { pattern: /\bsend (me )?your (resume|cv)\b/, weight: 5 },
    { pattern: /\bwould love to\b/, weight: 3 },
    { pattern: /\bgreat (background|fit|profile)\b/, weight: 3 },
    { pattern: /\bschedule (a|some) time\b/, weight: 4 },
    { pattern: /\bset up (a|some) (call|time|chat)\b/, weight: 4 },
  ],
  referral: [
    { pattern: /\b(reach out to|connect with|talk to|speak with)\b/, weight: 3 },
    { pattern: /\b(forwarded|passing|passed) (this|it|you) (along|on|to)\b/, weight: 4 },
    { pattern: /\bthe right person (is|would be)\b/, weight: 4 },
    { pattern: /\bloop(ing|ed) in\b/, weight: 3 },
    { pattern: /\bmy colleague\b/, weight: 2 },
  ],
  confused: [
    { pattern: /\bnot sure what you('| a)?re asking\b/, weight: 5 },
    { pattern: /\bwhat (exactly )?are you asking\b/, weight: 5 },
    { pattern: /\bi don'?t understand (what|your|the)\b/, weight: 4 },
    { pattern: /\bcan you clarify\b/, weight: 4 },
    { pattern: /\bwhat is this (about|regarding|in reference to)\b/, weight: 4 },
    { pattern: /\bwhat role (are you|is this)\b/, weight: 3 },
  ],
  not_interested: [
    { pattern: /\b(no|not) (currently |right now )?(hiring|open roles|openings|open positions)\b/, weight: 4 },
    { pattern: /\b(role|position|req) (has been |is )?(filled|closed)\b/, weight: 4 },
    { pattern: /\bunfortunately (we|i)\b/, weight: 2 },
    { pattern: /\bnot (the right|a good) fit\b/, weight: 4 },
    { pattern: /\bnot (interested|looking|hiring)\b/, weight: 3 },
    { pattern: /\bwon'?t be able to\b/, weight: 2 },
    { pattern: /\bcan'?t help\b/, weight: 2 },
  ],
  auto_reply: [
    { pattern: /\bout of (the )?office\b/, weight: 5 },
    { pattern: /\b(automatic|auto)[- ]?(reply|response)\b/, weight: 5 },
    { pattern: /\bon (leave|vacation|holiday|pto)\b/, weight: 4 },
    { pattern: /\bwill (be )?(back|return)(ing)? on\b/, weight: 3 },
  ],
};

/**
 * @param {string} text
 * @returns {{ classification: string, confidence: number, reasons: string[], actsAsUnsubscribe: boolean }}
 */
export function classifyReply(text) {
  const body = String(text || "").toLowerCase();
  if (!body.trim()) {
    return { classification: "unclear", confidence: 0, reasons: ["empty body"], actsAsUnsubscribe: false };
  }

  // Unsubscribe wins outright when present: it is the one classification with a
  // legal obligation attached, so a borderline score must not let another
  // category outrank it.
  if (UNSUBSCRIBE_RULES.some((rule) => rule.pattern.test(body))) {
    return { classification: "unsubscribe", confidence: 0.95, reasons: ["explicit opt-out language"], actsAsUnsubscribe: true };
  }

  const scores = {};
  const reasons = {};
  for (const [label, rules] of Object.entries(CLASSIFIER_RULES)) {
    let total = 0;
    const hits = [];
    for (const rule of rules) {
      if (rule.pattern.test(body)) {
        total += rule.weight;
        hits.push(rule.pattern.source.slice(0, 60));
      }
    }
    if (total > 0) {
      scores[label] = total;
      reasons[label] = hits;
    }
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return { classification: "unclear", confidence: 0, reasons: ["no rule matched"], actsAsUnsubscribe: false };
  }

  const [topLabel, topScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;
  const confidence = Math.min(1, (topScore - secondScore) / 5 + 0.3);

  return {
    classification: topLabel,
    confidence: Number(confidence.toFixed(2)),
    reasons: reasons[topLabel] || [],
    actsAsUnsubscribe: false,
  };
}

/** Classifications that should cancel any pending follow-up to this person. */
export function shouldStopSequence(classification) {
  return ["unsubscribe", "positive", "referral", "not_interested"].includes(classification);
}
