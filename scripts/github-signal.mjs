#!/usr/bin/env node
// GitHub-signal fetcher for engineering targets.
//
// Given a person's name (and optionally their work email, company, or
// LinkedIn URL), this script tries to find their GitHub profile and pulls
// a handful of concrete engineering signals we can use as email hooks:
//
//   - github_username + profile URL
//   - top_repo (by stars) with star count and short description
//   - last_commit_date (most recent push across their ~10 latest repos)
//   - recent_languages (aggregated bytes across recent repos, top 3)
//
// This runs unauthenticated by default (60 req/hr). Set GITHUB_TOKEN in env
// to get the 5000 req/hr auth'd rate — recommended when fetching signals for
// a full batch of contacts.
//
// Usage:
//   node scripts/github-signal.mjs --name "Nicholas Simon" --company Garmin
//   node scripts/github-signal.mjs --email nick@garmin.com
//   node scripts/github-signal.mjs --name "Dhruv Bhanderi" --output signal.json
//
// Module usage:
//   import { findGithubSignal } from "./github-signal.mjs";
//   const s = await findGithubSignal({ name, company, email });
//   // s === null if no plausible match found

const GH_API = "https://api.github.com";
const USER_AGENT = "automate-emails-signal-fetcher/1.0";

function ghHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function ghFetch(pathname, { searchParams } = {}) {
  const url = new URL(pathname, GH_API);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub rate-limited (HTTP ${res.status}, remaining=${remaining}). Set GITHUB_TOKEN for 5000 req/hr.`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url.pathname}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompany(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/,? (inc\.?|llc\.?|ltd\.?|co\.?|corp\.?|corporation|company)\b/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Scores a GitHub user's profile against what we know about the target.
// Higher = better. 0 = definite reject. Tuned so an exact-name + company
// match beats a loose name match with no other signal.
function scoreCandidate(profile, { targetName, targetCompany, targetLocation }) {
  let score = 0;
  const wantName = normalizeName(targetName);
  const wantCompany = normalizeCompany(targetCompany);
  const wantLocation = normalizeName(targetLocation);

  const profName = normalizeName(profile.name);
  const profLogin = normalizeName(profile.login);
  const profCompany = normalizeCompany(profile.company);
  const profBio = normalizeName(profile.bio);
  const profLocation = normalizeName(profile.location);

  if (wantName) {
    const nameTokens = wantName.split(" ").filter((t) => t.length >= 2);
    if (profName === wantName) {
      score += 5;
    } else if (profName && (profName.includes(wantName) || wantName.includes(profName))) {
      // Either direction is a useful signal: a target named "Dan Abramov" may
      // have his GitHub display name set to just "dan" — that's still a hit.
      // Score partial matches a bit lower than exact.
      score += profName.includes(wantName) ? 4 : 2;
    } else if (profName && nameTokens.every((t) => profName.includes(t))) {
      score += 3;
    } else if (profLogin && nameTokens.every((t) => profLogin.includes(t))) {
      score += 2;
    } else if (!profName) {
      score -= 1; // anonymous profile, less confident
    }
  }

  if (wantCompany) {
    if (profCompany && profCompany.includes(wantCompany)) score += 3;
    if (profBio && profBio.includes(wantCompany)) score += 1;
  }

  if (wantLocation && profLocation && profLocation.includes(wantLocation)) score += 1;

  // De-prioritize bots / org accounts / empty profiles.
  if (profile.type && profile.type !== "User") score -= 10;
  if (!profile.public_repos || profile.public_repos < 1) score -= 1;

  return score;
}

async function searchByEmail(email) {
  if (!email) return [];
  // GitHub no longer allows "in:email" search publicly; best we can do is
  // try users whose commit email exposes the domain, via the user-commit
  // search API. In practice this doesn't work unauthenticated, so we just
  // early-return and rely on name search. Kept as a hook for future auth.
  return [];
}

async function searchByName(name, company) {
  if (!name) return [];
  // Try a few search variants in order of specificity. GitHub's user-search
  // `fullname:` qualifier is an exact full-name match and is the most
  // reliable signal — it finds "gaearon" when you search `fullname:"dan
  // abramov"`. Fall back to looser name/login search if that returns empty.
  const collected = new Map();
  const push = (items) => {
    for (const it of items || []) {
      if (!collected.has(it.login)) collected.set(it.login, it);
    }
  };

  const queries = [
    name,
    company ? `${name} ${company}` : null,
  ].filter(Boolean);

  for (const q of queries) {
    if (collected.size >= 10) break;
    try {
      const results = await ghFetch("/search/users", {
        searchParams: { q, per_page: 5 },
      });
      push(results.items);
    } catch (err) {
      // Non-fatal — some variants may 422 on odd characters; we try the next.
      void err;
    }
  }
  return [...collected.values()];
}

