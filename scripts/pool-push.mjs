#!/usr/bin/env node
// Shared pool PUSH — after enriching contacts with Apollo, push them to the
// shared pool so the next friend who targets this company can skip Apollo.
//
// Reads an enrich JSON (the output of apollo-rest-enrich-person.mjs) and
// appends its contacts to the shared Contacts sheet, deduped by apollo_id /
// email. Nothing identifying the caller is stored.
//
// Usage:
//   node scripts/pool-push.mjs --enrich output/enrich/<slug>.json \
//     [--domain company.com] [--company "Name"]
//
// If --domain / --company are omitted they are inferred from the contacts
// (dominant email domain; most common organization_name).
//
// Exit codes: 0 = ok (even if 0 new), 2 = pool not configured, 1 = error.

import fs from "node:fs/promises";
import {
  getSharedPoolId,
  getAccessToken,
  putContacts,
  normDomain,
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

// Defensive: tolerate either version's enrich output. Accept {results:[{person}]},
// a bare array of people, or {people:[...]}.
function extractPeople(data) {
  const rawList = Array.isArray(data)
    ? data
    : data?.results ?? data?.people ?? data?.candidates ?? [];
  const people = [];
  for (const item of rawList) {
    const p = item?.person ?? item;
    if (!p || typeof p !== "object") continue;
    if (item?.ok === false) continue;
    if (!p.id && !p.email) continue;
    people.push({
      id: p.id ?? null,
      name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
      title: p.title ?? null,
      email: p.email ?? null,
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
  return people;
}

function inferDomain(people) {
  const counts = new Map();
  for (const p of people) {
    const m = String(p.email || "").split("@")[1];
    if (!m) continue;
    const d = normDomain(m);
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

function inferCompany(people) {
  const counts = new Map();
  for (const p of people) {
    const c = p.organization_name;
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = getSharedPoolId();
  if (!spreadsheetId) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }

  const enrichPath = args.enrich;
  if (!enrichPath) {
    console.error("required: --enrich output/enrich/<slug>.json");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(await fs.readFile(enrichPath, "utf8"));
  } catch (err) {
    console.error(`cannot read ${enrichPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Don't re-push a file that came straight from the pool.
  if (data?.source === "shared_pool") {
    console.log("this enrich file was produced by pool-lookup (source=shared_pool) — nothing new to push");
    process.exit(0);
  }

  const people = extractPeople(data);
  if (!people.length) {
    console.log(`no usable contacts found in ${enrichPath} — nothing to push`);
    process.exit(0);
  }

  const domain = args.domain ? normDomain(args.domain) : inferDomain(people);
  const company = args.company || inferCompany(people);
  if (!domain && !company) {
    console.error("could not infer --domain or --company from the contacts; pass one explicitly");
    process.exit(1);
  }

  const accessToken = await getAccessToken(args);
  const res = await putContacts(accessToken, spreadsheetId, { domain, company }, people);
  console.log(
    `pushed ${res.pushed} new, ${res.alreadyPresent} already present -> ${company || domain} (${domain})`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
