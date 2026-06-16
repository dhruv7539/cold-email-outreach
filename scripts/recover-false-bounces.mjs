#!/usr/bin/env node

import {
  appendSheetValues,
  clearSheetRange,
  getSheetValues,
  getSheetsAccessToken,
  updateSheetValues,
} from "./sheets-api.mjs";
import { getOutreachSpreadsheetId } from "./config.mjs";

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

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function extractFailedRecipients(errorText) {
  const match = /Failed recipients:\s*([^.\n]+)/i.exec(errorText || "");
  return match ? normalizeEmail(match[1]) : "";
}

function isoNow() {
  return new Date().toISOString();
}

function reclassifyStatus(row, idx) {
  const fu2Sent = row[idx.follow_up_2_sent_at];
  const fu1Sent = row[idx.follow_up_1_sent_at];
  const mainSent = row[idx.main_sent_at];
  if (fu2Sent) {
    return { status: "sent_follow_up_2", active_step: "follow_up_2" };
  }
  if (fu1Sent) {
    return { status: "sent_follow_up_1", active_step: "follow_up_1" };
  }
  if (mainSent) {
    return { status: "sent_main", active_step: "main" };
  }
  // "queued" is the canonical pre-send status used by Code.gs (see README and
  // OUTREACH_TERMINAL_STATUSES); "pending" is not recognized and would leave
  // the row in an undefined state that processQueue would still pick up but
  // never display correctly in the sheet.
  return { status: "queued", active_step: "main" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";

  const { accessToken } = await getSheetsAccessToken();

  const archiveResp = await getSheetValues(accessToken, getOutreachSpreadsheetId(), "Archive!A1:AC5000");
  const archive = archiveResp.values || [];
  if (archive.length === 0) {
    console.log("Archive is empty.");
    return;
  }

  const header = archive[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = archive.slice(1);

  const keep = [];
  const recover = [];

  for (const rRaw of rows) {
    const r = rRaw.slice();
    while (r.length < header.length) r.push("");
    const status = (r[idx.status] || "").trim();
    const recip = normalizeEmail(r[idx.recipient_email]);
    const err = r[idx.error] || "";
    const failed = extractFailedRecipients(err);

    let suspect = false;
    if (status === "bounced") {
      if (!failed) {
        // Fallback bounce (no failed recipients extracted) — most likely false positive
        suspect = true;
      } else if (failed !== recip && !failed.includes(recip) && !recip.includes(failed.split(/[\s,;]/)[0] || "")) {
        suspect = true;
      }
    }

    if (suspect) {
      const next = reclassifyStatus(r, idx);
      r[idx.status] = next.status;
      r[idx.active_step] = next.active_step;
      r[idx.error] = "";
      r[idx.updated_at] = isoNow();
      const notes = r[idx.notes] || "";
      const tag = `[recovered from false-positive bounce ${isoNow()}]`;
      r[idx.notes] = notes ? `${notes} ${tag}` : tag;
      recover.push(r);
    } else {
      keep.push(r);
    }
  }

  console.log("archive total rows:", rows.length);
  console.log("rows flagged for recovery (false-positive bounces):", recover.length);
  console.log("rows staying in Archive (true terminal statuses):", keep.length);

  if (dryRun) {
    console.log("Dry run — no changes written.");
    console.log("Sample recovered row:", recover[0] ? recover[0].slice(0, 5) : "(none)");
    return;
  }

  // 1) Append recovered rows to Queue
  if (recover.length > 0) {
    const queueResp = await getSheetValues(accessToken, getOutreachSpreadsheetId(), "Queue!A1:A1");
    const queueHeaderExists = (queueResp.values || []).length > 0;
    if (!queueHeaderExists) {
      throw new Error("Queue sheet is missing its header row; aborting.");
    }

    await appendSheetValues(
      accessToken,
      getOutreachSpreadsheetId(),
      "Queue!A1",
      recover,
      "RAW"
    );
    console.log(`Appended ${recover.length} recovered rows to Queue.`);
  }

  // 2) Rewrite Archive with only kept rows
  const lastRow = rows.length + 1; // +header
  const clearRange = `Archive!A2:AC${lastRow}`;
  await clearSheetRange(accessToken, getOutreachSpreadsheetId(), clearRange);

  if (keep.length > 0) {
    await updateSheetValues(
      accessToken,
      getOutreachSpreadsheetId(),
      `Archive!A2`,
      keep,
      "RAW"
    );
    console.log(`Rewrote Archive with ${keep.length} retained rows.`);
  } else {
    console.log("Archive cleared (no retained rows).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
