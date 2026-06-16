#!/usr/bin/env node
/**
 * Reschedule overdue follow-ups in the Queue sheet.
 *
 * Rules:
 *   - Target ~APPLY_DAILY_CAP sends/day spread across BUSINESS_DAYS business days
 *   - For each recipient, fu2_send_at must be >= fu1_send_at + FU_GAP_DAYS days
 *   - Sends are given a random time within BUSINESS_HOURS_LOCAL
 *   - Skips weekends (Sat/Sun)
 *
 * Usage:
 *   node scripts/reschedule-overdue-followups.mjs            # dry run, prints diff
 *   node scripts/reschedule-overdue-followups.mjs --apply    # actually update the sheet
 */

import {
  batchUpdateSheetValues,
  getSheetValues,
  getSheetsAccessToken,
} from "./sheets-api.mjs";
import { getOutreachSpreadsheetId } from "./config.mjs";

const TERMINAL = new Set(["completed", "replied", "bounced", "failed"]);

const APPLY_DAILY_CAP = 200; // max new sends per day
const BUSINESS_DAYS = 3; // spread across this many business days starting tomorrow
const FU_GAP_DAYS = 4; // minimum days between fu1 and fu2 for the same recipient

// Business hours are anchored to a fixed timezone so the same script produces
// the same schedule whether you run it on your laptop, a CI box, or a server
// in another region. Must match Settings!timezone in the sheet.
const BUSINESS_TIMEZONE = "America/Los_Angeles";
const BUSINESS_HOUR_START = 9; // 9 AM in BUSINESS_TIMEZONE
const BUSINESS_HOUR_END = 17; // 5 PM in BUSINESS_TIMEZONE

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

// Returns { year, month, day, weekday } for a given Date, expressed in
// BUSINESS_TIMEZONE. weekday is 1..7 (Mon..Sun) to match Apps Script's
// Utilities.formatDate("u") format.
function partsInBusinessTz(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] || 0,
  };
}

function isWeekendInBusinessTz(date) {
  const { weekday } = partsInBusinessTz(date);
  return weekday === 6 || weekday === 7;
}

// Returns midnight (00:00) of the given Date interpreted in BUSINESS_TIMEZONE,
// as a UTC epoch ms timestamp. Adding 24h * N gets the same wall-clock
// midnight on day N (modulo daylight-savings shifts).
function startOfBusinessDay(date) {
  const { year, month, day } = partsInBusinessTz(date);
  return zonedDateTimeToUtc(year, month, day, 0, 0);
}

// Convert a zoned wall-clock time (year/month/day/hour/minute in
// BUSINESS_TIMEZONE) to a UTC epoch ms timestamp. Works around the fact that
// JS Date has no built-in timezone-aware constructor: we form a candidate UTC
// time, measure the offset BUSINESS_TIMEZONE has at that instant, and
// subtract the offset to land on the right wall-clock time.
function zonedDateTimeToUtc(year, month, day, hour, minute) {
  const candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetMin = tzOffsetMinutes(BUSINESS_TIMEZONE, candidate);
  return candidate - offsetMin * 60 * 1000;
}

function tzOffsetMinutes(timeZone, utcMs) {
  const date = new Date(utcMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - utcMs) / 60000);
}

function nextBusinessDaysFromTomorrow(count) {
  const out = [];
  // "Tomorrow in BUSINESS_TIMEZONE" can differ from machine-local "tomorrow"
  // when the script runs at night near the timezone boundary.
  const tomorrowMidnight = startOfBusinessDay(new Date(Date.now() + 24 * 3600 * 1000));
  let cursor = tomorrowMidnight;
  while (out.length < count) {
    if (!isWeekendInBusinessTz(new Date(cursor))) {
      out.push(cursor);
    }
    cursor += 24 * 3600 * 1000;
  }
  return out;
}

// Returns a UTC epoch ms timestamp for a random wall-clock minute within
// [BUSINESS_HOUR_START, BUSINESS_HOUR_END) on the given day.
function randomBusinessTimeOnDay(dayMidnightUtcMs) {
  const { year, month, day } = partsInBusinessTz(new Date(dayMidnightUtcMs));
  const startMinutes = BUSINESS_HOUR_START * 60;
  const endMinutes = BUSINESS_HOUR_END * 60;
  const minuteOfDay = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));
  return zonedDateTimeToUtc(year, month, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
}

