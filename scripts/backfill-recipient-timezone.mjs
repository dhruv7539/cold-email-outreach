#!/usr/bin/env node

// Backfill the Queue's `recipient_timezone` column for rows that predate the
// column. Builds a global email -> US state map from every enrich file in
// output/enrich/, resolves each to an IANA zone, and writes it for any
// non-terminal row whose timezone is still blank.
//
// Safe by design: a recipient_timezone only narrows the runtime send window to
// that recipient's local business hours (Code.gs). Pacing/throttling are
// unaffected. Unresolved rows are left blank (fall back to the global zone).
//
// Usage:
//   node scripts/backfill-recipient-timezone.mjs            # dry run
//   node scripts/backfill-recipient-timezone.mjs --apply    # write changes

import fs from "node:fs";
import path from "node:path";
import { getOutreachSpreadsheetId } from "./config.mjs";
import {
  getSheetsAccessToken,
  getSheetValues,
  updateSheetValues,
} from "./sheets-api.mjs";
import { resolveTimezoneFromState } from "./timezone-map.mjs";

const TERMINAL = ["completed", "replied", "bounced", "cancelled", "failed"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function buildStateMap(enrichDir) {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(enrichDir).filter((f) => f.endsWith(".json"));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(enrichDir, f), "utf8"));
      for (const entry of parsed.results || []) {
        const person = entry.person || entry;
        const email = String(person.email || "").trim().toLowerCase();
        const state = person.state;
        if (email && state && !map.has(email)) map.set(email, state);
      }
    } catch {
      // skip malformed enrich files
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === "true";
  const spreadsheetId = args["spreadsheet-id"] || getOutreachSpreadsheetId();
  const enrichDir = args["enrich-dir"] || path.join(process.cwd(), "output", "enrich");

  const stateByEmail = buildStateMap(enrichDir);
  console.log(`Loaded ${stateByEmail.size} email->state pairs from enrich files.`);

  const { accessToken } = await getSheetsAccessToken();
  const res = await getSheetValues(accessToken, spreadsheetId, "Queue!A1:AC5000");
  const rows = res.values || [];
  if (rows.length < 2) {
    console.log("No data rows.");
    return;
  }
  const hdr = rows[0];
  const tzI = hdr.indexOf("recipient_timezone");
  const emailI = hdr.indexOf("recipient_email");
  const statusI = hdr.indexOf("status");
  if (tzI === -1) {
    throw new Error("recipient_timezone column not found in Queue header.");
  }

  let resolved = 0;
  let alreadySet = 0;
  let terminalSkipped = 0;
  let unresolved = 0;
  const unresolvedStates = {};

  // Build the full AC column (rows 2..N) preserving existing values.
  const lastDataRow = rows.length; // 1-indexed sheet row of last data row
  const column = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const existing = String((r[tzI] ?? "")).trim();
    const email = String((r[emailI] ?? "")).trim().toLowerCase();
    const status = String((r[statusI] ?? "")).trim();

    let value = existing;
    if (!email) {
      // no recipient -> leave whatever is there
    } else if (existing) {
      alreadySet += 1;
    } else if (TERMINAL.includes(status)) {
      terminalSkipped += 1;
    } else {
      const tz = resolveTimezoneFromState(stateByEmail.get(email));
      if (tz) {
        value = tz;
        resolved += 1;
      } else {
        unresolved += 1;
        const st = stateByEmail.get(email) || "(no enrich match)";
        unresolvedStates[st] = (unresolvedStates[st] || 0) + 1;
      }
    }
    column.push([value]);
  }

  console.log("\n--- Backfill summary ---");
  console.log("rows scanned:        ", rows.length - 1);
  console.log("newly resolved:      ", resolved);
  console.log("already had tz:      ", alreadySet);
  console.log("terminal (skipped):  ", terminalSkipped);
  console.log("unresolved (blank):  ", unresolved);
  console.log("unresolved breakdown:", unresolvedStates);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write the column.");
    return;
  }

  const range = `Queue!AC2:AC${lastDataRow}`;
  await updateSheetValues(accessToken, spreadsheetId, range, column, "RAW");
  console.log(`\nApplied. Wrote ${column.length} cells to ${range}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
