#!/usr/bin/env node
// One-time onboarding for the shared contact pool. Run once per person after
// `git pull`:
//
//   node scripts/setup-shared-pool.mjs --id <SHARED_SHEET_ID>
//
// It:
//   1. Writes ONLY google.shared_pool_spreadsheet_id into your local
//      (gitignored) outreach.config.json, leaving every other key untouched.
//   2. Verifies your Google OAuth can read AND write the sheet.
//   3. Creates the "Contacts" tab + header if missing.
//
// Idempotent and safe to re-run. Pass --id without a value (or omit it) to just
// verify/repair using the ID already in config.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSharedPoolId,
  getAccessToken,
  ensurePoolTab,
  getCompanyContacts,
  POOL_TAB,
} from "./shared-pool.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, "outreach.config.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function writePoolIdToConfig(id) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        "outreach.config.json not found. Run SETUP.md first, then re-run this."
      );
    }
    throw new Error(`could not parse outreach.config.json: ${err.message}`);
  }
  if (!cfg.google || typeof cfg.google !== "object") cfg.google = {};
  const before = cfg.google.shared_pool_spreadsheet_id;
  cfg.google.shared_pool_spreadsheet_id = id;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return before !== id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const explicitId = args.id && args.id !== "true" ? String(args.id).trim() : null;

  if (explicitId) {
    const changed = writePoolIdToConfig(explicitId);
    console.log(
      changed
        ? `1) wrote google.shared_pool_spreadsheet_id to outreach.config.json`
        : `1) google.shared_pool_spreadsheet_id already set (unchanged)`
    );
  } else {
    console.log("1) no --id given; using the ID already in config/env");
  }

  const spreadsheetId = getSharedPoolId();
  if (!spreadsheetId) {
    console.error(
      "no shared pool ID found. Pass --id <SHARED_SHEET_ID> (get it from whoever owns the shared sheet)."
    );
    process.exit(1);
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(args);
  } catch (err) {
    console.error(`2) OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("   Complete the Google OAuth in SETUP.md, then re-run.");
    process.exit(1);
  }

  try {
    const { created, headerWritten } = await ensurePoolTab(accessToken, spreadsheetId);
    console.log(
      `2) sheet access OK (read+write)\n3) '${POOL_TAB}' tab ${created ? "created" : "already present"}${headerWritten ? " (header written)" : ""}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   sheet write failed: ${msg}`);
    if (/403|permission|PERMISSION/i.test(msg)) {
      console.error(
        "   Ask the sheet owner to share it (Editor) with your Google account."
      );
    }
    process.exit(1);
  }

  // Sanity read.
  const sample = await getCompanyContacts(accessToken, spreadsheetId, { company: "__none__" });
  console.log(`   pool reachable (current query returned ${sample.length} rows).`);
  console.log("\nDone. The shared pool is set up. Campaigns will use it automatically.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
