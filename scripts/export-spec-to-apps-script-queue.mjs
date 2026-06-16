#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { loadSpec } from "./gmail-api.mjs";
import {
  DEFAULT_TIMEZONE,
  resolveTimezoneFromState,
  zonedWallClockToUtc,
  zonedDateParts,
} from "./timezone-map.mjs";
import { classifyCta, stripHtmlToText } from "./cta-classifier.mjs";

// IMPORTANT: This list MUST stay in sync with:
//   - apps-script/threaded-sequencer/Code.gs (OUTREACH_QUEUE_HEADERS)
//   - scripts/config.mjs (OUTREACH_QUEUE_HEADERS)
//   - apps-script/threaded-sequencer/README.md (Queue Columns)
// (Kept inline here rather than importing from ./config.mjs to keep this
// script copy-pastable as a standalone exporter.)
const QUEUE_HEADERS = [
  "job_id",
  "company",
  "contact_name",
  "contact_type",
  "recipient_email",
  "subject",
  "main_html",
  "main_send_at",
  "follow_up_1_html",
  "follow_up_1_send_at",
  "follow_up_2_html",
  "follow_up_2_send_at",
  "attachment_file_id",
  "status",
  "active_step",
  "gmail_thread_id",
  "root_message_id",
  "last_message_id",
  "sender_email",
  "main_sent_at",
  "follow_up_1_sent_at",
  "follow_up_2_sent_at",
  "reply_detected_at",
  "last_sent_at",
  "created_at",
  "updated_at",
  "notes",
  "error",
  "recipient_timezone",
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (!args._) {
        args._ = [];
      }
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

function ensureArg(value, name) {
  if (!value) {
    throw new Error(`Missing required argument ${name}`);
  }
}

function titleCaseFromKey(value) {
  return String(value || "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizedString(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function normalizedLane(value) {
  const lane = normalizedString(value).toLowerCase();
  if (lane === "warm" || lane === "cold") {
    return lane;
  }
  return "";
}

function readNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// --- Business-day calendar helpers (timezone-agnostic {year,month,day}) ---
// We anchor "day d" on a shared calendar date and then stamp each recipient's
// local hour in their own zone, so the absolute send envelope naturally widens
// across timezones. Calendar math uses UTC-noon to avoid DST/boundary edges.
function calToUtcNoon(cal) {
  return new Date(Date.UTC(cal.year, cal.month - 1, cal.day, 12, 0, 0));
}

function utcToCal(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function isWeekendUtc(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function nextBusinessCal(cal) {
  let date = calToUtcNoon(cal);
  while (isWeekendUtc(date)) {
    date = new Date(date.getTime() + 86400000);
  }
  return utcToCal(date);
}

function addBusinessDaysCal(cal, businessDays) {
  let date = calToUtcNoon(cal);
  let remaining = businessDays;
  while (remaining > 0) {
    date = new Date(date.getTime() + 86400000);
    if (!isWeekendUtc(date)) {
      remaining -= 1;
    }
  }
  while (isWeekendUtc(date)) {
    date = new Date(date.getTime() + 86400000);
  }
  return utcToCal(date);
}

// Absolute send instant for a local wall clock of startHour:00 + offsetMin,
// on calendar date `cal`, in `timeZone`.
function localSlot(cal, startHour, offsetMin, timeZone) {
  const base = zonedWallClockToUtc(
    cal.year,
    cal.month,
    cal.day,
    startHour,
    0,
    timeZone
  );
  return new Date(base.getTime() + offsetMin * 60 * 1000);
}

function clampFraction(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Round-robin interleave drafts by recipient email domain so multiple contacts
// at the same company are not queued consecutively.
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

// Load an email(lowercased) -> US state map from an Apollo enrich JSON file.
// Missing/unreadable file resolves to an empty map (callers fall back to the
// default timezone).
async function loadEnrichStateMap(enrichPath) {
  const map = new Map();
  try {
    const raw = await fs.readFile(enrichPath, "utf8");
    const parsed = JSON.parse(raw);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    for (const entry of results) {
      const person = entry?.person ?? entry;
      const email = String(person?.email || "").trim().toLowerCase();
      const state = person?.state;
      if (email && state) map.set(email, state);
    }
  } catch {
    // No enrich file (or malformed) -> default-timezone fallback for all rows.
  }
  return map;
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

// NOTE: the old generateFollowUpHtml() fallback ("Wanted to follow up on my
// earlier note in case it got buried") was removed on purpose. Generic bumps
// produced confused replies; every enabled follow-up must now be authored in
// the spec (followUp1Html / followUp2Html) or explicitly disabled
// (disableFollowUp1 / disableFollowUp2 / followUpCount: 1).

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args._?.[0];
  ensureArg(specPath, "<spec-file>");

  const spec = await loadSpec(specPath);
  const startHour = Number(args["start-hour"] ?? 9);
  const endHour = Number(args["end-hour"] ?? 17);

  // Volume-aware, timezone-aware send distribution.
  //
  // Rather than a fixed inter-send gap, each day's sends are spread evenly
  // across the recipient's LOCAL business window (startHour..endHour in their
  // own zone) with jitter, then converted to an absolute UTC instant. The Apps
  // Script runtime is the real gate -- it re-checks per-recipient business
  // hours and enforces a minimum inter-send spacing -- so these timestamps are
  // "not before" anchors that read as human pacing instead of a blast.
  //
  // --per-day caps how many sends are packed into a single calendar day before
  // spilling to the next business day. --jitter-frac sets the random wobble
  // (fraction of the per-day slot gap). --default-timezone is the fallback when
  // a recipient's state is unknown.
  const perDay = Math.max(1, Math.floor(Number(args["per-day"] ?? 400)));
  const jitterFrac = clampFraction(Number(args["jitter-frac"] ?? 0.35));
  const defaultTimezone =
    normalizedString(args["default-timezone"]) || DEFAULT_TIMEZONE;
  const windowMinutes = Math.max(1, (endHour - startHour) * 60);

  const followUp1Days = Number(args["follow-up-1-days"] ?? 4);
  const followUp2Days = Number(args["follow-up-2-days"] ?? 8);
  const startAt = args["start-at"] ? new Date(args["start-at"]) : new Date();
  const attachmentFileId = args["attachment-file-id"] ?? "";
  const generateFollowUps = args["no-generate-followups"] !== "true";

  if (Number.isNaN(startAt.getTime())) {
    throw new Error("Invalid --start-at value.");
  }

  // Recipient timezone resolution: email -> US state -> IANA zone. Defaults to
  // output/enrich/<slug>.json next to the spec; override with --enrich.
  const enrichPath =
    args.enrich ??
    path.join(
      process.cwd(),
      "output",
      "enrich",
      `${path.basename(specPath).replace(/\.spec\.mjs$/i, "")}.json`
    );
  const stateByEmail = await loadEnrichStateMap(enrichPath);

  const baseCompany =
    args.company ??
    path
      .basename(specPath)
      .replace(/\.spec\.mjs$/i, "")
      .replace(/[-_]+/g, " ");

  const rows = [];
  const nowIso = new Date().toISOString();

  // Shared business-day calendar anchored in the default zone. "Day d" is the
  // same calendar date for everyone; each recipient is stamped at their own
  // local hour within it.
  const startParts = zonedDateParts(startAt, defaultTimezone);
  const baseCal = nextBusinessCal({
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
  });

  // Interleave by domain so same-company contacts are not consecutive.
  const ordered = interleaveByDomain(spec.drafts);
  const total = ordered.length;
  const missingFollowUps = [];

  for (let index = 0; index < total; index += 1) {
    const draft = ordered[index];
    const contactName = normalizedString(draft.contactName) || titleCaseFromKey(draft.key || `contact-${index + 1}`);
    const lane = normalizedLane(draft.lane);
    const disableFollowUp1 = draft.disableFollowUp1 === true;
    const disableFollowUp2 =
      draft.disableFollowUp2 === true ||
      draft.followUpCount === 1 ||
      lane === "warm";
    const defaultFollowUp1Days = lane === "warm" ? 3 : followUp1Days;
    const draftFollowUp1Days = readNumber(draft.followUp1BusinessDays, defaultFollowUp1Days);
    const draftFollowUp2Days = readNumber(draft.followUp2BusinessDays, followUp2Days);

    const timezone =
      resolveTimezoneFromState(
        stateByEmail.get(String(draft.to || "").toLowerCase())
      ) || defaultTimezone;

    // Even per-day distribution sized to the actual daily volume, plus jitter.
    const dayIndex = Math.floor(index / perDay);
    const posInDay = index % perDay;
    const countInDay = Math.min(perDay, total - dayIndex * perDay);
    const slotGap = windowMinutes / countInDay;
    const jitter = (Math.random() * 2 - 1) * slotGap * jitterFrac;
    const offsetMin = Math.max(
      0,
      Math.min(windowMinutes - 1, posInDay * slotGap + jitter)
    );

    const mainCal = addBusinessDaysCal(baseCal, dayIndex);
    const mainSendAt = localSlot(mainCal, startHour, offsetMin, timezone);
    const followUp1SendAt =
      generateFollowUps && !disableFollowUp1
        ? localSlot(
            addBusinessDaysCal(mainCal, draftFollowUp1Days),
            startHour,
            offsetMin,
            timezone
          )
        : null;
    const followUp2SendAt =
      generateFollowUps && !disableFollowUp2
        ? localSlot(
            addBusinessDaysCal(mainCal, draftFollowUp2Days),
            startHour,
            offsetMin,
            timezone
          )
        : null;
    const followUp1Html =
      generateFollowUps && !disableFollowUp1
        ? normalizedString(draft.followUp1Html)
        : "";
    const followUp2Html =
      generateFollowUps && !disableFollowUp2
        ? normalizedString(draft.followUp2Html)
        : "";
    if (generateFollowUps && !disableFollowUp1 && !followUp1Html) {
      missingFollowUps.push(`${draft.key || draft.to}: followUp1Html`);
    }
    if (generateFollowUps && !disableFollowUp2 && !followUp2Html) {
      missingFollowUps.push(`${draft.key || draft.to}: followUp2Html`);
    }
    const subjectVariant = normalizedString(draft.subjectVariant);
    // cta_type / copy_structure tags feed generate-analytics.mjs rollups so
    // reply rate can be compared per CTA shape and per copy scaffold.
    const ctaType =
      normalizedString(draft.ctaType) ||
      classifyCta(stripHtmlToText(draft.html)).type;
    const copyStructure = normalizedString(draft.copyStructure);
    const notes = [
      normalizedString(draft.notes),
      lane ? `${lane}_lane` : "",
      subjectVariant ? `subject_variant=${subjectVariant}` : "",
      ctaType && ctaType !== "none" ? `cta_type=${ctaType}` : "",
      copyStructure ? `copy_structure=${copyStructure}` : "",
      disableFollowUp2 ? "follow_up_count=1" : "follow_up_count=2",
    ]
      .filter(Boolean)
      .join(" | ");

    rows.push({
      job_id: `${Date.now()}-${index + 1}-${draft.key || `job-${index + 1}`}`,
      company: baseCompany,
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
      sender_email: "",
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
      `Refusing to export: ${missingFollowUps.length} enabled follow-up(s) are not authored ` +
        `(generic fallback was removed — author them in the spec or disable the step):\n  ` +
        missingFollowUps.join("\n  ")
    );
  }

  const csvLines = [QUEUE_HEADERS.join(",")];
  for (const row of rows) {
    csvLines.push(QUEUE_HEADERS.map((header) => csvEscape(row[header])).join(","));
  }

  const outputPath =
    args.output ??
    path.join(
      process.cwd(),
      "output",
      "apps-script",
      `${path.basename(specPath).replace(/\.spec\.mjs$/i, "")}.queue.csv`
    );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${csvLines.join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        outputPath,
        rowCount: rows.length,
        company: baseCompany,
        firstMainSendAt: rows[0]?.main_send_at ?? null,
        lastMainSendAt: rows.at(-1)?.main_send_at ?? null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
