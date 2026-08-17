// Shared contact pool — a cross-friend Apollo cache backed by ONE Google Sheet.
//
// Design contract (see SETUP_SHARED_POOL.md):
//   - Additive + compatible with the OLDER published version of this repo.
//     Depends ONLY on sheets-api.mjs functions that exist there
//     (getSheetsAccessToken / getSheetValues / updateSheetValues /
//     appendSheetValues). It does NOT import config.mjs (its exports differ
//     across versions) and does NOT use batchUpdateSpreadsheet (absent in the
//     older version) — tab creation is done via a direct Sheets REST call.
//   - ANONYMOUS: rows carry only contact data + an added_at timestamp. There
//     is no contributor / member / campaign field, so no one can tell which
//     friend added a given contact.
//
// The pool ID comes from env OUTREACH_SHARED_POOL_SPREADSHEET_ID, else
// google.shared_pool_spreadsheet_id in outreach.config.json. When unset, the
// pool is considered DISABLED and callers should skip it silently.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSheetsAccessToken,
  getSheetValues,
  updateSheetValues,
  appendSheetValues,
} from "./sheets-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export const POOL_TAB = "Contacts";
export const SHARED_POOL_HEADERS = [
  "domain",
  "company",
  "apollo_id",
  "name",
  "title",
  "email",
  "email_status",
  "linkedin_url",
  "city",
  "state",
  "country",
  "headline",
  "employment_json",
  "added_at",
];

// --- config (self-contained; do NOT import config.mjs) ---------------------

export function getSharedPoolId() {
  const env = process.env.OUTREACH_SHARED_POOL_SPREADSHEET_ID?.trim();
  if (env) return env;
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "outreach.config.json"), "utf8");
    const cfg = JSON.parse(raw);
    const id = cfg?.google?.shared_pool_spreadsheet_id;
    return id && String(id).trim() ? String(id).trim() : null;
  } catch {
    return null;
  }
}

export function isPoolEnabled() {
  return Boolean(getSharedPoolId());
}

// --- helpers ---------------------------------------------------------------

export function normDomain(domain) {
  if (!domain) return "";
  return String(domain)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function toRow(person, { domain, company }) {
  const org = company || person.organization_name || "";
  return [
    normDomain(domain),
    org,
    person.id ?? "",
    person.name ?? "",
    person.title ?? "",
    person.email ?? "",
    person.email_status ?? "",
    person.linkedin_url ?? "",
    person.city ?? "",
    person.state ?? "",
    person.country ?? "",
    person.headline ?? "",
    JSON.stringify(person.employment_history ?? []),
    new Date().toISOString(),
  ];
}

function rowToRecord(row) {
  const idx = (name) => SHARED_POOL_HEADERS.indexOf(name);
  const get = (name) => row[idx(name)] ?? "";
  let employment = [];
  try {
    employment = JSON.parse(get("employment_json") || "[]");
  } catch {
    employment = [];
  }
  return {
    person: {
      id: get("apollo_id") || null,
      name: get("name") || null,
      title: get("title") || null,
      email: get("email") || null,
      email_status: get("email_status") || null,
      linkedin_url: get("linkedin_url") || null,
      city: get("city") || null,
      state: get("state") || null,
      country: get("country") || null,
      organization_name: get("company") || null,
      headline: get("headline") || null,
      employment_history: employment,
    },
    domain: get("domain"),
    company: get("company"),
    added_at: get("added_at"),
  };
}

function dedupKey(person) {
  const id = person.id ? `id:${String(person.id).toLowerCase()}` : "";
  const email = person.email ? `em:${String(person.email).toLowerCase()}` : "";
  return id || email || "";
}

// --- Sheets access ---------------------------------------------------------

export async function getAccessToken(overrides = {}) {
  const { accessToken } = await getSheetsAccessToken(overrides);
  return accessToken;
}

async function getSpreadsheetTabs(accessToken, spreadsheetId) {
  // Direct REST read of sheet metadata (older sheets-api.mjs has no meta
  // helper). Read-only; does not mutate the spreadsheet.
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Sheets metadata read failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return (json.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
}

async function addTab(accessToken, spreadsheetId, title) {
  // Direct REST spreadsheets:batchUpdate addSheet — self-contained so we don't
  // depend on batchUpdateSpreadsheet (absent in the older sheets-api.mjs).
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    }
  );
  if (!res.ok) {
    throw new Error(`Sheets addSheet failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function ensurePoolTab(accessToken, spreadsheetId) {
  const tabs = await getSpreadsheetTabs(accessToken, spreadsheetId);
  const created = !tabs.includes(POOL_TAB);
  if (created) {
    await addTab(accessToken, spreadsheetId, POOL_TAB);
  }
  // Ensure header row is present/correct (idempotent).
  const existing = await getSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A1:N1`);
  const headerRow = existing?.values?.[0] ?? [];
  const headerOk =
    headerRow.length === SHARED_POOL_HEADERS.length &&
    SHARED_POOL_HEADERS.every((h, i) => headerRow[i] === h);
  if (!headerOk) {
    await updateSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A1`, [SHARED_POOL_HEADERS]);
  }
  return { created, headerWritten: !headerOk };
}

async function readAllRecords(accessToken, spreadsheetId) {
  let values;
  try {
    values = await getSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:N`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) return [];
    throw err;
  }
  const rows = values?.values ?? [];
  if (rows.length < 2) return [];
  return rows.slice(1).map(rowToRecord);
}

// --- public API ------------------------------------------------------------

export async function getCompanyContacts(
  accessToken,
  spreadsheetId,
  { domain, company, maxAgeDays } = {}
) {
  const wantDomain = normDomain(domain);
  const wantCompany = company ? String(company).trim().toLowerCase() : "";
  const cutoff =
    maxAgeDays && Number(maxAgeDays) > 0
      ? Date.now() - Number(maxAgeDays) * 24 * 60 * 60 * 1000
      : null;

  const records = await readAllRecords(accessToken, spreadsheetId);
  const matched = [];
  const seen = new Set();
  for (const rec of records) {
    const domainMatch = wantDomain && rec.domain === wantDomain;
    const companyMatch = wantCompany && String(rec.company).toLowerCase() === wantCompany;
    if (!domainMatch && !companyMatch) continue;
    if (cutoff) {
      const t = Date.parse(rec.added_at);
      if (Number.isFinite(t) && t < cutoff) continue;
    }
    const key = dedupKey(rec.person);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    matched.push(rec);
  }
  return matched;
}

export async function putContacts(accessToken, spreadsheetId, { domain, company }, people) {
  await ensurePoolTab(accessToken, spreadsheetId);
  const existing = await readAllRecords(accessToken, spreadsheetId);
  const existingKeys = new Set(existing.map((r) => dedupKey(r.person)).filter(Boolean));

  const toAppend = [];
  const batchKeys = new Set();
  let skipped = 0;
  for (const person of people) {
    if (!person || (!person.id && !person.email)) {
      skipped += 1;
      continue;
    }
    const key = dedupKey(person);
    if (key && (existingKeys.has(key) || batchKeys.has(key))) {
      skipped += 1;
      continue;
    }
    if (key) batchKeys.add(key);
    toAppend.push(toRow(person, { domain, company }));
  }

  if (toAppend.length) {
    await appendSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:N`, toAppend);
  }
  return { pushed: toAppend.length, alreadyPresent: skipped };
}
