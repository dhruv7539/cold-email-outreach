#!/usr/bin/env node
// Overwrite existing Queue rows from an exported CSV (in-place refresh).
// Preserves job_id, status, active_step, Gmail thread fields, and created_at.
// Updates subject, HTML bodies, send times, notes, and updated_at.
//
// Usage:
//   node scripts/update-queue-rows-from-csv.mjs \
//     --csv output/apps-script/SLUG.queue.csv \
//     --start-row 678 \
//     --spreadsheet-id <from outreach.config.json>

import fs from "node:fs/promises";
import {
  getOutreachSpreadsheetId,
  OUTREACH_QUEUE_HEADERS,
} from "./config.mjs";
import {
  getSheetsAccessToken,
  getSheetValues,
  batchUpdateSheetValues,
} from "./sheets-api.mjs";

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function colLetter(n) {
  let s = "";
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = args.csv;
  const startRow = Number(args["start-row"]);
  if (!csvPath || !Number.isFinite(startRow) || startRow < 2) {
    throw new Error(
      "Usage: node scripts/update-queue-rows-from-csv.mjs --csv <path> --start-row <n>"
    );
  }

  const raw = await fs.readFile(csvPath, "utf8");
  const parsed = parseCsv(raw.trim());
  const header = parsed[0];
  const csvRows = parsed.slice(1);
  if (header.join(",") !== OUTREACH_QUEUE_HEADERS.join(",")) {
    throw new Error("CSV header does not match OUTREACH_QUEUE_HEADERS.");
  }

  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const endRow = startRow + csvRows.length - 1;
  const lastCol = colLetter(OUTREACH_QUEUE_HEADERS.length - 1);
  const range = `Queue!A${startRow}:${lastCol}${endRow}`;

  const { accessToken } = await getSheetsAccessToken(args);
  const existing = await getSheetValues(accessToken, spreadsheetId, range);
  const existingRows = existing?.values ?? [];
  if (existingRows.length !== csvRows.length) {
    throw new Error(
      `Row count mismatch: sheet has ${existingRows.length}, CSV has ${csvRows.length} at ${range}.`
    );
  }

  const preserve = new Set([
    "job_id",
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
    "error",
  ]);

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const merged = csvRows.map((csvRow, i) => {
    const old = existingRows[i] ?? [];
    const out = [...csvRow];
    for (const key of preserve) {
      const j = idx[key];
      if (j !== undefined && old[j] !== undefined && old[j] !== "") {
        out[j] = old[j];
      }
    }
    out[idx.updated_at] = new Date().toISOString();
    return out;
  });

  await batchUpdateSheetValues(accessToken, spreadsheetId, [
    { range, values: merged },
  ]);

  console.log(
    JSON.stringify(
      {
        updatedRange: range,
        rowCount: merged.length,
        preserved: [...preserve],
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
