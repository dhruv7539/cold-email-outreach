#!/usr/bin/env node
/**
 * Seed end-to-end test rows into the Queue sheet.
 *
 * Scenarios (all timestamps are ISO-UTC, but chosen to land inside the
 * 9-17 America/Los_Angeles business window):
 *
 *   T1  main only                               -> expect `completed`
 *   T2  main + fu1 + fu2                        -> expect `completed`
 *   T3  main, then YOU reply to the inbox copy  -> expect `replied`
 *         (fu1 scheduled tomorrow morning so you have time to reply)
 *   T4  main sent to invalid gmail address      -> expect `bounced`
 *         (fu1/fu2 scheduled but should be skipped once bounce is detected)
 *
 * Usage:
 *   node scripts/seed-test-rows.mjs            # dry run, prints the plan
 *   node scripts/seed-test-rows.mjs --apply    # actually insert the rows
 */

import { appendSheetValues, getSheetsAccessToken } from "./sheets-api.mjs";
import { getOutreachSpreadsheetId, OUTREACH_QUEUE_HEADERS, loadOutreachConfig, getCandidate } from "./config.mjs";

async function getTestRecipient() {
  try {
    const config = loadOutreachConfig();
    const email = getCandidate(config).email?.trim();
    if (email) return email;
  } catch {
    // fall through
  }
  throw new Error("Set candidate.email in outreach.config.json before running seed-test-rows.");
}
// A Gmail-domain address we're confident doesn't exist. Gmail's MX will
// return a 550 DSN quickly, which lands as a new message in the sender's
// thread and gets picked up by detectThreadOutcome_.
const BAD_RECIPIENT = "nonexistent-bounce-test-zxq7w9p2k@gmail.com";

const BUSINESS_TIMEZONE = "America/Los_Angeles";

function parseArgs(argv) {
  const args = { apply: argv.includes("--apply"), only: null };
  const idx = argv.indexOf("--only");
  if (idx !== -1 && argv[idx + 1]) {
    args.only = new Set(
      argv[idx + 1]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return args;
}

function partsInBusinessTz(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) === 24 ? 0 : Number(p.hour),
    minute: Number(p.minute),
  };
}

function tzOffsetMinutes(utcMs) {
  const d = new Date(utcMs);
  const p = partsInBusinessTz(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - utcMs) / 60000);
}

