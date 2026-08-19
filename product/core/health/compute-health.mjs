// Deliverability health, adapted from scripts/outreach-health.mjs. Instead of
// reading a Google Sheet it computes over the send/reply/bounce events the
// product already stores. Thresholds are unchanged: the 2% trailing bounce rate
// is the hard gate that pauses queueing, because sending from a burned sender
// reputation makes every future email worse.

export const BOUNCE_WINDOW = 100;
export const BOUNCE_ALERT_PCT = 2;
export const REPLY_WINDOW = 200;
export const REPLY_WARN_PCT = 5;
export const REPLY_MATURITY_DAYS = 3;

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {{ status?: string, main_sent_at?: string|Date|null, reply_detected_at?: string|Date|null }[]} items
 */
export function computeHealth(items = []) {
  // Only items that actually went out count toward rates.
  const sent = items
    .filter((it) => toTime(it.main_sent_at))
    .sort((a, b) => toTime(a.main_sent_at) - toTime(b.main_sent_at));

  const alerts = [];
  const warnings = [];

  // Trailing bounce rate over the most recent BOUNCE_WINDOW sends.
  const bounceSlice = sent.slice(-BOUNCE_WINDOW);
  const bounces = bounceSlice.filter((it) => it.status === "bounced").length;
  const bouncePct = bounceSlice.length
    ? Number(((bounces / bounceSlice.length) * 100).toFixed(2))
    : 0;

  if (bounceSlice.length >= 20 && bouncePct > BOUNCE_ALERT_PCT) {
    alerts.push(
      `Trailing bounce rate is ${bouncePct}% over the last ${bounceSlice.length} sends (limit ${BOUNCE_ALERT_PCT}%). Queueing is paused until it drops.`
    );
  }

  // Trailing reply rate over the most recent REPLY_WINDOW mature sends (old
  // enough that a reply would plausibly have arrived).
  const now = Date.now();
  const matureCutoff = now - REPLY_MATURITY_DAYS * 86400000;
  const mature = sent.filter((it) => toTime(it.main_sent_at) <= matureCutoff);
  const replySlice = mature.slice(-REPLY_WINDOW);
  const replies = replySlice.filter(
    (it) => it.status === "replied" || toTime(it.reply_detected_at)
  ).length;
  const replyPct = replySlice.length
    ? Number(((replies / replySlice.length) * 100).toFixed(2))
    : 0;

  if (replySlice.length >= 40 && replyPct < REPLY_WARN_PCT) {
    warnings.push(
      `Trailing reply rate is ${replyPct}% over the last ${replySlice.length} mature sends (below ${REPLY_WARN_PCT}%). Review copy and targeting.`
    );
  }

  const status = alerts.length ? "alert" : warnings.length ? "warning" : "ok";

  return {
    status,
    alerts,
    warnings,
    trailing_bounce_pct: bouncePct,
    trailing_bounce_window: bounceSlice.length,
    trailing_reply_pct: replyPct,
    trailing_reply_window: replySlice.length,
  };
}

export function blocksSending(health) {
  return Boolean(health && health.status === "alert");
}
