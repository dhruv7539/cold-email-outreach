#!/usr/bin/env node
// Batch GitHub-signal fetcher — pre-spec personalization step.
//
// Reads an enrichment file (output/enrich/<slug>.json), runs findGithubSignal()
// over the engineering contacts (hiring managers + software engineers), and
// writes output/signals/<slug>.json. Use the result as the sentence-1 trigger
// in a spec when a contact has a confident GitHub match:
//   "I saw your work on <top_repo> (<lang>) ..." instead of a title restatement.
//
// Why title-based filtering? The enrich output doesn't carry contactType (that
// is assigned at spec-write time), so by default we only fetch signals for
// engineering-ish titles — recruiters rarely have a useful public GitHub and
// each lookup costs GitHub API calls. Pass --all to run over everyone.
//
// Usage:
//   node scripts/github-signals-batch.mjs --enrich output/enrich/<slug>.json
//   node scripts/github-signals-batch.mjs --enrich output/enrich/<slug>.json \
//     --out output/signals/<slug>.json --min-score 3
//   node scripts/github-signals-batch.mjs --enrich ... --all   # include recruiters
//
// Set GITHUB_TOKEN in env for the 5000 req/hr rate (recommended for batches).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findGithubSignal } from "./github-signal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Engineering-ish titles we run signals for by default (HM + SWE buckets).
const ENGINEERING_TITLE = /\b(engineer(?:ing)?|developer|swe|sde|architect|programmer|tech(?:nical)? lead|staff|principal|cto|vp eng|head of eng)\b/i;

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
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // no .env, fine — GITHUB_TOKEN is optional anyway.
  }
}

function deriveOutPath(enrichPath, explicit) {
  if (explicit) return explicit;
  const slug = path.basename(enrichPath).replace(/\.json$/i, "");
  return path.join(repoRoot, "output", "signals", `${slug}.json`);
}

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const enrichPath = args.enrich || args._?.[0];
  if (!enrichPath) {
    throw new Error(
      "Usage: node scripts/github-signals-batch.mjs --enrich output/enrich/<slug>.json [--out ...] [--min-score 3] [--all]"
    );
  }

  const raw = JSON.parse(await fs.readFile(enrichPath, "utf8"));
  const results = Array.isArray(raw) ? raw : raw.results || [];
  const minScore = args["min-score"] ? Number(args["min-score"]) : 3;
  const includeAll = args.all === "true";

  const people = results
    .filter((r) => r && r.ok !== false && r.person && r.person.name)
    .map((r) => r.person);

  const targets = includeAll
    ? people
    : people.filter((p) => ENGINEERING_TITLE.test(p.title || ""));

  const signals = {};
  let hits = 0;
  let misses = 0;

  // Sequential to stay within the GitHub rate limit (each contact triggers a
  // handful of API calls). With GITHUB_TOKEN this is comfortably under budget.
  for (const p of targets) {
    const key = (p.email || p.id || p.name).toString();
    const location = [p.city, p.state].filter(Boolean).join(", ") || null;
    let signal = null;
    try {
      signal = await findGithubSignal({
        name: p.name,
        email: p.email,
        company: p.organization_name,
        location,
        minScore,
      });
    } catch (err) {
      // Non-fatal: rate-limit or transient error. Record null and continue so
      // one bad lookup doesn't sink the whole batch.
      signal = null;
      console.error(`  ${p.name}: signal lookup failed (${err.message})`);
    }
    if (signal) hits += 1;
    else misses += 1;
    signals[key] = signal
      ? {
          name: p.name,
          title: p.title || null,
          ...signal,
        }
      : null;
  }

  const out = {
    generated_at: new Date().toISOString(),
    source: enrichPath,
    filter: includeAll ? "all" : "engineering_titles",
    min_score: minScore,
    considered: targets.length,
    hits,
    misses,
    signals,
  };

  const outPath = deriveOutPath(enrichPath, args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(
    `github signals: ${hits} hit / ${misses} miss of ${targets.length} considered -> ${outPath}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
