#!/usr/bin/env node

import fs from "node:fs/promises";
import { appendSheetValues, getSheetsAccessToken } from "./sheets-api.mjs";
import { OUTREACH_QUEUE_HEADERS, getOutreachSpreadsheetId } from "./config.mjs";

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

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`);
  }
  return args[key];
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(value);
      value = "";
      continue;
    }
    if (ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    value += ch;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] || getOutreachSpreadsheetId();
  const csvPath = requireArg(args, "csv");
  const range = args.range ?? "Queue!A:AB";

  const csv = await fs.readFile(csvPath, "utf8");
  const rows = parseCsvRows(csv);
  if (rows.length < 2) {
    throw new Error("CSV has no data rows.");
  }

  // Validate header row matches the canonical OUTREACH_QUEUE_HEADERS schema.
  // Without this check, a CSV with a different column order silently writes
  // the wrong values into every column (e.g. swapping subject and main_html).
  // Also catches typos like "follow_up1_html" vs "follow_up_1_html".
  const csvHeader = rows[0].map((h) => String(h || "").trim());
  validateCsvHeaderSchema(csvHeader, OUTREACH_QUEUE_HEADERS);

  const dataRows = rows.slice(1);
  const { accessToken } = await getSheetsAccessToken(args);
  const result = await appendSheetValues(accessToken, spreadsheetId, range, dataRows, "USER_ENTERED", "INSERT_ROWS");

  console.log(
    JSON.stringify(
      {
        spreadsheetId,
        range,
        csvPath,
        appendedRowCount: dataRows.length,
        updatedRange: result?.updates?.updatedRange ?? null,
        updatedRows: result?.updates?.updatedRows ?? null,
      },
      null,
      2
    )
  );
}

function validateCsvHeaderSchema(csvHeader, expected) {
  const missing = expected.filter((h) => !csvHeader.includes(h));
  const unknown = csvHeader.filter((h) => !expected.includes(h));
  const orderMismatch = expected
    .map((h, i) => (csvHeader[i] !== h ? { expected: h, got: csvHeader[i], index: i } : null))
    .filter(Boolean);

  if (missing.length || unknown.length || orderMismatch.length) {
    const lines = ["CSV header does not match canonical OUTREACH_QUEUE_HEADERS schema."];
    if (missing.length) lines.push(`  missing columns: ${missing.join(", ")}`);
    if (unknown.length) lines.push(`  unknown columns: ${unknown.join(", ")}`);
    if (orderMismatch.length) {
      lines.push("  out-of-order columns:");
      for (const m of orderMismatch.slice(0, 5)) {
        lines.push(`    index ${m.index}: expected ${m.expected}, got ${m.got || "(empty)"}`);
      }
      if (orderMismatch.length > 5) {
        lines.push(`    ...and ${orderMismatch.length - 5} more`);
      }
    }
    throw new Error(lines.join("\n"));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