async function hydrateProfile(login) {
  return ghFetch(`/users/${login}`);
}

async function fetchTopRepos(login, limit = 10) {
  // sort=updated returns most recently pushed; we then re-sort in memory by
  // stars to surface the signature project.
  const repos = await ghFetch(`/users/${login}/repos`, {
    searchParams: { sort: "updated", per_page: limit, type: "owner" },
  });
  return repos;
}

function summarizeRepos(repos) {
  if (!repos || !repos.length) return { top_repo: null, recent_languages: [], last_commit_date: null };

  const ownRepos = repos.filter((r) => !r.fork);
  const pool = ownRepos.length ? ownRepos : repos;

  const byStars = [...pool].sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  const top = byStars[0];

  const langCounts = new Map();
  for (const r of pool) {
    if (r.language) langCounts.set(r.language, (langCounts.get(r.language) || 0) + 1);
  }
  const recent_languages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);

  const latestPush = pool
    .map((r) => r.pushed_at)
    .filter(Boolean)
    .sort()
    .reverse()[0];

  return {
    top_repo: top
      ? {
          name: top.name,
          full_name: top.full_name,
          url: top.html_url,
          description: top.description || "",
          stars: top.stargazers_count || 0,
          language: top.language || null,
          is_fork: Boolean(top.fork),
        }
      : null,
    recent_languages,
    last_commit_date: latestPush || null,
  };
}

// Find a plausible GitHub profile for the given person. Returns null when
// no candidate scores above the confidence threshold — we prefer silence
// to a wrong-person hook in a cold email.
export async function findGithubSignal({
  name,
  email,
  company,
  location,
  linkedinUrl,
  minScore = 3,
  verbose = false,
} = {}) {
  if (!name && !email) return null;
  void linkedinUrl; // reserved — LinkedIn → GitHub extraction could go here later

  let candidates = [];
  try {
    candidates = await searchByEmail(email);
  } catch (err) {
    if (verbose) console.error(`email search failed: ${err.message}`);
  }
  if (!candidates.length && name) {
    try {
      candidates = await searchByName(name, company);
    } catch (err) {
      if (verbose) console.error(`name search failed: ${err.message}`);
      return null;
    }
  }
  if (!candidates.length) return null;

  // Hydrate the top few (search API returns sparse profiles). Score against
  // the target and pick the best. We hydrate at most 5 to keep API calls
  // bounded — typical name searches rank the correct user in the top 3.
  const HYDRATE_LIMIT = 5;
  const scored = [];
  for (const c of candidates.slice(0, HYDRATE_LIMIT)) {
    try {
      const profile = await hydrateProfile(c.login);
      const score = scoreCandidate(profile, {
        targetName: name,
        targetCompany: company,
        targetLocation: location,
      });
      scored.push({ profile, score });
      if (verbose) console.error(`  ${c.login}: score=${score}`);
    } catch (err) {
      if (verbose) console.error(`  ${c.login}: hydrate failed (${err.message})`);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < minScore) return null;

  const repos = await fetchTopRepos(best.profile.login);
  const repoSummary = summarizeRepos(repos);

  return {
    github_username: best.profile.login,
    github_url: best.profile.html_url,
    display_name: best.profile.name || null,
    company: best.profile.company || null,
    location: best.profile.location || null,
    bio: best.profile.bio || null,
    public_repos: best.profile.public_repos || 0,
    followers: best.profile.followers || 0,
    match_score: best.score,
    ...repoSummary,
  };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const signal = await findGithubSignal({
    name: args.name,
    email: args.email,
    company: args.company,
    location: args.location,
    linkedinUrl: args["linkedin-url"],
    minScore: args["min-score"] ? Number(args["min-score"]) : 3,
    verbose: args.verbose === "true",
  });
  const output = JSON.stringify(signal, null, 2);
  if (args.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(args.output, output);
  } else {
    process.stdout.write(output + "\n");
  }
  if (signal === null) process.exit(2);
}

import { pathToFileURL } from "node:url";
const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
