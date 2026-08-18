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
// Columns 0-13 are the original contact schema (kept in the same order for
// backward compatibility). Columns 14-17 are the ADDITIVE outcome layer:
//   reply_status        — best/highest reply signal any friend ever got from
//                         this contact (the anonymous "gist": a category only,
//                         never the reply text). See REPLY_RANK.
//   do_not_send         — "yes" once this email bounced or opted out; the send
//                         pipeline must skip it.
//   dns_reason          — short, non-identifying reason (e.g. "bounce",
//                         "opt_out"). No sender identity, no message content.
//   outcome_updated_at  — ISO timestamp of the last outcome merge.
//   sent_weeks          — collision avoidance. Comma-separated list of the
//                         Monday-dates of weeks in which SOMEONE in the pool
//                         emailed this contact. Deliberately bucketed to the
//                         week so a batch of rows can't be fingerprinted back
//                         to one person's campaign, and stored as a set so
//                         re-syncing is idempotent. Count = outreach waves,
//                         max = most recent touch.
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
  "reply_status",
  "do_not_send",
  "dns_reason",
  "outcome_updated_at",
  "sent_weeks",
];

// Briefs live in their own tab, keyed by contact email. A brief is RESEARCH
// ABOUT THE CONTACT only — the writer's candidate-specific pitch sections are
// stripped before sharing (see pool-push-briefs.mjs).
export const BRIEFS_TAB = "Briefs";
export const BRIEF_HEADERS = [
  "email",
  "apollo_id",
  "domain",
  "company",
  "name",
  "title",
  "brief_md",
  "updated_at",
];

// Reply signals, ranked low -> high. When merging outcomes from many friends we
// keep the HIGHEST-value signal ever seen for a contact.
export const REPLY_RANK = {
  "": 0,
  auto_reply: 1,
  unclear: 2,
  negative: 3,
  referral: 4,
  positive: 5,
};

// A1 column letter for a 1-based column index (1 -> A, 27 -> AA).
export function colLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const LAST_COL = colLetter(SHARED_POOL_HEADERS.length);
const OUTCOME_START = SHARED_POOL_HEADERS.indexOf("reply_status"); // 0-based
const OUTCOME_WIDTH = SHARED_POOL_HEADERS.length - OUTCOME_START;
const OUTCOME_FIRST_COL = colLetter(OUTCOME_START + 1); // "O"
const OUTCOME_LAST_COL = LAST_COL; // last outcome column
const BRIEF_LAST_COL = colLetter(BRIEF_HEADERS.length);

// Monday (UTC) of the week containing `d`, as YYYY-MM-DD. Used to bucket send
// dates so individual campaigns can't be fingerprinted.
export function weekStart(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = (date.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  const mon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - offset);
  return mon.toISOString().slice(0, 10);
}

