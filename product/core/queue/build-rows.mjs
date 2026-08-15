// Builds Queue rows from a spec, ported from
// scripts/export-spec-to-apps-script-queue.mjs. The scheduling math (business-day
// calendar, per-recipient local-window distribution with jitter, domain
// interleave, follow-up offsets) is identical to the CLI exporter. The only
// change: this returns structured row objects instead of writing a CSV, and it
// resolves each recipient's timezone from a passed-in contactMeta map (email ->
// { state }) instead of reading an enrich JSON file from disk.

import {
  DEFAULT_TIMEZONE,
  resolveTimezoneFromState,
  zonedWallClockToUtc,
  zonedDateParts,
} from "../scheduling/timezone-map.mjs";
import { classifyCta, stripHtmlToText } from "../linter/cta-classifier.mjs";

// MUST stay in sync with the Apps Script OUTREACH_QUEUE_HEADERS.
export const QUEUE_HEADERS = [
  "job_id", "company", "contact_name", "contact_type", "recipient_email",
  "subject", "main_html", "main_send_at", "follow_up_1_html", "follow_up_1_send_at",
  "follow_up_2_html", "follow_up_2_send_at", "attachment_file_id", "status",
  "active_step", "gmail_thread_id", "root_message_id", "last_message_id",
  "sender_email", "main_sent_at", "follow_up_1_sent_at", "follow_up_2_sent_at",
  "reply_detected_at", "last_sent_at", "created_at", "updated_at", "notes",
  "error", "recipient_timezone",
];

function normalizedString(value) {
  return String(value ?? "").trim() || "";
}

function normalizedLane(value) {
  const lane = normalizedString(value).toLowerCase();
  return lane === "warm" || lane === "cold" ? lane : "";
}

function readNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function titleCaseFromKey(value) {
  return String(value || "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function calToUtcNoon(cal) {
  return new Date(Date.UTC(cal.year, cal.month - 1, cal.day, 12, 0, 0));
}
function utcToCal(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function isWeekendUtc(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
function nextBusinessCal(cal) {
  let date = calToUtcNoon(cal);
  while (isWeekendUtc(date)) date = new Date(date.getTime() + 86400000);
  return utcToCal(date);
}
function addBusinessDaysCal(cal, businessDays) {
  let date = calToUtcNoon(cal);
  let remaining = businessDays;
  while (remaining > 0) {
    date = new Date(date.getTime() + 86400000);
    if (!isWeekendUtc(date)) remaining -= 1;
  }
  while (isWeekendUtc(date)) date = new Date(date.getTime() + 86400000);
  return utcToCal(date);
}
function localSlot(cal, startHour, offsetMin, timeZone) {
  const base = zonedWallClockToUtc(cal.year, cal.month, cal.day, startHour, 0, timeZone);
  return new Date(base.getTime() + offsetMin * 60 * 1000);
}
function clampFraction(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function interleaveByDomain(drafts) {
  const groups = new Map();
  for (const draft of drafts) {
    const domain = String(draft.to || "").split("@")[1]?.toLowerCase() || "";
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(draft);
  }
  const queues = [...groups.values()];
  const out = [];
  while (out.length < drafts.length) {
    for (const queue of queues) {
      if (queue.length) out.push(queue.shift());
    }
  }
  return out;
}

/**
 * @param {{ drafts: any[] }} spec
 * @param {{
 *   company: string,
 *   senderEmail?: string,
 *   defaultTimezone?: string,
 *   contactMeta?: Map<string, { state?: string }>,
 *   perDay?: number, jitterFrac?: number, startHour?: number, endHour?: number,
 *   followUp1Days?: number, followUp2Days?: number, startAt?: Date,
 *   attachmentFileId?: string,
 * }} options
 */
export function buildQueueRows(spec, options = {}) {
  const {
    company,
    senderEmail = "",
    contactMeta = new Map(),
    attachmentFileId = "",
  } = options;

  const startHour = Number(options.startHour ?? 9);
  const endHour = Number(options.endHour ?? 17);
  const perDay = Math.max(1, Math.floor(Number(options.perDay ?? 400)));
  const jitterFrac = clampFraction(Number(options.jitterFrac ?? 0.35));
  const defaultTimezone = normalizedString(options.defaultTimezone) || DEFAULT_TIMEZONE;
  const windowMinutes = Math.max(1, (endHour - startHour) * 60);
  const followUp1Days = Number(options.followUp1Days ?? 4);
  const followUp2Days = Number(options.followUp2Days ?? 8);
  const startAt = options.startAt instanceof Date ? options.startAt : new Date();

  const nowIso = new Date().toISOString();
  const startParts = zonedDateParts(startAt, defaultTimezone);
  const baseCal = nextBusinessCal({ year: startParts.year, month: startParts.month, day: startParts.day });

  const ordered = interleaveByDomain(spec.drafts || []);
  const total = ordered.length;
  const rows = [];
  const missingFollowUps = [];

  for (let index = 0; index < total; index += 1) {
    const draft = ordered[index];
    const contactName = normalizedString(draft.contactName) || titleCaseFromKey(draft.key || `contact-${index + 1}`);
    const lane = normalizedLane(draft.lane);
    const disableFollowUp1 = draft.disableFollowUp1 === true;
    const disableFollowUp2 =
      draft.disableFollowUp2 === true || draft.followUpCount === 1 || lane === "warm";
    const defaultFollowUp1Days = lane === "warm" ? 3 : followUp1Days;
    const draftFollowUp1Days = readNumber(draft.followUp1BusinessDays, defaultFollowUp1Days);
    const draftFollowUp2Days = readNumber(draft.followUp2BusinessDays, followUp2Days);

    const meta = contactMeta.get(String(draft.to || "").toLowerCase());
    const timezone = resolveTimezoneFromState(meta?.state) || defaultTimezone;

    const dayIndex = Math.floor(index / perDay);
    const posInDay = index % perDay;
    const countInDay = Math.min(perDay, total - dayIndex * perDay);
    const slotGap = windowMinutes / countInDay;
    const jitter = (Math.random() * 2 - 1) * slotGap * jitterFrac;
    const offsetMin = Math.max(0, Math.min(windowMinutes - 1, posInDay * slotGap + jitter));

    const mainCal = addBusinessDaysCal(baseCal, dayIndex);
    const mainSendAt = localSlot(mainCal, startHour, offsetMin, timezone);
    const followUp1SendAt = !disableFollowUp1
      ? localSlot(addBusinessDaysCal(mainCal, draftFollowUp1Days), startHour, offsetMin, timezone)
      : null;
    const followUp2SendAt = !disableFollowUp2
      ? localSlot(addBusinessDaysCal(mainCal, draftFollowUp2Days), startHour, offsetMin, timezone)
      : null;

    const followUp1Html = !disableFollowUp1 ? normalizedString(draft.followUp1Html) : "";
    const followUp2Html = !disableFollowUp2 ? normalizedString(draft.followUp2Html) : "";
    if (!disableFollowUp1 && !followUp1Html) missingFollowUps.push(`${draft.key || draft.to}: followUp1Html`);
    if (!disableFollowUp2 && !followUp2Html) missingFollowUps.push(`${draft.key || draft.to}: followUp2Html`);

    const subjectVariant = normalizedString(draft.subjectVariant);
    const ctaType = normalizedString(draft.ctaType) || classifyCta(stripHtmlToText(draft.html)).type;
    const copyStructure = normalizedString(draft.copyStructure);
    const notes = [
      normalizedString(draft.notes),
      lane ? `${lane}_lane` : "",
      subjectVariant ? `subject_variant=${subjectVariant}` : "",
      ctaType && ctaType !== "none" ? `cta_type=${ctaType}` : "",
      copyStructure ? `copy_structure=${copyStructure}` : "",
      disableFollowUp2 ? "follow_up_count=1" : "follow_up_count=2",
    ].filter(Boolean).join(" | ");

    rows.push({
      job_id: `${Date.now()}-${index + 1}-${draft.key || `job-${index + 1}`}`,
      company,
      contact_name: contactName,
      contact_type: normalizedString(draft.contactType),
      recipient_email: draft.to,
      subject: draft.subject,
      main_html: String(draft.html || "").trim(),
      main_send_at: mainSendAt.toISOString(),
      follow_up_1_html: followUp1Html,
      follow_up_1_send_at: followUp1SendAt ? followUp1SendAt.toISOString() : "",
      follow_up_2_html: followUp2Html,
      follow_up_2_send_at: followUp2SendAt ? followUp2SendAt.toISOString() : "",
      attachment_file_id: attachmentFileId,
      status: "queued",
      active_step: "main",
      gmail_thread_id: "",
      root_message_id: "",
      last_message_id: "",
      sender_email: senderEmail,
      main_sent_at: "",
      follow_up_1_sent_at: "",
      follow_up_2_sent_at: "",
      reply_detected_at: "",
      last_sent_at: "",
      created_at: nowIso,
      updated_at: nowIso,
      notes,
      error: "",
      recipient_timezone: timezone,
    });
  }

  if (missingFollowUps.length > 0) {
    throw new Error(
      `Refusing to build queue: ${missingFollowUps.length} enabled follow-up(s) are not authored:\n  ` +
        missingFollowUps.join("\n  ")
    );
  }

  return { rows, headers: QUEUE_HEADERS };
}
