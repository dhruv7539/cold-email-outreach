#!/usr/bin/env node
// Shared pool BACKFILL — push every contact you've ever enriched (all
// output/enrich/*.json) into the shared pool in one shot. Run once when you
// join the pool so your whole history seeds it; safe to re-run (deduped).
//
// Reads the pool once, dedups in memory by apollo_id / email, and appends new
// rows in chunks. Only contacts that have an email are included. Nothing about
// who added a contact is stored.
//
// Usage:
//   node scripts/pool-backfill.mjs [--dir output/enrich] [--dry-run]
//
// Exit codes: 0 = ok, 2 = pool not configured, 1 = error.

import fs from "node:fs";
import path from "node:path";
import {
  getSharedPoolId,
  getAccessToken,
  ensurePoolTab,
  normDomain,
  colLetter,
  SHARED_POOL_HEADERS,
  POOL_TAB,
} from "./shared-pool.mjs";
import { getSheetValues, appendSheetValues } from "./sheets-api.mjs";

const LAST_COL = colLetter(SHARED_POOL_HEADERS.length);

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

function extractPeople(data) {
  const list = Array.isArray(data) ? data : data?.results ?? data?.people ?? data?.candidates ?? [];
  const out = [];
  for (const item of list) {
    const p = item?.person ?? item;
    if (!p || typeof p !== "object") continue;
    if (item?.ok === false) continue;
    const email = (p.email ?? "").trim();
    if (!email) continue;
    out.push({
      id: p.id ?? null,
      name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
      title: p.title ?? null,
      email,
      email_status: p.email_status ?? null,
      linkedin_url: p.linkedin_url ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      country: p.country ?? null,
      organization_name: p.organization_name ?? p.organization?.name ?? null,
      headline: p.headline ?? null,
      employment_history: p.employment_history ?? [],
    });
  }
  return out;
}

function inferCompany(people) {
  const counts = new Map();
  for (const p of people) {
    if (p.organization_name) counts.set(p.organization_name, (counts.get(p.organization_name) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
  return best;
}

function dedupKey(p) {
  if (p.id) return `id:${String(p.id).toLowerCase()}`;
  if (p.email) return `em:${String(p.email).toLowerCase()}`;
  return "";
}

function toRow(p, domain, company, now) {
  const row = new Array(SHARED_POOL_HEADERS.length).fill("");
  const set = (name, v) => { row[SHARED_POOL_HEADERS.indexOf(name)] = v ?? ""; };
  set("domain", domain);
  set("company", company || p.organization_name || "");
  set("apollo_id", p.id ?? "");
  set("name", p.name ?? "");
  set("title", p.title ?? "");
  set("email", p.email ?? "");
  set("email_status", p.email_status ?? "");
  set("linkedin_url", p.linkedin_url ?? "");
  set("city", p.city ?? "");
  set("state", p.state ?? "");
  set("country", p.country ?? "");
  set("headline", p.headline ?? "");
  set("employment_json", JSON.stringify(p.employment_history ?? []));
  set("added_at", now);
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const enrichDir = args.dir && args.dir !== "true" ? args.dir : path.join("output", "enrich");

  const sid = getSharedPoolId();
  if (!sid) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }
  if (!fs.existsSync(enrichDir)) {
    console.log(`no enrich dir at ${enrichDir} — nothing to backfill.`);
    return;
  }

  const accessToken = await getAccessToken(args);
  await ensurePoolTab(accessToken, sid);

  const existing = await getSheetValues(accessToken, sid, `${POOL_TAB}!A:${LAST_COL}`);
  const rows = existing?.values ?? [];
  const idIdx = SHARED_POOL_HEADERS.indexOf("apollo_id");
  const emIdx = SHARED_POOL_HEADERS.indexOf("email");
  const seen = new Set();
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const id = (r[idIdx] ?? "").trim();
    const em = (r[emIdx] ?? "").trim();
    if (id) seen.add(`id:${id.toLowerCase()}`);
    else if (em) seen.add(`em:${em.toLowerCase()}`);
  }
  const startingRows = Math.max(0, rows.length - 1);

  const files = fs.readdirSync(enrichDir).filter((f) => f.endsWith(".json")).sort();
  const toAppend = [];
  const now = new Date().toISOString();
  let withEmail = 0;
  let dup = 0;

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(enrichDir, file), "utf8"));
    } catch {
      continue;
    }
    if (data?.source === "shared_pool") continue;
    const people = extractPeople(data);
    const company = inferCompany(people);
    for (const p of people) {
      withEmail += 1;
      const key = dedupKey(p);
      if (!key || seen.has(key)) { dup += 1; continue; }
      seen.add(key);
      const domain = normDomain(String(p.email).split("@")[1] || "");
      toAppend.push(toRow(p, domain, company, now));
    }
  }

  console.log(
    `files=${files.length} | contacts-with-email=${withEmail} | unique-new=${toAppend.length} | duplicates-skipped=${dup} | pool-had=${startingRows}`
  );

  if (dryRun) {
    console.log("--dry-run: not writing.");
    return;
  }
  if (!toAppend.length) {
    console.log("nothing new to append.");
    return;
  }

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < toAppend.length; i += CHUNK) {
    const chunk = toAppend.slice(i, i + CHUNK);
    await appendSheetValues(accessToken, sid, `${POOL_TAB}!A:${LAST_COL}`, chunk);
    written += chunk.length;
    console.log(`  appended ${written}/${toAppend.length}`);
  }
  console.log("backfill done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
