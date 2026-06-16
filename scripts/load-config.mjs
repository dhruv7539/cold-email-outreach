import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const OUTREACH_CONFIG_PATH = path.join(REPO_ROOT, "outreach.config.json");
export const OUTREACH_CONFIG_EXAMPLE_PATH = path.join(REPO_ROOT, "outreach.config.example.json");

let cachedConfig = null;

export async function loadOutreachConfig(options = {}) {
  if (cachedConfig && !options.reload) {
    return cachedConfig;
  }

  const configPath = options.configPath || OUTREACH_CONFIG_PATH;
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `Missing ${path.basename(configPath)}. Copy outreach.config.example.json to outreach.config.json and run setup (see SETUP.md).`
      );
    }
    throw error;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.basename(configPath)}: ${error.message}`);
  }

  cachedConfig = config;
  return config;
}

export function loadOutreachConfigSync(options = {}) {
  if (cachedConfig && !options.reload) {
    return cachedConfig;
  }

  const configPath = options.configPath || OUTREACH_CONFIG_PATH;
  let raw;
  try {
    raw = require("node:fs").readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `Missing ${path.basename(configPath)}. Copy outreach.config.example.json to outreach.config.json and run setup (see SETUP.md).`
      );
    }
    throw error;
  }

  cachedConfig = JSON.parse(raw);
  return cachedConfig;
}

export function getCandidate(config) {
  return config?.candidate || {};
}

export function getGoogleConfig(config) {
  return config?.google || {};
}

export function getApolloConfig(config) {
  return config?.apollo || {};
}

export function getPrimarySpreadsheetId(config) {
  return (
    process.env.OUTREACH_SPREADSHEET_ID ||
    getGoogleConfig(config).primary_spreadsheet_id ||
    ""
  ).trim();
}

export function getOverflowSpreadsheetId(config) {
  return (getGoogleConfig(config).overflow_spreadsheet_id || "").trim();
}

export function getSignatureHtml(config) {
  const firstName = getCandidate(config).first_name || "YOUR_FIRST_NAME";
  return `<p>Thanks,<br>\n${firstName}</p>`;
}

export function isSetupComplete(config) {
  return Boolean(config?.setup_complete);
}

export function requireSpreadsheetId(config) {
  const id = getPrimarySpreadsheetId(config);
  if (!id) {
    throw new Error(
      "OUTREACH_SPREADSHEET_ID is not set. Add google.primary_spreadsheet_id to outreach.config.json or set OUTREACH_SPREADSHEET_ID in .env (see SETUP.md)."
    );
  }
  return id;
}
