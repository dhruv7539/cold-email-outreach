#!/usr/bin/env node
// Apollo REST direct people search.
// Bypasses the broken user-apollo MCP `apollo_search_people` wrapper by
// hitting Apollo's /api/v1/mixed_people/api_search endpoint directly.
//
// Efficiency defaults:
//   - `contact_email_status=["verified"]` applied by default (pre-filters
//     out contacts Apollo won't be able to enrich with a verified email).
//     Pass --include-unverified to disable.
//   - Target-driven pagination: pass --target N to stop paginating as soon
//     as N verified-email candidates have been collected.
//   - Team-match ranking: pass --rank-keywords "term1,term2" to score each
//     candidate by how many terms appear in their title + headline, then
//     sort the pool so on-team contacts win the --target slots. When ranking
//     is active the script paginates the FULL pool (up to --max-pages) before
//     slicing, so it makes a few more masked-search requests (no extra enrich
//     credits). Composes with --keywords (server-side q_keywords) — e.g.
//     --keywords "GM Financial" + --rank-keywords "data platform,event streams".
//
// Usage:
//   node scripts/apollo-rest-search-people.mjs \
//     --domains garmin.com \
//     --titles "software engineer,devops engineer,cloud engineer" \
//     --locations "Boulder, Colorado" \
//     --target 15 \
//     --rank-keywords "developer productivity,build,bazel" \
//     --output output/discovery/<jd-slug>-bucketC.json
//
// Requires APOLLO_API_KEY in env (or in .env at repo root).
//
// Output: normalized JSON with total_entries + people[] containing
//   { id, first_name, last_name_obfuscated, title, headline, has_email,
//     organization_name } (plus match_score when --rank-keywords is set).
// (last names masked; use apollo-rest-enrich-person.mjs with --ids to unmask.)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const endpoint = "https://api.apollo.io/api/v1/mixed_people/api_search";
const MAX_PER_PAGE = 100;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
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

function splitList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadDotEnv() {
  const envPath = path.join(repoRoot, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // no .env, fine
  }
}

async function searchPage({ apiKey, body }) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Apollo ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function normalize(p) {
  return {
    id: p.id,
    first_name: p.first_name,
    last_name_obfuscated: p.last_name_obfuscated,
    title: p.title,
    // `headline` is where team / org-unit membership usually shows up
    // (e.g. "AI Tooling & Developer Productivity"). Surfacing it lets us
    // rank by team match from discovery output without burning enrich calls.
    headline: p.headline ?? null,
    has_email: p.has_email === true,
    organization_name: p.organization?.name ?? null,
  };
}

// Score a person by how many ranking terms appear in their title + headline.
// Used by --rank-keywords to float same-team contacts to the top of the slice.
function scoreByKeywords(person, rankKeywords) {
  if (!rankKeywords.length) return 0;
  const hay = `${person.title ?? ""} ${person.headline ?? ""}`.toLowerCase();
  return rankKeywords.reduce((n, kw) => (hay.includes(kw) ? n + 1 : n), 0);
}

async function main() {
  await loadDotEnv();
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY missing (add to .env)");

  const args = parseArgs(process.argv.slice(2));

  const baseBody = {};
  const domains = splitList(args.domains);
  const titles = splitList(args.titles);
  const locations = splitList(args.locations);
  const seniorities = splitList(args.seniority);
  const departments = splitList(args.departments);

  if (domains.length) baseBody.q_organization_domains_list = domains;
  if (titles.length) baseBody.person_titles = titles;
  if (locations.length) baseBody.person_locations = locations;
  if (seniorities.length) baseBody.person_seniorities = seniorities;
  if (departments.length) baseBody.person_department_or_subdepartments = departments;
  if (args.keywords) baseBody.q_keywords = args.keywords;

  // Default to verified-email-only. Pre-filtering at search time avoids
  // burning enrich calls on contacts Apollo can't deliver an email for.
  if (args["include-unverified"] !== "true") {
    baseBody.contact_email_status = ["verified"];
  }

  const target = args.target ? Number(args.target) : null;
  const perPage = Math.min(
    Number(args["per-page"] ?? target ?? 25),
    MAX_PER_PAGE
  );
  const startPage = Number(args.page ?? 1);

  // Client-side team-match ranking. When set, we paginate the full pool
  // (up to --max-pages) before ranking + slicing, so the best-matching
  // contacts win the slots rather than whoever happened to page in first.
  const rankKeywords = splitList(args["rank-keywords"]).map((s) =>
    s.toLowerCase()
  );

  const collected = [];
  let totalEntries = 0;
  let page = startPage;
  const maxPages = Number(args["max-pages"] ?? 4);

  while (true) {
    const body = { ...baseBody, per_page: perPage, page };
    const json = await searchPage({ apiKey, body });
    totalEntries = json.total_entries ?? 0;
    const people = (json.people ?? []).map(normalize);
    for (const p of people) {
      if (p.has_email) collected.push(p);
    }

    // Stop: target met (only when NOT ranking — ranking needs the full pool),
    // no more results, or hit max pages.
    if (!rankKeywords.length && target && collected.length >= target) break;
    if (people.length < perPage) break;
    if (page - startPage + 1 >= maxPages) break;
    page += 1;
  }

  // Rank by team-keyword match (stable: ties keep discovery order).
  let ranked = collected;
  if (rankKeywords.length) {
    ranked = collected
      .map((p, i) => ({ p, i, score: scoreByKeywords(p, rankKeywords) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ p, score }) => ({ ...p, match_score: score }));
  }

  const finalPeople = target ? ranked.slice(0, target) : ranked;

  const out = {
    total_entries: totalEntries,
    target: target ?? null,
    pages_fetched: page - startPage + 1,
    per_page: perPage,
    returned: finalPeople.length,
    filter_verified: baseBody.contact_email_status?.[0] === "verified",
    ranked_by: rankKeywords.length ? rankKeywords : null,
    people: finalPeople,
  };

  if (args.output) {
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, JSON.stringify(out, null, 2));
    console.log(
      `wrote ${finalPeople.length} verified-email candidates (of ${totalEntries} total matches, ${out.pages_fetched} page(s)) to ${args.output}`
    );
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
