#!/usr/bin/env node
/**
 * Cancel low-influence Queue rows (default: software_engineer + hr).
 * Never cancels recruiter, hiring_manager, or founder.
 *
 *   node scripts/cancel-queue-rows.mjs --rows 533:620
 *   node scripts/cancel-queue-rows.mjs --company "Apple" --apply
 *   node scripts/cancel-queue-rows.mjs --rows 533:620 --keep-emails a@b.com,c@d.com --apply
 */

import {
  OUTREACH_QUEUE_HEADERS,
  getOutreachSpreadsheetId(),
} from "./config.mjs";
import { getSheetsAccessToken, getSheetValues, updateSheetValues } from "./sheets-api.mjs";

const TERMINAL_STATUSES = new Set(["completed", "replied", "bounced", "cancelled", "failed"]);
const PROTECTED_TYPES = new Set(["recruiter", "hiring_manager", "founder"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
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

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1");
}

function parseRowRange(value) {
  const match = String(value || "").match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) {
    throw new Error(`Invalid --rows value "${value}" (expected START:END)`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error(`Invalid --rows range ${value}`);
  }
  return { start, end };
}

function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function headerIndex(name) {
  const idx = OUTREACH_QUEUE_HEADERS.indexOf(name);
  if (idx === -1) {
    throw new Error(`Missing header ${name} in OUTREACH_QUEUE_HEADERS`);
  }
  return idx;
}

function todayNoteTag() {
  return `cancelled-low-influence@${new Date().toISOString().slice(0, 10)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const apply = args.apply === "true";
  const spreadsheetId = args["spreadsheet-id"] || getOutreachSpreadsheetId();
  const cancelTypes = new Set(
    String(args["contact-types"] || "software_engineer,hr")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const keepEmails = new Set(
    String(args["keep-emails"] || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean)
  );
  const companyFilter = args.company ? String(args.company).trim().toLowerCase() : null;
  const rowRange = args.rows ? parseRowRange(args.rows) : null;

  const statusIdx = headerIndex("status");
  const typeIdx = headerIndex("contact_type");
  const emailIdx = headerIndex("recipient_email");
  const mainSentIdx = headerIndex("main_sent_at");
  const notesIdx = headerIndex("notes");
  const companyIdx = headerIndex("company");
  const nameIdx = headerIndex("contact_name");

  const lastCol = columnLetter(OUTREACH_QUEUE_HEADERS.length - 1);
  const readStart = rowRange ? rowRange.start : 2;
  const readEnd = rowRange ? rowRange.end : 2000;
  const range = `Queue!A${readStart}:${lastCol}${readEnd}`;

  const { accessToken } = await getSheetsAccessToken();
  const sheet = await getSheetValues(accessToken, spreadsheetId, range);
  const rows = sheet.values || [];

  const actions = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = readStart + i;
    const row = rows[i];
    if (!row || row.length === 0) {
      continue;
    }

    const company = String(row[companyIdx] || "").trim();
    const contactType = String(row[typeIdx] || "").trim().toLowerCase();
    const email = normalizeEmail(row[emailIdx]);
    const status = String(row[statusIdx] || "").trim().toLowerCase();
    const mainSentAt = String(row[mainSentIdx] || "").trim();
    const name = String(row[nameIdx] || "").trim();

    if (companyFilter && company.toLowerCase() !== companyFilter) {
      continue;
    }

    if (TERMINAL_STATUSES.has(status)) {
      skipped += 1;
      continue;
    }

    if (mainSentAt) {
      skipped += 1;
      continue;
    }

    if (PROTECTED_TYPES.has(contactType)) {
      skipped += 1;
      continue;
    }

    if (!cancelTypes.has(contactType)) {
      skipped += 1;
      continue;
    }

    if (keepEmails.has(email)) {
      skipped += 1;
      continue;
    }

    actions.push({
      rowNumber,
      company,
      name,
      contactType,
      email,
      prevNotes: String(row[notesIdx] || "").trim(),
    });
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Spreadsheet: ${spreadsheetId}`);
  console.log(`Range: ${range}`);
  console.log(`Cancel types: ${[...cancelTypes].join(", ")}`);
  console.log(`Keep emails: ${keepEmails.size ? [...keepEmails].join(", ") : "(none)"}`);
  console.log("");

  if (actions.length === 0) {
    console.log("No rows to cancel.");
  } else {
    console.log("Will cancel:");
    for (const a of actions) {
      console.log(
        `  r${a.rowNumber} [${a.company}] ${a.name} (${a.contactType}) <${a.email}>`
      );
    }
  }

  console.log(`\nSkipped ${skipped} row(s) (protected / terminal / not eligible).`);

  if (!apply) {
    console.log(`\nRe-run with --apply to write ${actions.length} cancellation(s).`);
    return;
  }

  const noteTag = todayNoteTag();
  const statusCol = columnLetter(statusIdx);
  const notesCol = columnLetter(notesIdx);

  for (const a of actions) {
    const nextNotes = a.prevNotes ? `${a.prevNotes}; ${noteTag}` : noteTag;
    await updateSheetValues(accessToken, spreadsheetId, `Queue!${statusCol}${a.rowNumber}`, [
      ["cancelled"],
    ]);
    await updateSheetValues(accessToken, spreadsheetId, `Queue!${notesCol}${a.rowNumber}`, [
      [nextNotes],
    ]);
  }

  console.log(`\nApplied ${actions.length} cancellation(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
