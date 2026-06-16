#!/usr/bin/env node
// Prints the set of recipient_email values currently in the Queue sheet,
// one per line. Feed into apollo-rest-enrich-person.mjs --skip-emails to
// de-duplicate against contacts already queued for outreach.
//
// Usage:
//   node scripts/list-queued-emails.mjs                # all queued emails
//   node scripts/list-queued-emails.mjs --company Garmin  # filter by company
//   node scripts/list-queued-emails.mjs --comma        # output comma-separated (for --skip-emails)
//
// Chain example:
//   node scripts/apollo-rest-enrich-person.mjs \
//     --ids $(cat ids.txt) \
//     --skip-emails "$(node scripts/list-queued-emails.mjs --comma)"

import { getSheetsAccessToken, getSheetValues } from "./sheets-api.mjs";
import { getOutreachSpreadsheetId, OUTREACH_QUEUE_HEADERS } from "./config.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const range = args.range ?? "Queue!A:AB";

  const { accessToken } = await getSheetsAccessToken(args);
  const values = await getSheetValues(accessToken, spreadsheetId, range);

  const rows = values?.values ?? [];
  if (rows.length < 2) {
    process.stdout.write(args.comma === "true" ? "" : "");
    return;
  }

  const header = rows[0];
  const emailIdx = OUTREACH_QUEUE_HEADERS.indexOf("recipient_email");
  const companyIdx = OUTREACH_QUEUE_HEADERS.indexOf("company");
  if (emailIdx < 0 || header[emailIdx] !== "recipient_email") {
    throw new Error(`Queue header column ${emailIdx} is not 'recipient_email' (got '${header[emailIdx]}')`);
  }

  const wantCompany = args.company ? args.company.toLowerCase() : null;
  const emails = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (wantCompany && String(row[companyIdx] ?? "").toLowerCase() !== wantCompany) continue;
    const e = String(row[emailIdx] ?? "").trim().toLowerCase();
    if (e) emails.add(e);
  }

  const list = [...emails].sort();
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