function parseWeeks(cell) {
  return String(cell || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Keep the set bounded so the cell can't grow without limit.
const MAX_WEEKS = 12;
function mergeWeeks(existing, incoming) {
  const set = new Set([...parseWeeks(existing), ...(incoming ?? []).filter(Boolean)]);
  return [...set].sort().slice(-MAX_WEEKS).join(",");
}

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
    // Outcome layer starts empty for a freshly discovered contact.
    person.reply_status ?? "",
    person.do_not_send ?? "",
    person.dns_reason ?? "",
    "",
    "",
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
    reply_status: get("reply_status") || "",
    do_not_send: String(get("do_not_send") || "").toLowerCase() === "yes",
    dns_reason: get("dns_reason") || "",
    outcome_updated_at: get("outcome_updated_at") || "",
    sent_weeks: parseWeeks(get("sent_weeks")),
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

// Create `tab` if absent and make sure row 1 matches `headers`. Rewriting the
// header row is also how an older, narrower pool MIGRATES to a newer schema:
// existing rows keep their data and simply gain blank trailing cells.
async function ensureTab(accessToken, spreadsheetId, tab, headers) {
  const tabs = await getSpreadsheetTabs(accessToken, spreadsheetId);
  const created = !tabs.includes(tab);
  if (created) {
    await addTab(accessToken, spreadsheetId, tab);
  }
  const lastCol = colLetter(headers.length);
  const existing = await getSheetValues(accessToken, spreadsheetId, `${tab}!A1:${lastCol}1`);
  const headerRow = existing?.values?.[0] ?? [];
  const headerOk =
    headerRow.length === headers.length && headers.every((h, i) => headerRow[i] === h);
  if (!headerOk) {
    await updateSheetValues(accessToken, spreadsheetId, `${tab}!A1`, [headers]);
  }
  return { created, headerWritten: !headerOk };
}

export async function ensurePoolTab(accessToken, spreadsheetId) {
  return ensureTab(accessToken, spreadsheetId, POOL_TAB, SHARED_POOL_HEADERS);
}

export async function ensureBriefsTab(accessToken, spreadsheetId) {
  return ensureTab(accessToken, spreadsheetId, BRIEFS_TAB, BRIEF_HEADERS);
}

async function readAllRecords(accessToken, spreadsheetId) {
  let values;
  try {
    values = await getSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:${LAST_COL}`);
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
    await appendSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:${LAST_COL}`, toAppend);
  }
  return { pushed: toAppend.length, alreadyPresent: skipped };
}

// --- outcomes (replies + do-not-send) --------------------------------------

// Merge a batch of per-email outcome signals into the pool. `outcomes` is an
// array of { email, reply_status?, do_not_send?, dns_reason? }. Merge rules:
//   - reply_status: keep the HIGHEST-ranked signal ever seen (REPLY_RANK).
//   - do_not_send : sticky — once "yes", stays "yes".
//   - dns_reason  : first non-empty reason wins.
// Existing contacts are updated in place (one bulk write of the outcome
// columns). Signals for emails not yet in the pool are appended as minimal
// rows so a bounce/opt-out is still honored even without full contact detail.
// Nothing about WHO observed the outcome is stored.
export async function applyOutcomes(accessToken, spreadsheetId, outcomes) {
  await ensurePoolTab(accessToken, spreadsheetId);
  const raw = await getSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:${LAST_COL}`);
  const rows = raw?.values ?? [];
  const data = rows.slice(1); // drop header

  const emailIdx = SHARED_POOL_HEADERS.indexOf("email");
  const rIdx = SHARED_POOL_HEADERS.indexOf("reply_status") - OUTCOME_START;
  const dnsIdx = SHARED_POOL_HEADERS.indexOf("do_not_send") - OUTCOME_START;
  const reasonIdx = SHARED_POOL_HEADERS.indexOf("dns_reason") - OUTCOME_START;
  const updIdx = SHARED_POOL_HEADERS.indexOf("outcome_updated_at") - OUTCOME_START;
  const weeksIdx = SHARED_POOL_HEADERS.indexOf("sent_weeks") - OUTCOME_START;

  // Seed the outcome matrix from the current sheet values so we never clobber
  // signals already recorded by someone else.
  const matrix = data.map((row) =>
    Array.from({ length: OUTCOME_WIDTH }, (_, k) => row[OUTCOME_START + k] ?? "")
  );

  const emailToRows = new Map();
  data.forEach((row, i) => {
    const em = String(row[emailIdx] ?? "").trim().toLowerCase();
    if (!em) return;
    if (!emailToRows.has(em)) emailToRows.set(em, []);
    emailToRows.get(em).push(i);
  });

  const now = new Date().toISOString();
  let updated = 0;
  const missing = new Map(); // email -> merged outcome for a new row

  const mergeInto = (cur, o) => {
    let changed = false;
    if (o.reply_status && REPLY_RANK[o.reply_status] > (REPLY_RANK[cur[rIdx]] ?? 0)) {
      cur[rIdx] = o.reply_status;
      changed = true;
    }
    if (o.do_not_send && String(cur[dnsIdx]).toLowerCase() !== "yes") {
      cur[dnsIdx] = "yes";
      changed = true;
    }
    if (o.dns_reason && !cur[reasonIdx]) {
      cur[reasonIdx] = o.dns_reason;
      changed = true;
    }
    if (o.sent_weeks?.length) {
      const merged = mergeWeeks(cur[weeksIdx], o.sent_weeks);
      if (merged !== cur[weeksIdx]) {
        cur[weeksIdx] = merged;
        changed = true;
      }
    }
    if (changed) cur[updIdx] = now;
    return changed;
  };

  for (const o of outcomes) {
    const em = String(o.email ?? "").trim().toLowerCase();
    if (!em) continue;
    const rowIdxs = emailToRows.get(em);
    if (rowIdxs && rowIdxs.length) {
      for (const i of rowIdxs) if (mergeInto(matrix[i], o)) updated += 1;
    } else {
      const cur = missing.get(em) ?? new Array(OUTCOME_WIDTH).fill("");
      mergeInto(cur, o);
      missing.set(em, cur);
    }
  }

  // One bulk write of the outcome columns for existing rows.
  if (data.length) {
    await updateSheetValues(
      accessToken,
      spreadsheetId,
      `${POOL_TAB}!${OUTCOME_FIRST_COL}2:${OUTCOME_LAST_COL}${data.length + 1}`,
      matrix
    );
  }

  // Append minimal rows for emails not present in the pool.
  const newRows = [];
  for (const [em, cur] of missing) {
    const domain = normDomain(em.split("@")[1] || "");
    const row = new Array(SHARED_POOL_HEADERS.length).fill("");
    row[SHARED_POOL_HEADERS.indexOf("domain")] = domain;
    row[emailIdx] = em;
    row[SHARED_POOL_HEADERS.indexOf("employment_json")] = "[]";
    row[SHARED_POOL_HEADERS.indexOf("added_at")] = now;
    for (let k = 0; k < OUTCOME_WIDTH; k += 1) row[OUTCOME_START + k] = cur[k];
    row[OUTCOME_START + updIdx] = now;
    newRows.push(row);
  }
  if (newRows.length) {
    await appendSheetValues(accessToken, spreadsheetId, `${POOL_TAB}!A:${LAST_COL}`, newRows);
  }

  return { updated, added: newRows.length };
}

// --- shared contact briefs --------------------------------------------------

async function readBriefRows(accessToken, spreadsheetId) {
  let res;
  try {
    res = await getSheetValues(accessToken, spreadsheetId, `${BRIEFS_TAB}!A:${BRIEF_LAST_COL}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) return [];
    throw err;
  }
  const rows = res?.values ?? [];
  return rows.length > 1 ? rows.slice(1) : [];
}

