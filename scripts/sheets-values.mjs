#!/usr/bin/env node

import {
  appendSheetValues,
  clearSheetRange,
  getSheetValues,
  getSheetsAccessToken,
  updateSheetValues,
} from "./sheets-api.mjs";

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

function parseValues(args) {
  if (args["values-json"]) {
    return JSON.parse(args["values-json"]);
  }
  throw new Error("Provide --values-json with a JSON 2D array like [[\"a\",\"b\"]].");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const spreadsheetId = requireArg(args, "spreadsheet-id");
  const range = requireArg(args, "range");
  const { accessToken } = await getSheetsAccessToken(args);

  let result;
  if (command === "get") {
    result = await getSheetValues(accessToken, spreadsheetId, range);
  } else if (command === "update") {
    result = await updateSheetValues(accessToken, spreadsheetId, range, parseValues(args), args["value-input-option"]);
  } else if (command === "append") {
    result = await appendSheetValues(accessToken, spreadsheetId, range, parseValues(args), args["value-input-option"], args["insert-data-option"]);
  } else if (command === "clear") {
    result = await clearSheetRange(accessToken, spreadsheetId, range);
  } else {
    throw new Error(
      "Usage: node scripts/sheets-values.mjs <get|update|append|clear> --spreadsheet-id <id> --range <A1-range> [--values-json '[[\"x\"]]']"
    );
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