function zonedToUtcIso(year, month, day, hour, minute) {
  const candidate = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMinutes(candidate);
  return new Date(candidate - offset * 60 * 1000).toISOString();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function tomorrowAtBusinessTime(nowDate, hour, minute) {
  // Take today's calendar date in BUSINESS_TIMEZONE, then advance by one
  // calendar day using UTC-midnight arithmetic (safe for month/year rollover).
  const p = partsInBusinessTz(nowDate);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const plus1 = new Date(base.getTime() + 24 * 3600 * 1000);
  return zonedToUtcIso(
    plus1.getUTCFullYear(),
    plus1.getUTCMonth() + 1,
    plus1.getUTCDate(),
    hour,
    minute
  );
}

function prettyLocal(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

let testRecipientEmail = "";

function makeRow(overrides) {
  const nowIso = new Date().toISOString();
  const base = Object.fromEntries(OUTREACH_QUEUE_HEADERS.map((h) => [h, ""]));
  return {
    ...base,
    company: "test",
    contact_name: "Test",
    contact_type: "test",
    recipient_email: testRecipientEmail,
    status: "queued",
    active_step: "main",
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  };
}

function buildScenarios(now) {
  const tag = `seed-${now.toISOString().replace(/[:.]/g, "-")}`;

  // All mains at now+3 min. The 1-minute processQueue trigger picks them up
  // on its next run once main_send_at is in the past.
  const mainSendAt = addMinutes(now, 3);

  const t1 = makeRow({
    job_id: `${tag}-t1-main-only`,
    contact_name: "T1 main-only",
    subject: "[TEST] T1 main only - should complete",
    main_html:
      "<p>Test 1 of 4: <b>main only</b>.</p>" +
      "<p>No follow-ups configured. Row should flip to <b>completed</b> immediately after send.</p>",
    main_send_at: mainSendAt,
    notes: "T1: expect completed",
  });

  const t2 = makeRow({
    job_id: `${tag}-t2-full-sequence`,
    contact_name: "T2 full-sequence",
    subject: "[TEST] T2 full sequence (main + fu1 + fu2)",
    main_html:
      "<p>Test 2 of 4, step <b>main</b>.</p>" +
      "<p>Follow-up 1 should arrive ~7 min later, follow-up 2 ~14 min after that.</p>",
    main_send_at: mainSendAt,
    follow_up_1_html: "<p>Test 2 step <b>fu1</b>.</p>",
    follow_up_1_send_at: addMinutes(now, 10),
    follow_up_2_html: "<p>Test 2 step <b>fu2</b>.</p>",
    follow_up_2_send_at: addMinutes(now, 17),
    notes: "T2: expect completed (after 3 sends)",
  });

  const t3 = makeRow({
    job_id: `${tag}-t3-reply`,
    contact_name: "T3 reply-me",
    subject: "[TEST] T3 REPLY ME before tomorrow 09:30 PDT",
    main_html:
      "<p>Test 3 of 4: <b>reply to this email</b> to simulate a prospect responding.</p>" +
      "<p>If you reply before tomorrow 09:30 PDT, the row should flip to " +
      "<b>replied</b> and you should NEVER see fu1 land in your inbox.</p>",
    main_send_at: mainSendAt,
    follow_up_1_html:
      "<p>Test 3 fu1 - you should NOT see this if you replied to the main.</p>",
    follow_up_1_send_at: tomorrowAtBusinessTime(now, 9, 30),
    follow_up_2_html: "<p>Test 3 fu2 - also should not appear.</p>",
    follow_up_2_send_at: tomorrowAtBusinessTime(now, 9, 45),
    notes: "T3: reply to main -> expect replied, fu1 skipped",
  });

  const t4 = makeRow({
    job_id: `${tag}-t4-bounce`,
    contact_name: "T4 bounce",
    recipient_email: BAD_RECIPIENT,
    subject: "[TEST] T4 bounce test (invalid recipient)",
    main_html:
      "<p>Test 4 of 4: sent to an invalid gmail address.</p>" +
      "<p>Gmail should DSN; detectThreadOutcome_ should catch it, " +
      "either before fu1 fires or during the next checkRepliesAndBounces run.</p>",
    main_send_at: mainSendAt,
    follow_up_1_html: "<p>fu1 should be skipped once bounce is detected.</p>",
    follow_up_1_send_at: addMinutes(now, 25),
    follow_up_2_html: "<p>fu2 should also be skipped.</p>",
    follow_up_2_send_at: addMinutes(now, 45),
    notes: "T4: invalid recipient -> expect bounced, fu1/fu2 skipped",
  });

  return [t1, t2, t3, t4];
}

async function main() {
  const { apply, only } = parseArgs(process.argv);
  testRecipientEmail = await getTestRecipient();
  const now = new Date();
  let scenarios = buildScenarios(now);
  if (only) {
    scenarios = scenarios.filter((s) => {
      const short = (s.job_id.match(/-(t\d+)-/) || [])[1] || "";
      return only.has(short.toLowerCase());
    });
    if (scenarios.length === 0) {
      throw new Error(`No scenarios matched --only=${[...only].join(",")}`);
    }
  }

  console.log(`Seeding ${scenarios.length} test rows (apply=${apply})`);
  console.log(`Current time: ${prettyLocal(now.toISOString())} ${BUSINESS_TIMEZONE}`);
  console.log(`Recipient for T1-T3: ${testRecipientEmail}`);
  console.log(`Recipient for T4 (bounce): ${BAD_RECIPIENT}`);
  console.log("");

  for (const t of scenarios) {
    console.log(`  ${t.job_id}`);
    console.log(`    to:      ${t.recipient_email}`);
    console.log(`    subject: ${t.subject}`);
    console.log(
      `    main:    ${prettyLocal(t.main_send_at)}  | fu1: ${prettyLocal(
        t.follow_up_1_send_at
      )}  | fu2: ${prettyLocal(t.follow_up_2_send_at)}`
    );
    console.log(`    expect:  ${t.notes}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to insert into Queue.");
    return;
  }

  const { accessToken } = await getSheetsAccessToken();
  const rows = scenarios.map((t) => OUTREACH_QUEUE_HEADERS.map((h) => t[h] ?? ""));
  const result = await appendSheetValues(
    accessToken,
    getOutreachSpreadsheetId(),
    "Queue!A1",
    rows,
    "USER_ENTERED",
    "INSERT_ROWS"
  );
  console.log("");
  console.log(
    `Appended ${rows.length} rows. Updated range: ${result?.updates?.updatedRange || "?"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
