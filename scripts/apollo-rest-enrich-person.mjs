#!/usr/bin/env node
// Apollo REST enrich — unmask full contact details including verified email,
// LinkedIn URL, city/state, title, and employment history.
//
// Efficiency defaults:
//   - When --ids has >1 id, uses /people/bulk_match (up to 10 per HTTP call)
//     instead of looping /people/match. Cuts round-trips ~10x.
//   - Caches each enrichment on disk at output/cache/apollo/enrich/<id>.json
//     with 30-day TTL. Pass --no-cache to force fresh fetches (guarded).
//   - Pass --skip-emails email1,email2,... to drop ids already queued (so
//     Queue-sheet de-duping can be layered in upstream).
//
// Credit guardrails:
//   - --max-credits N: abort if we would fetch >N people from the API
//     (cache hits don't count). This prevents accidental large spends.
//   - --no-bulk: never call /people/bulk_match; loop /people/match instead.
//     (Smaller blast radius when credits are low.)
//   - --no-cache is refused unless --force-no-cache is also set.
//
// Usage:
//   Bulk by ids (most efficient):
//     node scripts/apollo-rest-enrich-person.mjs \
//       --ids id1,id2,id3,id4 \
//       --output output/enrich/<jd-slug>-batch.json
//
//   Single by LinkedIn URL or name+domain (cache still applied):
//     node scripts/apollo-rest-enrich-person.mjs --linkedin-url ...
//     node scripts/apollo-rest-enrich-person.mjs --first-name A --last-name B --domain c.com
//
// Requires APOLLO_API_KEY in env (or .env at repo root).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const matchEndpoint = "https://api.apollo.io/api/v1/people/match";
const bulkEndpoint = "https://api.apollo.io/api/v1/people/bulk_match";
const BULK_BATCH_SIZE = 10;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cacheDir = path.join(repoRoot, "output", "cache", "apollo", "enrich");

function parseIntArg(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "true") return null;
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

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

function normalize(person) {
  if (!person) return null;
  return {
    id: person.id,
    name: person.name,
    title: person.title,
    email: person.email ?? null,
    email_status: person.email_status ?? null,
    linkedin_url: person.linkedin_url ?? null,
    city: person.city ?? null,
    state: person.state ?? null,
    country: person.country ?? null,
    organization_name: person.organization?.name ?? person.organization_name ?? null,
    headline: person.headline ?? null,
    employment_history: (person.employment_history ?? []).slice(0, 8).map((e) => ({
      org: e.organization_name,
      title: e.title,
      start: e.start_date,
      end: e.end_date,
      current: e.current === true,
    })),
  };
}

