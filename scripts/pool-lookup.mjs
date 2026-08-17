#!/usr/bin/env node
// Shared pool LOOKUP — check the shared contact pool for a company BEFORE
// spending Apollo credits. On a hit, writes output/enrich/<slug>.json in the
// SAME shape apollo-rest-enrich-person.mjs produces, so the rest of the
// pipeline consumes it unchanged (select 4-6 -> briefs -> spec).
//
// Policy is SUPPLEMENT: a hit gives you the pooled contacts; if they don't
// cover the team you need, still run the normal Apollo buckets and pool-push
// the new finds afterward.
//
// Usage:
//   node scripts/pool-lookup.mjs --domain company.com [--company "Name"] \
//     [--slug my-slug] [--output output/enrich/my-slug.json] [--max-age-days 120]
//
// Exit codes: 0 = hit (file written), 3 = miss, 2 = pool not configured, 1 = error.

import fs from "node:fs/promises";
import path from "node:path";
import {
  getSharedPoolId,
  getAccessToken,
  getCompanyContacts,
} from "./shared-pool.mjs";

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

function ageDays(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = getSharedPoolId();
  if (!spreadsheetId) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }

  const domain = args.domain;
  const company = args.company;
  if (!domain && !company) {
    console.error("required: --domain company.com (and/or --company \"Name\")");
    process.exit(1);
  }

  const accessToken = await getAccessToken(args);
  const records = await getCompanyContacts(accessToken, spreadsheetId, {
    domain,
    company,
    maxAgeDays: args["max-age-days"],
  });

  if (!records.length) {
    console.log(`pool MISS: ${domain || company} not in shared pool -> run Apollo discovery/enrich`);
    process.exit(3);
  }

  const slug = args.slug || (domain ? domain.replace(/\./g, "-") : String(company).toLowerCase().replace(/\s+/g, "-"));
  const outPath = args.output || path.join("output", "enrich", `${slug}.json`);

  const results = records.map((r) => ({
    id: r.person.id,
    ok: true,
    cached: true,
    person: r.person,
  }));
  const out = {
    requested: results.length,
    kept: results.length,
    cache_hits: results.length,
    http_calls: 0,
    dropped_unverified: 0,
    skipped_due_to_queue: 0,
    source: "shared_pool",
    results,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2));

  console.log(`pool HIT: ${records.length} contact(s) for ${domain || company} -> wrote ${outPath} (skip Apollo)`);
  for (const r of records) {
    const p = r.person;
    const age = ageDays(r.added_at);
    const loc = [p.city, p.state, p.country].filter(Boolean).join(", ");
    console.log(
      `  ${p.name || "?"} | ${p.title || "?"} | ${p.email || "?"} (${p.email_status || "?"}) | ${loc}${age !== null ? ` | ${age}d old` : ""}`
    );
  }
  console.log(
    "\nSUPPLEMENT: if these don't cover the team you need, run the normal Apollo buckets and pool-push the new finds."
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