function briefRowToRecord(row) {
  const get = (name) => row[BRIEF_HEADERS.indexOf(name)] ?? "";
  return {
    email: String(get("email")).trim().toLowerCase(),
    apollo_id: get("apollo_id"),
    domain: get("domain"),
    company: get("company"),
    name: get("name"),
    title: get("title"),
    brief_md: get("brief_md"),
    updated_at: get("updated_at"),
  };
}

// Fetch pooled briefs for a set of emails -> Map(email -> record).
export async function getBriefsForEmails(accessToken, spreadsheetId, emails) {
  const want = new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean));
  if (!want.size) return new Map();
  const out = new Map();
  for (const row of await readBriefRows(accessToken, spreadsheetId)) {
    const rec = briefRowToRecord(row);
    if (!rec.email || !want.has(rec.email) || !rec.brief_md) continue;
    if (!out.has(rec.email)) out.set(rec.email, rec);
  }
  return out;
}

// Upsert briefs (keyed by email). Existing briefs are kept unless `force`, so a
// re-run never churns someone else's better research.
export async function putBriefs(accessToken, spreadsheetId, briefs, { force = false } = {}) {
  await ensureBriefsTab(accessToken, spreadsheetId);
  const rows = await readBriefRows(accessToken, spreadsheetId);
  const emailIdx = BRIEF_HEADERS.indexOf("email");
  const rowByEmail = new Map();
  rows.forEach((row, i) => {
    const em = String(row[emailIdx] ?? "").trim().toLowerCase();
    if (em && !rowByEmail.has(em)) rowByEmail.set(em, i);
  });

  const now = new Date().toISOString();
  const toAppend = [];
  const seen = new Set();
  let replaced = 0;
  let skipped = 0;

  for (const b of briefs) {
    const em = String(b.email || "").trim().toLowerCase();
    if (!em || !b.brief_md) {
      skipped += 1;
      continue;
    }
    if (seen.has(em)) {
      skipped += 1;
      continue;
    }
    seen.add(em);
    const row = new Array(BRIEF_HEADERS.length).fill("");
    const set = (name, v) => {
      row[BRIEF_HEADERS.indexOf(name)] = v ?? "";
    };
    set("email", em);
    set("apollo_id", b.apollo_id);
    set("domain", normDomain(b.domain || em.split("@")[1] || ""));
    set("company", b.company);
    set("name", b.name);
    set("title", b.title);
    set("brief_md", b.brief_md);
    set("updated_at", now);

    const existingIdx = rowByEmail.get(em);
    if (existingIdx === undefined) {
      toAppend.push(row);
    } else if (force) {
      await updateSheetValues(
        accessToken,
        spreadsheetId,
        `${BRIEFS_TAB}!A${existingIdx + 2}:${BRIEF_LAST_COL}${existingIdx + 2}`,
        [row]
      );
      replaced += 1;
    } else {
      skipped += 1;
    }
  }

  if (toAppend.length) {
    await appendSheetValues(
      accessToken,
      spreadsheetId,
      `${BRIEFS_TAB}!A:${BRIEF_LAST_COL}`,
      toAppend
    );
  }
  return { pushed: toAppend.length, replaced, skipped };
}