async function readCache(id) {
  if (!id) return null;
  const p = path.join(cacheDir, `${id}.json`);
  try {
    const stat = await fs.stat(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(id, data) {
  if (!id) return;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${id}.json`), JSON.stringify(data, null, 2));
}

async function apolloFetch(endpoint, body, apiKey) {
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
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function idsToFetchWithCache(ids, { useCache }) {
  if (!useCache) return [...ids];
  const idsToFetch = [];
  for (const id of ids) {
    const cached = await readCache(id);
    if (!cached) idsToFetch.push(id);
  }
  return idsToFetch;
}

async function enrichBulkByIds(ids, apiKey, { useCache }) {
  const results = new Map();
  const idsToFetch = [];

  if (useCache) {
    for (const id of ids) {
      const cached = await readCache(id);
      if (cached) results.set(id, { ok: true, cached: true, person: cached });
      else idsToFetch.push(id);
    }
  } else {
    idsToFetch.push(...ids);
  }

  const httpCalls = [];
  for (let i = 0; i < idsToFetch.length; i += BULK_BATCH_SIZE) {
    const batch = idsToFetch.slice(i, i + BULK_BATCH_SIZE);
    const body = { details: batch.map((id) => ({ id })) };
    const json = await apolloFetch(bulkEndpoint, body, apiKey);
    httpCalls.push({ batch: i / BULK_BATCH_SIZE + 1, size: batch.length, status: json.status });
    for (const match of json.matches ?? []) {
      const normalized = normalize(match);
      const id = match.id;
      if (id) {
        results.set(id, { ok: true, cached: false, person: normalized });
        await writeCache(id, normalized);
      }
    }
    for (const id of batch) {
      if (!results.has(id)) {
        results.set(id, { ok: false, cached: false, error: "no match returned" });
      }
    }
  }

  return {
    results: ids.map((id) => ({ id, ...(results.get(id) ?? { ok: false, error: "missing" }) })),
    http_calls: httpCalls,
    cache_hits: ids.length - idsToFetch.length,
    fetched: idsToFetch.length,
  };
}

async function enrichByIdsSequential(ids, apiKey, { useCache }) {
  const results = new Map();
  const idsToFetch = [];
  const httpCalls = [];

  if (useCache) {
    for (const id of ids) {
      const cached = await readCache(id);
      if (cached) results.set(id, { ok: true, cached: true, person: cached });
      else idsToFetch.push(id);
    }
  } else {
    idsToFetch.push(...ids);
  }

  for (const id of idsToFetch) {
    const body = { id };
    const json = await apolloFetch(matchEndpoint, body, apiKey);
    httpCalls.push({ batch: httpCalls.length + 1, size: 1, status: "match" });
    const person = normalize(json.person);
    if (person?.id) {
      results.set(person.id, { ok: true, cached: false, person });
      await writeCache(person.id, person);
    } else {
      results.set(id, { ok: false, cached: false, error: "no match returned" });
    }
  }

  return {
    results: ids.map((id) => ({ id, ...(results.get(id) ?? { ok: false, error: "missing" }) })),
    http_calls: httpCalls,
    cache_hits: ids.length - idsToFetch.length,
    fetched: idsToFetch.length,
  };
}

async function enrichSingle(args, apiKey, { useCache }) {
  const body = {};
  if (args["linkedin-url"]) body.linkedin_url = args["linkedin-url"];
  if (args["first-name"]) body.first_name = args["first-name"];
  if (args["last-name"]) body.last_name = args["last-name"];
  if (args.domain) body.domain = args.domain;
  if (args["organization-name"]) body.organization_name = args["organization-name"];
  if (args["reveal-personal-emails"] === "true") body.reveal_personal_emails = true;
  if (args["reveal-phone"] === "true") body.reveal_phone_number = true;

  const json = await apolloFetch(matchEndpoint, body, apiKey);
  const person = normalize(json.person);
  if (useCache && person?.id) await writeCache(person.id, person);
  return person ? [{ id: person.id, ok: true, cached: false, person }] : [{ ok: false, error: "no match" }];
}

async function main() {
  await loadDotEnv();
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY missing (add to .env)");

  const args = parseArgs(process.argv.slice(2));
  const requestedNoCache = args["no-cache"] === "true";
  const forceNoCache = args["force-no-cache"] === "true";
  if (requestedNoCache && !forceNoCache) {
    throw new Error("Refusing --no-cache without --force-no-cache (prevents accidental credit spend).");
  }
  const useCache = !requestedNoCache;

  const maxCredits = parseIntArg(args["max-credits"], "--max-credits");
  if (maxCredits !== null && maxCredits < 0) throw new Error("--max-credits must be >= 0");
  const noBulk = args["no-bulk"] === "true";

  const skipEmails = new Set(
    (args["skip-emails"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const ids = args.ids
    ? args.ids.split(",").map((s) => s.trim()).filter(Boolean)
    : args.id
      ? [args.id]
      : [];

  let summary;
  let results;

  if (ids.length) {
    const idsToFetch = await idsToFetchWithCache(ids, { useCache });
    if (maxCredits !== null && idsToFetch.length > maxCredits) {
      throw new Error(
        `Refusing to enrich ${idsToFetch.length} people (cache misses) because --max-credits=${maxCredits}.`
      );
    }

    const out = noBulk
      ? await enrichByIdsSequential(ids, apiKey, { useCache })
      : await enrichBulkByIds(ids, apiKey, { useCache });
    results = out.results;
    summary = { http_calls: out.http_calls, cache_hits: out.cache_hits, fetched: out.fetched };
  } else if (args["linkedin-url"] || args["first-name"] || args["last-name"] || args.domain) {
    if (maxCredits !== null && maxCredits < 1 && !useCache) {
      throw new Error(`Refusing to enrich 1 person because --max-credits=${maxCredits}.`);
    }
    const single = await enrichSingle(args, apiKey, { useCache });
    results = single.map((r) => (r.id ? r : { id: null, ...r }));
    summary = { http_calls: [{ batch: 1, size: 1, status: "match" }], cache_hits: 0, fetched: 1 };
  } else {
    throw new Error("Need --ids, --id, --linkedin-url, or --first-name/--last-name/--domain");
  }

  // Apply filters
  const verifiedOnly = args["verified-only"] !== "false";
  const dedupCount = { skipped_due_to_queue: 0, dropped_unverified: 0 };

  const kept = [];
  for (const r of results) {
    if (!r.ok || !r.person) {
      kept.push(r);
      continue;
    }
    if (verifiedOnly && r.person.email_status !== "verified") {
      dedupCount.dropped_unverified += 1;
      continue;
    }
    if (r.person.email && skipEmails.has(r.person.email.toLowerCase())) {
      dedupCount.skipped_due_to_queue += 1;
      continue;
    }
    kept.push(r);
  }

  const out = {
    requested: results.length,
    kept: kept.length,
    cache_hits: summary.cache_hits,
    http_calls: summary.http_calls.length,
    dropped_unverified: dedupCount.dropped_unverified,
    skipped_due_to_queue: dedupCount.skipped_due_to_queue,
    results: kept,
  };

  if (args.output) {
    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.writeFile(args.output, JSON.stringify(out, null, 2));
    console.log(
      `enriched ${kept.length}/${results.length} (cache_hits=${summary.cache_hits}, http_calls=${summary.http_calls.length}, dropped_unverified=${dedupCount.dropped_unverified}, skipped_queue=${dedupCount.skipped_due_to_queue}) -> ${args.output}`
    );
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
