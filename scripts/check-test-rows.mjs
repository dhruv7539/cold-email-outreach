#!/usr/bin/env node
/**
 * Monitor progress of rows seeded by seed-test-rows.mjs.
 * Matches rows whose job_id starts with "seed-" and whose subject starts with
 * "[TEST]". Prints status, active_step, sent timestamps, and any error.
 *
 * Usage:
 *   node scripts/check-test-rows.mjs
 */

import { getSheetValues, getSheetsAccessToken } from "./sheets-api.mjs";
import { getOutreachSpreadsheetId } from "./config.mjs";

const BUSINESS_TIMEZONE = "America/Los_Angeles";

function prettyLocal(iso) {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function collect(accessToken, range) {
  const { values } = await getSheetValues(accessToken, getOutreachSpreadsheetId(), range);
  return values || [];
}

async function main() {
  const { accessToken } = await getSheetsAccessToken();
  const header = (await collect(accessToken, "Queue!A1:AB1"))[0] || [];
  const queueRows = await collect(accessToken, "Queue!A2:AB10000");
  const archiveRows = await collect(accessToken, "Archive!A2:AB10000");
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  function isTestRow(row) {
    const jobId = String(row[idx.job_id] || "");
    const subject = String(row[idx.subject] || "");
    return jobId.startsWith("seed-") && subject.startsWith("[TEST]");
  }

  const rows = [
    ...queueRows.filter(isTestRow).map((r) => ({ r, where: "Queue" })),
    ...archiveRows.filter(isTestRow).map((r) => ({ r, where: "Archive" })),
  ];

  if (rows.length === 0) {
    console.log("No seeded [TEST] rows found.");
    return;
  }

  rows.sort((a, b) => String(a.r[idx.job_id]).localeCompare(String(b.r[idx.job_id])));

  for (const { r, where } of rows) {
    const id = r[idx.job_id];
    const label = String(r[idx.contact_name] || "").padEnd(18);
    const status = String(r[idx.status] || "").padEnd(17);
    const step = String(r[idx.active_step] || "").padEnd(12);
    const sent = [
      r[idx.main_sent_at] ? `main@${prettyLocal(r[idx.main_sent_at])}` : null,
      r[idx.follow_up_1_sent_at] ? `fu1@${prettyLocal(r[idx.follow_up_1_sent_at])}` : null,
      r[idx.follow_up_2_sent_at] ? `fu2@${prettyLocal(r[idx.follow_up_2_sent_at])}` : null,
      r[idx.reply_detected_at] ? `reply@${prettyLocal(r[idx.reply_detected_at])}` : null,
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`[${where}]  ${label}  status=${status}  step=${step}  ${sent}`);
    const err = String(r[idx.error] || "").trim();
    if (err) console.log(`           error: ${err.slice(0, 200)}`);
    console.log(`           id: ${id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
