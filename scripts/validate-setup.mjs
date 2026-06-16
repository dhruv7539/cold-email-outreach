#!/usr/bin/env node
/**
 * Validate first-time setup before running campaigns.
 * Exit 0 when ready; exit 1 with actionable errors otherwise.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTREACH_CONFIG_PATH,
  loadOutreachConfig,
  getPrimarySpreadsheetId,
  getCandidate,
  getGoogleConfig,
  isSetupComplete,
} from "./load-config.mjs";
import { getDefaultSheetsOauthPaths } from "./google-oauth.mjs";
import { getSheetsAccessToken, getSheetValues } from "./sheets-api.mjs";
import { OUTREACH_SHEET_NAMES } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");

function ok(label) {
  console.log(`  OK  ${label}`);
}

function fail(label, detail) {
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

async function readEnvFile() {
  try {
    const raw = await fs.readFile(ENV_PATH, "utf8");
    const env = {};
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const errors = [];
  console.log("Outreach setup validation\n");

  // Config file
  let config;
  try {
    config = await loadOutreachConfig();
    ok(`outreach.config.json found`);
  } catch (error) {
    fail("outreach.config.json", error.message);
    errors.push("config");
    console.log("\nRun setup: copy outreach.config.example.json → outreach.config.json (see SETUP.md)");
    process.exit(1);
  }

  const candidate = getCandidate(config);
  const google = getGoogleConfig(config);

  for (const [key, label] of [
    ["first_name", "candidate.first_name"],
    ["email", "candidate.email"],
    ["university", "candidate.university"],
    ["grad_date", "candidate.grad_date"],
  ]) {
    if (candidate[key]?.trim()) ok(label);
    else {
      fail(label, "empty");
      errors.push(label);
    }
  }

  const sheetId = getPrimarySpreadsheetId(config);
  if (sheetId) ok(`google.primary_spreadsheet_id (${sheetId.slice(0, 8)}…)`);
  else {
    fail("google.primary_spreadsheet_id", "empty");
    errors.push("spreadsheet_id");
  }

  if (google.sender_email?.trim()) ok(`google.sender_email (${google.sender_email})`);
  else {
    fail("google.sender_email", "empty — set in outreach.config.json and Sheet Settings");
    errors.push("sender_email");
  }

  if (isSetupComplete(config)) ok("setup_complete = true");
  else {
    fail("setup_complete", "false — finish SETUP.md Phase D self-test first");
    errors.push("setup_complete");
  }

  // Local profile files
  for (const file of ["master_data.md", "COLD_EMAIL_PROOF_BANK.md", "CAMPAIGN_LOG.md"]) {
    if (await fileExists(path.join(REPO_ROOT, file))) ok(file);
    else {
      fail(file, "missing — copy from *.template.md");
      errors.push(file);
    }
  }

  // .env
  const env = await readEnvFile();
  const apolloKey = process.env.APOLLO_API_KEY || env.APOLLO_API_KEY;
  if (apolloKey?.trim()) ok("APOLLO_API_KEY");
  else {
    fail("APOLLO_API_KEY", "missing in .env");
    errors.push("apollo");
  }

  // Google OAuth for Node tooling
  const { oauthPath, credentialsPath } = getDefaultSheetsOauthPaths();
  if (await fileExists(oauthPath)) ok(`OAuth client (${path.basename(oauthPath)})`);
  else {
    fail("OAuth client JSON", `missing at ${oauthPath}`);
    errors.push("oauth_client");
  }

  if (await fileExists(credentialsPath)) ok(`OAuth credentials (${path.basename(credentialsPath)})`);
  else {
    fail("OAuth credentials", `missing — run: node scripts/authorize-google-sheets.mjs`);
    errors.push("oauth_creds");
  }

  // Sheet reachability
  if (sheetId && (await fileExists(credentialsPath))) {
    try {
      const { accessToken } = await getSheetsAccessToken();
      for (const tab of [OUTREACH_SHEET_NAMES.QUEUE, OUTREACH_SHEET_NAMES.SETTINGS]) {
        await getSheetValues(accessToken, sheetId, `${tab}!A1:A1`);
        ok(`Sheet tab "${tab}" reachable`);
      }
    } catch (error) {
      fail("Google Sheet access", error.message);
      errors.push("sheet_access");
    }
  }

  console.log("");
  if (errors.length === 0) {
    console.log("All checks passed. Ready for campaign work (see AGENTS.md).");
    process.exit(0);
  }

  console.log(`${errors.length} issue(s) found. See SETUP.md to resolve.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