function addBusinessDays(dayMidnightUtcMs, days) {
  // Walk forward `days` calendar days, skipping weekends in BUSINESS_TIMEZONE.
  let cursor = dayMidnightUtcMs;
  let advanced = 0;
  while (advanced < days) {
    cursor += 24 * 3600 * 1000;
    if (!isWeekendInBusinessTz(new Date(cursor))) {
      advanced += 1;
    }
  }
  return cursor;
}

function toIso(utcMs) {
  return new Date(utcMs).toISOString();
}

function dayLabel(utcMs) {
  const { year, month, day, weekday } = partsInBusinessTz(new Date(utcMs));
  const wnames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `${wnames[weekday]} ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function main() {
  const { apply } = parseArgs(process.argv);
  const { accessToken } = await getSheetsAccessToken();
  const resp = await getSheetValues(accessToken, getOutreachSpreadsheetId(), "Queue!A1:AC10000");
  const rows = resp.values || [];
  if (rows.length < 2) {
    console.log("Queue is empty.");
    return;
  }

  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const required = [
    "status",
    "main_sent_at",
    "follow_up_1_send_at",
    "follow_up_1_sent_at",
    "follow_up_2_send_at",
    "follow_up_2_sent_at",
    "recipient_email",
    "updated_at",
    "notes",
  ];
  for (const col of required) {
    if (idx[col] === undefined) {
      throw new Error(`Missing expected column: ${col}`);
    }
  }

  const now = new Date();

  // Classify overdue rows
  const overdueFu1Rows = []; // { rowIdx, sheetRow, row }
  const overdueFu2Rows = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const status = String(r[idx.status] || "").trim();
    if (TERMINAL.has(status)) continue;

    const mainSentAt = r[idx.main_sent_at];
    const fu1SentAt = r[idx.follow_up_1_sent_at];
    const fu1Sched = r[idx.follow_up_1_send_at];
    const fu2SentAt = r[idx.follow_up_2_sent_at];
    const fu2Sched = r[idx.follow_up_2_send_at];

    // fu1 overdue (main sent, fu1 not sent, fu1 scheduled in the past)
    if (mainSentAt && !fu1SentAt && fu1Sched) {
      const sched = new Date(fu1Sched);
      if (!Number.isNaN(sched.getTime()) && sched < now) {
        overdueFu1Rows.push({ rowIdx: i, sheetRow: i + 1, row: r });
        continue;
      }
    }

    // fu2 overdue (fu1 sent, fu2 not sent, fu2 scheduled in the past)
    if (fu1SentAt && !fu2SentAt && fu2Sched) {
      const sched = new Date(fu2Sched);
      if (!Number.isNaN(sched.getTime()) && sched < now) {
        overdueFu2Rows.push({ rowIdx: i, sheetRow: i + 1, row: r });
      }
    }
  }

  const totalOverdue = overdueFu1Rows.length + overdueFu2Rows.length;
  console.log(`Found overdue: fu1=${overdueFu1Rows.length}, fu2=${overdueFu2Rows.length}, total=${totalOverdue}`);

  if (totalOverdue === 0) {
    console.log("Nothing to reschedule.");
    return;
  }

  // Build schedule days (epoch-ms midnights in BUSINESS_TIMEZONE)
  const days = nextBusinessDaysFromTomorrow(BUSINESS_DAYS);
  console.log(
    `Spreading over ${BUSINESS_DAYS} business days (${BUSINESS_TIMEZONE}): ${days
      .map(dayLabel)
      .join(", ")}`
  );
  console.log(`Daily cap: ${APPLY_DAILY_CAP}`);

  // Build queue of slots: day buckets with capacity
  const dayBuckets = days.map((d) => ({ dayMs: d, remaining: APPLY_DAILY_CAP, assigned: [] }));

  // Round-robin assignment: give each overdue row a day with remaining capacity
  // Priority: fu2 overdue rows first (more time-sensitive: main + fu1 already sent a while ago)
  // Then fu1 overdue rows
  const assignments = []; // { sheetRow, row, step, newSendAt, newFu2SendAt? }

  function nextDayBucket(preferIdx = 0) {
    for (let offset = 0; offset < dayBuckets.length; offset++) {
      const idx = (preferIdx + offset) % dayBuckets.length;
      if (dayBuckets[idx].remaining > 0) return dayBuckets[idx];
    }
    return null;
  }

  let rr = 0;
  const allOverdue = [
    ...overdueFu2Rows.map((r) => ({ ...r, step: "fu2" })),
    ...overdueFu1Rows.map((r) => ({ ...r, step: "fu1" })),
  ];

  for (const item of allOverdue) {
    const bucket = nextDayBucket(rr);
    if (!bucket) {
      console.warn(
        `Ran out of capacity: ${allOverdue.length - assignments.length} rows unassigned. Consider raising BUSINESS_DAYS or APPLY_DAILY_CAP.`
      );
      break;
    }
    bucket.remaining -= 1;
    bucket.assigned.push(item);
    const sendUtcMs = randomBusinessTimeOnDay(bucket.dayMs);
    const sendIso = toIso(sendUtcMs);

    if (item.step === "fu1") {
      // fu1 goes on this day; fu2 must be >= fu1 + FU_GAP_DAYS business days,
      // also within business hours in BUSINESS_TIMEZONE.
      const fu2DayMs = addBusinessDays(bucket.dayMs, FU_GAP_DAYS);
      const fu2UtcMs = randomBusinessTimeOnDay(fu2DayMs);
      assignments.push({
        sheetRow: item.sheetRow,
        row: item.row,
        step: "fu1",
        newSendAt: sendIso,
        newFu2SendAt: toIso(fu2UtcMs),
      });
    } else {
      assignments.push({
        sheetRow: item.sheetRow,
        row: item.row,
        step: "fu2",
        newSendAt: sendIso,
      });
    }

    rr = (rr + 1) % dayBuckets.length;
  }

  // Summary
  console.log("");
  console.log("Plan per day:");
  for (const b of dayBuckets) {
    const fu1Count = b.assigned.filter((a) => a.step === "fu1").length;
    const fu2Count = b.assigned.filter((a) => a.step === "fu2").length;
    console.log(
      `  ${dayLabel(b.dayMs)}: total ${b.assigned.length} (fu1=${fu1Count}, fu2=${fu2Count})`
    );
  }

  // Sample diff
  console.log("");
  console.log("Sample changes (first 5):");
  for (const a of assignments.slice(0, 5)) {
    const email = a.row[idx.recipient_email];
    const oldFu1 = a.row[idx.follow_up_1_send_at];
    const oldFu2 = a.row[idx.follow_up_2_send_at];
    console.log(
      `  row ${a.sheetRow} ${email} step=${a.step}\n    fu1: ${oldFu1} -> ${a.step === "fu1" ? a.newSendAt : oldFu1}\n    fu2: ${oldFu2} -> ${a.step === "fu1" ? a.newFu2SendAt : a.newSendAt}`
    );
  }

  if (!apply) {
    console.log("");
    console.log(`DRY RUN. ${assignments.length} rows would be updated. Re-run with --apply to write.`);
    return;
  }

  console.log("");
  console.log(`Applying ${assignments.length} updates in a single batch request...`);
  const nowIso = new Date().toISOString();
  const data = [];
  for (const a of assignments) {
    const updates = {};
    if (a.step === "fu1") {
      updates.follow_up_1_send_at = a.newSendAt;
      updates.follow_up_2_send_at = a.newFu2SendAt;
    } else {
      updates.follow_up_2_send_at = a.newSendAt;
    }
    updates.updated_at = nowIso;
    const existingNotes = String(a.row[idx.notes] || "");
    const note = `rescheduled-overdue@${nowIso}`;
    updates.notes = existingNotes ? `${existingNotes}; ${note}` : note;

    for (const [col, val] of Object.entries(updates)) {
      const colLetter = columnLetter(idx[col] + 1);
      data.push({
        range: `Queue!${colLetter}${a.sheetRow}`,
        majorDimension: "ROWS",
        values: [[val]],
      });
    }
  }

  // Chunk just in case (Sheets API can handle a lot but be safe)
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK);
    await batchUpdateSheetValues(accessToken, getOutreachSpreadsheetId(), chunk);
    written += chunk.length;
    console.log(`  wrote ${written}/${data.length} cell updates`);
  }
  console.log(`Done. Updated ${assignments.length} rows (${data.length} cells).`);
}

function columnLetter(colNum) {
  let s = "";
  let n = colNum;
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
