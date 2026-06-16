#!/usr/bin/env node
// Prints the combined set of emails that should be SKIPPED in any new discovery
// pass — this is (a) every recipient currently in the Queue sheet and (b)
// every email permanently blacklisted (bounces + opt-outs) in the Blacklist
// sheet. Feed the output into apollo-rest-enrich-person.mjs --skip-emails so
// we never spend credits or draft copy for a contact who's already queued or
// whom Gmail has already flagged undeliverable.
//
// Usage:
//   node scripts/list-skip-emails.mjs                       # Queue + Blacklist, one per line
//   node scripts/list-skip-emails.mjs --comma               # CSV form for --skip-emails
//   node scripts/list-skip-emails.mjs --source queue        # Queue only
//   node scripts/list-skip-emails.mjs --source blacklist    # Blacklist only
//   node scripts/list-skip-emails.mjs --company Garmin      # filter Queue rows by company
//
// Chain example:
//   node scripts/apollo-rest-enrich-person.mjs \
//     --ids "$IDS" \
//     --skip-emails "$(node scripts/list-skip-emails.mjs --comma)"

import { getSheetsAccessToken, getSheetValues } from "./sheets-api.mjs";
import {
  getOutreachSpreadsheetId(),
  OUTREACH_QUEUE_HEADERS,
  OUTREACH_SHEET_NAMES,
} from "./config.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

async function readQueueEmails(accessToken, spreadsheetId, wantCompany) {
  const range = `${OUTREACH_SHEET_NAMES.QUEUE}!A:AB`;
  const values = await getSheetValues(accessToken, spreadsheetId, range);
  const rows = values?.values ?? [];
  if (rows.length < 2) return new Set();

  const header = rows[0];
  const emailIdx = OUTREACH_QUEUE_HEADERS.indexOf("recipient_email");
  const companyIdx = OUTREACH_QUEUE_HEADERS.indexOf("company");
  if (emailIdx < 0 || header[emailIdx] !== "recipient_email") {
    throw new Error(
      `Queue header column ${emailIdx} is not 'recipient_email' (got '${header[emailIdx]}')`
    );
  }

  const emails = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (wantCompany && String(row[companyIdx] ?? "").toLowerCase() !== wantCompany) continue;
    const e = String(row[emailIdx] ?? "").trim().toLowerCase();
    if (e) emails.add(e);
  }
  return emails;
}

async function readBlacklistEmails(accessToken, spreadsheetId) {
  // Blacklist sheet has a simple 4-col layout: email, reason, first_observed_at,
  // source_queue_row. Silently tolerate the sheet not existing yet (first run
  // before Apps Script has logged any bounces).
  const range = `${OUTREACH_SHEET_NAMES.BLACKLIST}!A:D`;
  let values;
  try {
    values = await getSheetValues(accessToken, spreadsheetId, range);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) return new Set();
    throw err;
  }
  const rows = values?.values ?? [];
  if (rows.length < 2) return new Set();

  const emails = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const e = String(rows[i][0] ?? "").trim().toLowerCase();
    if (e) emails.add(e);
  }
  return emails;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const source = (args.source ?? "all").toLowerCase();
  const wantCompany = args.company ? args.company.toLowerCase() : null;

  const { accessToken } = await getSheetsAccessToken(args);

  const combined = new Set();

  if (source === "all" || source === "queue") {
    const q = await readQueueEmails(accessToken, spreadsheetId, wantCompany);
    for (const e of q) combined.add(e);
  }

  if (source === "all" || source === "blacklist") {
    const b = await readBlacklistEmails(accessToken, spreadsheetId);
    for (const e of b) combined.add(e);
  }

  const list = [...combined].sort();
  if (args.comma === "true") {
    process.stdout.write(list.join(","));
  } else {
    for (const e of list) process.stdout.write(`${e}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
