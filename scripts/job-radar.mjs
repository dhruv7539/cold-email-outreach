#!/usr/bin/env node
// Job Radar (2026-08-21) — multi-source, account-safe job discovery.
//
// Sources (see scripts/job-radar-sources.mjs + job-radar.config.json):
//   career    fantastic-jobs career-site actor (175k+ ATS/company sites) — runs
//             EVERY scheduled hour (cheap, timeRange="1h", 24h on morning sweep).
//   jobspy    openclawai/job-board-scraper — LinkedIn, Indeed, Glassdoor,
//             ZipRecruiter, Google Jobs in one run.
//   wellfound clearpath/wellfound-api-ppe — startups.
//   dice      blackfalcondata/dice-com-job-scraper — US tech.
//   handshake parsebird/handshake-jobs-scraper — public listings only.
//   jobright  jobscrawler/jobright-scraper — disabled (mock data as of 2026-08-21).
//
// The aggregator boards are pay-per-result + residential proxy, so they only run
// on config.sweepHours (2x/day by default). Every source is normalized to one
// shape, deduped across boards (same role on LinkedIn+Indeed+Dice collapses to
// one), filtered to the candidate's early-career profile, deduped against a
// 30-day seen-store (by id AND canonical key), and emailed as one ranked digest.
//
// Usage:
//   node scripts/job-radar.mjs                 # auto: career hourly, aggregators on sweep hours
//   node scripts/job-radar.mjs --sweep         # force the aggregator boards this run
//   node scripts/job-radar.mjs --only jobspy,dice --dry-run
//   node scripts/job-radar.mjs --time-range 24h --limit 300   # career window override
//   node scripts/job-radar.mjs --no-email --no-sheet
//
// Requires APIFY_TOKEN in .env (APIFY_API_KEY_BACKUP auto-used on limit).
// Reuses Gmail + Sheets OAuth already configured.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessToken, getDefaultOauthPaths, buildRawMessage, sendMessage } from "./gmail-api.mjs";
import {
  getSheetsAccessToken,
  getSpreadsheetMeta,
  batchUpdateSpreadsheet,
  appendSheetValues,
} from "./sheets-api.mjs";
import { createApifyTokenSession } from "./apify-token.mjs";
import { SOURCE_REGISTRY, canonicalKey } from "./job-radar-sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const seenPath = path.join(repoRoot, "output", "jobs", "seen.json");
const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CITIZEN_RE =
  /\b(u\.?s\.?\s*citizen(ship)?|must be a (u\.?s\.?\s*)?citizen|citizenship (is )?required|security clearance|active clearance|clearance required|ts\/sci|secret clearance|u\.?s\.?\s*person|green ?card required)\b/i;
const NO_SPONSOR_RE =
  /\b(no (visa )?sponsorship|not (able|willing) to sponsor|cannot sponsor|will not sponsor|unable to sponsor|without sponsorship|does not (provide |offer )?sponsor|sponsorship (is )?not (available|offered|provided))\b/i;

// Order sources run in; also the cross-source dedup preference (career first).
const SOURCE_ORDER = ["career", "linkedin", "dice", "indeed", "wellfound", "jobspy", "handshake", "jobright"];

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
    /* no .env */
  }
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

function hourInTz(tz) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return parseInt(s, 10) % 24;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function actorPath(actor) {
  return actor.replace("/", "~");
}

// ---- Apify run: async start -> poll -> fetch dataset (no 300s run-sync cap) --

async function startRun(actor, input, apify) {
  const buildUrl = (token) =>
    `https://api.apify.com/v2/acts/${actorPath(actor)}/runs?token=${encodeURIComponent(token)}`;
  const { text } = await apify.request(buildUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return JSON.parse(text).data;
}

async function pollRun(runId, apify, { maxMs = 280000, intervalMs = 4000 } = {}) {
  const start = Date.now();
  for (;;) {
    const buildUrl = (token) =>
      `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`;
    const { text } = await apify.request(buildUrl, {});
    const d = JSON.parse(text).data;
    const s = d.status;
    if (s === "SUCCEEDED") return d;
    if (["FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"].includes(s)) {
      throw new Error(`run ${s}: ${JSON.stringify(d.statusMessage || "").slice(0, 200)}`);
    }
    if (Date.now() - start > maxMs) {
      try {
        const abort = (token) =>
          `https://api.apify.com/v2/actor-runs/${runId}/abort?token=${encodeURIComponent(token)}`;
        await apify.request(abort, { method: "POST" });
      } catch {
        /* best-effort abort to stop billing */
      }
      throw new Error(`run poll timeout after ${maxMs}ms`);
    }
    await sleep(intervalMs);
  }
}

async function fetchDataset(datasetId, apify) {
  const items = [];
  const limit = 1000;
  let offset = 0;
  for (;;) {
    const buildUrl = (token) =>
      `https://api.apify.com/v2/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}&offset=${offset}&token=${encodeURIComponent(token)}`;
    const { text } = await apify.request(buildUrl, {});
    const chunk = JSON.parse(text);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    items.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return items;
}

async function runActor(actor, input, apify, opts = {}) {
  const run = await startRun(actor, input, apify);
  if (!run?.id) throw new Error("Apify: no run id returned");
  const done = await pollRun(run.id, apify, opts);
  if (!done.defaultDatasetId) return [];
  return fetchDataset(done.defaultDatasetId, apify);
}

// ---- filters (operate on the normalized job shape) -------------------------

function locationAllowed(n, cfg) {
  const allow = (cfg.query.countriesAllow || []).map((c) => c.toLowerCase());
  if ((n.countries || []).some((c) => allow.includes(c))) return true;
  if (cfg.query.includeRemote && n.remote) {
    const remoteLocs = n.remoteLocations || [];
    if (remoteLocs.length === 0) return true;
    return remoteLocs.some((loc) =>
      allow.some((a) => loc.includes(a) || loc.includes("united states") || loc.includes("usa"))
    );
  }
  return false;
}

function eligibility(n) {
  const hay = `${n.title || ""}\n${n.description || ""}`;
  if (CITIZEN_RE.test(hay)) return { ok: false, reason: "citizenship/clearance/US-person required" };
  return { ok: true };
}

// The career-site actor applies titleExclusionSearch server-side; the aggregator
// boards do not, so we re-apply it post-fetch against the normalized title to
// drop Senior/Staff/Lead/Manager/Intern/etc. for this early-career profile.
function buildExclusionRe(cfg) {
  const terms = [
    ...(cfg.query?.titleExclusionSearch || []),
    ...(cfg.query?.titleExclusionExtra || []),
  ]
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (!terms.length) return null;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|\\W)(${esc.join("|")})(\\W|$)`, "i");
}

// Positive title gate for the aggregator boards. Their keyword search fuzzy-
// matches, so a "software engineer" query also returns Data Science, Analyst,
// Helpdesk, and Land Development roles. A normalized title must contain at least
// one software-domain token to survive. Returns null (no gate) when unset.
function buildTitleRequireRe(cfg) {
  const terms = (cfg.query?.titleRequireAny || []).map((t) => String(t).trim()).filter(Boolean);
  if (!terms.length) return null;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|\\W)(${esc.join("|")})(\\W|$)`, "i");
}

function sponsorshipStatus(n) {
  if (n._visaField === true) return "yes";
  const hay = n.description || "";
  if (NO_SPONSOR_RE.test(hay)) return "no";
  return "unknown";
}

// Drop roles that REQUIRE a language the candidate does not speak. The candidate
// speaks the languages in cfg.query.candidateLanguages (english/hindi/gujarati);
// everything else in KNOWN_LANGUAGES is "foreign". Only a real requirement drops
// the role ("bilingual", "fluent/native/proficient in X", "must speak X",
// "X speaker/required", "X/English") — "Spanish a plus" still passes.
const KNOWN_LANGUAGES = [
  "korean", "mandarin", "cantonese", "chinese", "japanese", "spanish", "german",
  "french", "portuguese", "vietnamese", "tagalog", "italian", "russian", "arabic",
  "thai", "polish", "turkish", "dutch", "hebrew", "farsi", "persian", "urdu",
  "hindi", "gujarati", "english",
];

// Estimate the years of experience a role REQUIRES. A posting usually lists
// several requirements (an overall-experience line plus per-skill years); the
// candidate must satisfy ALL of them, so the binding requirement is the LARGEST
// stated minimum -- NOT the smallest. Returning the smallest let "Lead" roles
// leak (e.g. Apex listed "10+ years overall" AND "1+ years with AI tools"; the
// old min=1 kept it). Requirements phrased as optional/preferred are ignored.
// Ranges ("0-2 years") contribute their LOWER bound. Returns a number or null.
function requiredYears(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return null;
  let maxMin = null;
  const consider = (n) => {
    const v = Number(n);
    if (Number.isFinite(v) && v <= 40 && (maxMin === null || v > maxMin)) maxMin = v;
  };
  const optionalRe =
    /\b(a plus|plus\b|nice to have|nice-to-have|preferred|bonus|ideally|desirable|would be (great|nice)|is a plus|not required)\b/;
  // Context that marks a fragment as a real experience requirement (avoids
  // matching things like "10 years of company history").
  const ctxRe =
    /(experience|\bexp\b|professional|industry|hands-on|expertise|proficien|background|develop|engineering|programming|coding|leadership|software)/;
  // First number attached to a years unit, capturing "+", "or more", and ranges.
  const yearsRe =
    /(\d{1,2})\s*(?:\+|plus|or more|or greater)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?)?\s*(?:years?|yrs?)/g;
  for (const frag of s.split(/[\n;.]/)) {
    if (!frag.trim() || !/(years?|yrs?)/.test(frag)) continue;
    if (!ctxRe.test(frag)) continue;
    if (optionalRe.test(frag)) continue;
    let m;
    yearsRe.lastIndex = 0;
    while ((m = yearsRe.exec(frag))) consider(m[1]);
  }
  return maxMin;
}

function makeForeignLanguageTest(candidateLanguages) {
  const cand = new Set((candidateLanguages || ["english"]).map((s) => String(s).toLowerCase()));
  const foreign = KNOWN_LANGUAGES.filter((l) => !cand.has(l));
  if (!foreign.length) return () => false;
  const alt = foreign.join("|");
  const foreignRe = new RegExp(`\\b(?:${alt})\\b`, "i");
  const slashRe = new RegExp(`\\b(?:${alt})\\s*/\\s*english|english\\s*/\\s*(?:${alt})`, "i");
  // A hard requirement to speak the language; scanned per-sentence.
  const reqRe = /\b(bilingual|fluent(?:ly)?|fluency|native|proficien\w*|must speak|speaks?|speaker|speaking|require[sd]?)\b/i;
  // Optional/negation phrasing that means it is NOT a hard requirement.
  const optRe = /\b(a plus|preferred|bonus|optional|nice to have|not required|not a requirement)\b/i;
  return (n) => {
    const title = n.title || "";
    if ((/bilingual/i.test(title) && foreignRe.test(title)) || slashRe.test(title)) return true;
    for (const s of String(n.description || "").split(/[.;\n]+/)) {
      if (!foreignRe.test(s)) continue;
      if (slashRe.test(s)) return true;
      if (optRe.test(s)) continue;
      if (reqRe.test(s)) return true;
    }
    return false;
  };
}

function scoreJob(n, weights) {
  const hay = [n.title || "", (n.skills || []).join(" "), n.description || ""]
    .join(" \n ")
    .toLowerCase();
  let score = 0;
  const matched = [];
  for (const [kw, w] of Object.entries(weights)) {
    if (hay.includes(kw.toLowerCase())) {
      score += w;
      matched.push(kw.trim());
    }
  }
  return { score, matched };
}

function loadSeen(raw) {
  const ids = raw?.ids && typeof raw.ids === "object" ? raw.ids : {};
  const keys = raw?.keys && typeof raw.keys === "object" ? raw.keys : {};
  const now = Date.now();
  for (const [id, iso] of Object.entries(ids)) {
    if (now - new Date(iso).getTime() > SEEN_TTL_MS) delete ids[id];
  }
  for (const [k, iso] of Object.entries(keys)) {
    if (now - new Date(iso).getTime() > SEEN_TTL_MS) delete keys[k];
  }
  return { ids, keys };
}

// ---- notifications ---------------------------------------------------------

function buildEmailHtml(jobs, meta) {
  const rows = jobs
    .map((j) => {
      const spon =
        j.n.sponsorship === "yes"
          ? '<span style="color:#0a7d28;font-weight:600;">sponsors</span>'
          : j.n.sponsorship === "no"
            ? '<span style="color:#b00020;font-weight:600;">no sponsorship</span>'
            : '<span style="color:#8a6d00;">unknown</span>';
      const matched = j.matched.slice(0, 8).join(", ");
      const salary = j.n.salary ? ` · ${j.n.salary}` : "";
      return `<tr style="border-bottom:1px solid #eee;">
  <td style="padding:8px 10px;vertical-align:top;"><b>${j.score}</b></td>
  <td style="padding:8px 10px;vertical-align:top;">
    <a href="${j.n.url}" style="font-weight:600;color:#1a56db;text-decoration:none;">${escapeHtml(j.n.title)}</a><br>
    <span style="color:#333;">${escapeHtml(j.n.company)}</span> · ${escapeHtml(j.n.location)} · ${escapeHtml(j.n.arrangement || "")}${salary}<br>
    <span style="color:#666;font-size:12px;">${spon} · exp ${escapeHtml(j.n.exp)} · ${escapeHtml(j.n.size)} · via ${escapeHtml(j.n.source)}</span><br>
    <span style="color:#888;font-size:12px;">match: ${escapeHtml(matched)}</span>
  </td>
</tr>`;
    })
    .join("\n");
  const srcSummary = Object.entries(meta.perSource || {})
    .filter(([, v]) => v.raw > 0 || v.error)
    .map(([id, v]) => (v.error ? `${id}: ERROR` : `${id}: ${v.raw}`))
    .join(" · ");
  const total = meta.total ?? jobs.length;
  const overflow =
    total > jobs.length
      ? `<p style="color:#666;margin:0 0 14px;font-size:13px;">Showing the top ${jobs.length} by fit. All ${total} new roles are in the JobRadar sheet.</p>`
      : "";
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:760px;">
<h2 style="margin:0 0 4px;">Job Radar — ${total} new role${total === 1 ? "" : "s"}</h2>
<p style="color:#666;margin:0 0 4px;font-size:13px;">${meta.stamp} · ${escapeHtml(meta.modeLabel)} · sorted by profile fit</p>
${overflow}
<table style="border-collapse:collapse;width:100%;font-size:14px;">
<thead><tr style="text-align:left;border-bottom:2px solid #ddd;">
  <th style="padding:6px 10px;">fit</th><th style="padding:6px 10px;">role</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p style="color:#999;font-size:12px;margin-top:16px;">Sources this run — ${escapeHtml(srcSummary || "none")} · ${meta.fetched} raw → ${meta.deduped} after cross-board dedup → ${meta.eligible} eligible → ${total} new. Dropped: ${meta.droppedExcl ?? 0} senior · ${meta.droppedOffProfile ?? 0} off-profile title · ${meta.droppedStale ?? 0} stale (2+ days) · ${(meta.droppedRepost ?? 0) + (meta.droppedCrowded ?? 0)} repost/oversubscribed · ${meta.droppedExp ?? 0} over experience cap · ${meta.droppedLang ?? 0} foreign-language-required · ${meta.droppedSponsor ?? 0} no-sponsorship. Citizenship/clearance-gated roles dropped automatically.</p>
</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function sendEmail(jobs, meta, cfg) {
  const { oauthPath, credentialsPath } = getDefaultOauthPaths();
  const token = await getAccessToken(oauthPath, credentialsPath);
  const subject = `Job Radar: ${jobs.length} new early-career role${jobs.length === 1 ? "" : "s"} (${meta.hourLabel})`;
  const raw = await buildRawMessage({ to: cfg.emailTo, subject, html: buildEmailHtml(jobs, meta) });
  await sendMessage(token, raw);
}

async function appendToSheet(jobs, spreadsheetId, tab) {
  const { accessToken } = await getSheetsAccessToken();
  const meta = await getSpreadsheetMeta(accessToken, spreadsheetId);
  const header = [
    "found_at", "posted", "score", "title", "company", "location",
    "arrangement", "exp", "sponsorship", "salary", "size", "source", "matched", "url", "id",
  ];
  if (!meta.sheets.map((s) => s.properties.title).includes(tab)) {
    await batchUpdateSpreadsheet(accessToken, spreadsheetId, [
      { addSheet: { properties: { title: tab } } },
    ]);
    await appendSheetValues(accessToken, spreadsheetId, `${tab}!A1`, [header]);
  }
  const nowIso = new Date().toISOString();
  const rows = jobs.map((j) => [
    nowIso, j.n.posted, j.score, j.n.title, j.n.company, j.n.location,
    j.n.arrangement, j.n.exp, j.n.sponsorship, j.n.salary, j.n.size, j.n.source,
    j.matched.join(", "), j.n.url, j.n.id,
  ]);
  await appendSheetValues(accessToken, spreadsheetId, `${tab}!A1`, rows);
}

// ---- source selection + fetch ----------------------------------------------

function selectSources(cfg, args, isSweep) {
  const only = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const runAggregators = isSweep || args.sweep === "true";
  const chosen = [];
  for (const id of SOURCE_ORDER) {
    const reg = SOURCE_REGISTRY[id];
    if (!reg) continue;
    const sc = cfg.sources?.[id] || {};
    if (only) {
      if (only.includes(id)) chosen.push(id);
      continue;
    }
    if (sc.enabled === false) continue;
    if (reg.kind === "career") {
      chosen.push(id);
    } else if (runAggregators) {
      chosen.push(id);
    }
  }
  return chosen;
}

async function fetchAllSources(cfg, ctx, apify, sourceIds) {
  const perSource = {};
  const all = [];
  for (const id of sourceIds) {
    const reg = SOURCE_REGISTRY[id];
    const sc = cfg.sources?.[id] || {};
    const actor = sc.actor || (id === "career" ? cfg.actor : reg.defaultActor);
    const maxMs = reg.kind === "career" ? 150000 : 420000;
    let inputs;
    try {
      inputs = reg.buildInputs(cfg, ctx, sc) || [];
    } catch (e) {
      perSource[id] = { raw: 0, mapped: 0, error: e.message };
      console.warn(`  [${id}] input build failed: ${e.message}`);
      continue;
    }
    let raw = 0;
    let mapped = 0;
    let error = null;
    for (const input of inputs) {
      // Retry transient network errors ("fetch failed", connection resets/
      // timeouts) a couple times -- these happen when the Mac's Wi-Fi is briefly
      // flaky (e.g. just after wake). Do NOT retry permanent errors like an
      // Apify 400 invalid-input, which would just waste time and money.
      let attempt = 0;
      while (true) {
        try {
          const items = await runActor(actor, input, apify, { maxMs });
          raw += items.length;
          items.forEach((it, i) => {
            const n = reg.map(it, i);
            if (n) {
              all.push({ n, priority: reg.priority });
              mapped += 1;
            }
          });
          break;
        } catch (e) {
          const transient = /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|timed out/i.test(
            e.message || ""
          );
          if (transient && attempt < 2) {
            attempt += 1;
            console.warn(`  [${id}] transient error (attempt ${attempt}), retrying in ${attempt * 3}s: ${e.message}`);
            await new Promise((r) => setTimeout(r, attempt * 3000));
            continue;
          }
          error = e.message;
          console.warn(`  [${id}] run failed (${actor}): ${e.message}`);
          break;
        }
      }
    }
    perSource[id] = { raw, mapped, ...(error ? { error } : {}) };
    console.log(`  ${id}: ${raw} raw -> ${mapped} mapped${error ? ` (partial: ${error})` : ""}`);
  }
  return { perSource, all };
}

// Same role on multiple boards -> keep one (lowest source priority, then the
// richest description). Tags each survivor with its canonical key.
function crossSourceDedup(records) {
  const byKey = new Map();
  for (const rec of records) {
    const key = canonicalKey(rec.n);
    rec.n._key = key;
    const cur = byKey.get(key);
    if (
      !cur ||
      rec.priority < cur.priority ||
      (rec.priority === cur.priority &&
        (rec.n.description || "").length > (cur.n.description || "").length)
    ) {
      byKey.set(key, rec);
    }
  }
  return [...byKey.values()].map((r) => r.n);
}

// ---- main ------------------------------------------------------------------

async function main() {
  await loadDotEnv();
  const apify = createApifyTokenSession();

  const args = parseArgs(process.argv.slice(2));
  const cfg = await readJson(path.join(repoRoot, "job-radar.config.json"), null);
  if (!cfg) throw new Error("job-radar.config.json missing");
  const outreach = await readJson(path.join(repoRoot, "outreach.config.json"), {});
  const tz = cfg.timezone || outreach.google?.timezone || "America/Los_Angeles";
  const spreadsheetId = outreach.google?.primary_spreadsheet_id;

  const dryRun = args["dry-run"] === "true";
  const doEmail = cfg.notify?.email !== false && args["no-email"] !== "true";
  const doSheet = cfg.notify?.sheet !== false && args["no-sheet"] !== "true";

  const hour = hourInTz(tz);
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  // Read the seen-store up front so scheduling can self-heal against dropped
  // GitHub cron triggers (GitHub gives no scheduling SLA and silently skips
  // many scheduled runs). Whenever a run fires after a gap, widen the fetch
  // window to backfill everything missed; skip near-duplicate back-to-back
  // fires so the redundant crons never multiply Apify cost.
  const seenRaw = await readJson(seenPath, { ids: {}, keys: {} });
  const seen = loadSeen(seenRaw);
  const lastRunMs = seenRaw.lastRun ? Date.parse(seenRaw.lastRun) : NaN;
  const gapMin = Number.isFinite(lastRunMs) ? (Date.now() - lastRunMs) / 60000 : Infinity;

  const manualRun = !!(args.only || args["time-range"] || args.sweep === "true" || dryRun);
  const minIntervalMin = cfg.minIntervalMinutes ?? 45;
  if (!manualRun && gapMin < minIntervalMin) {
    console.log(
      `Job Radar | skip: last run ${Math.round(gapMin)}m ago (< ${minIntervalMin}m min interval) — redundant cron fire`
    );
    return;
  }

  // Backfill a wide window when we've missed runs (dropped triggers or the
  // overnight gap) so nothing slips through; 1h only on a normal cadence.
  const backfillGapMin = cfg.backfillGapMinutes ?? 120;
  const needBackfill = gapMin > backfillGapMin;
  const timeRange =
    args["time-range"] || (needBackfill ? cfg.morningSweepRange || "24h" : cfg.hourlyRange || "1h");
  const limit = args.limit
    ? parseInt(args.limit, 10)
    : needBackfill
      ? cfg.limitMorningSweep ?? 150
      : cfg.limitPerRun ?? 120;

  // Aggregators (LinkedIn/Handshake) run once per day — on the first fire at or
  // after sweepAfterHour that has not already swept today. Tracking the date
  // (not a fixed hour) makes the daily sweep resilient to a dropped trigger.
  const sweepAfterHour = cfg.sweepAfterHour ?? (cfg.sweepHours?.[0] ?? 8);
  const isSweep = seenRaw.lastSweepDate !== todayKey && hour >= sweepAfterHour;

  const stamp = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, dateStyle: "medium", timeStyle: "short",
  }).format(new Date());
  const hourLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: true,
  }).format(new Date());

  const sourceIds = selectSources(cfg, args, isSweep);
  const withAggregators = sourceIds.some((id) => SOURCE_REGISTRY[id]?.kind === "aggregator");
  // Mark the daily sweep as done today so a later fire doesn't re-run aggregators.
  if (withAggregators) seenRaw.lastSweepDate = todayKey;
  const modeLabel = withAggregators
    ? `full sweep (${sourceIds.join(", ")})`
    : `career-site only (window ${timeRange})`;

  console.log(`Job Radar | ${stamp} | ${modeLabel}`);

  const ctx = { timeRange, limit, hoursOld: 24, mode: withAggregators ? "sweep" : "hourly" };
  const { perSource, all } = await fetchAllSources(cfg, ctx, apify, sourceIds);
  const fetched = all.length;

  // Cross-source dedup (same role across boards -> one).
  const deduped = crossSourceDedup(all);

  // Filter: eligibility gate + location, then score.
  const weights = cfg.scoring?.weights || {};
  const minScore = cfg.scoring?.minScore ?? 0;
  const exclusionRe = buildExclusionRe(cfg);
  const titleRequireRe = buildTitleRequireRe(cfg);
  const foreignLangTest = makeForeignLanguageTest(cfg.query?.candidateLanguages);
  const dropNoSpon = cfg.query?.dropNoSponsorship !== false;
  const expCap = Number.isFinite(cfg.query?.experienceYearsCap)
    ? cfg.query.experienceYearsCap
    : null;
  const dropReposts = cfg.query?.dropReposts !== false;
  const maxApplicants = Number.isFinite(cfg.query?.maxApplicants)
    ? cfg.query.maxApplicants
    : null;
  const maxPostAgeDays = Number.isFinite(cfg.query?.maxPostAgeDays)
    ? cfg.query.maxPostAgeDays
    : null;
  const nowMs = Date.now();
  const ageInDays = (posted) => {
    const t = Date.parse(`${posted}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    return Math.floor((nowMs - t) / 86400000);
  };
  const eligible = [];
  let droppedElig = 0;
  let droppedLoc = 0;
  let droppedExcl = 0;
  let droppedOffProfile = 0;
  let droppedLang = 0;
  let droppedExp = 0;
  let droppedSponsor = 0;
  let droppedStale = 0;
  let droppedRepost = 0;
  let droppedCrowded = 0;
  for (const n of deduped) {
    if (!n || !n.id) continue;
    if (exclusionRe && exclusionRe.test(n.title || "")) {
      droppedExcl += 1;
      continue;
    }
    if (titleRequireRe && !titleRequireRe.test(n.title || "")) {
      droppedOffProfile += 1;
      continue;
    }
    // Freshness: drop clearly stale postings (only when we have a real date).
    if (maxPostAgeDays !== null && n.posted) {
      const age = ageInDays(n.posted);
      if (age !== null && age > maxPostAgeDays) {
        droppedStale += 1;
        continue;
      }
    }
    // Reposts / oversubscribed listings (proxy for stale demand). The LinkedIn
    // actor exposes no repost flag, so a high applicant count stands in for it.
    if (dropReposts && n.repost === true) {
      droppedRepost += 1;
      continue;
    }
    if (maxApplicants !== null && Number.isFinite(n.applicants) && n.applicants > maxApplicants) {
      droppedCrowded += 1;
      continue;
    }
    if (foreignLangTest(n)) {
      droppedLang += 1;
      continue;
    }
    if (expCap !== null) {
      const yrs = requiredYears(`${n.title || ""}\n${n.description || ""}`);
      if (yrs !== null && yrs > expCap) {
        droppedExp += 1;
        continue;
      }
    }
    const e = eligibility(n);
    if (!e.ok) {
      droppedElig += 1;
      continue;
    }
    if (!locationAllowed(n, cfg)) {
      droppedLoc += 1;
      continue;
    }
    n.sponsorship = sponsorshipStatus(n);
    if (dropNoSpon && n.sponsorship === "no") {
      droppedSponsor += 1;
      continue;
    }
    const { score, matched } = scoreJob(n, weights);
    if (score < minScore) continue;
    eligible.push({ n, score, matched });
  }

  // Dedup against seen store (by id AND canonical key) -> brand-new listings.
  // (seenRaw/seen were loaded up front for the self-healing scheduler.)
  const fresh = eligible.filter((j) => !seen.ids[j.n.id] && !seen.keys[j.n._key]);
  fresh.sort((a, b) => b.score - a.score);

  console.log(
    `fetched=${fetched} raw -> deduped=${deduped.length} (dropped: excl=${droppedExcl}, off-profile=${droppedOffProfile}, stale=${droppedStale}, repost=${droppedRepost}, crowded=${droppedCrowded}, lang=${droppedLang}, exp=${droppedExp}, elig=${droppedElig}, loc=${droppedLoc}, no-sponsor=${droppedSponsor}) | eligible=${eligible.length} | new=${fresh.length}`
  );

  const meta = {
    stamp, hourLabel, modeLabel, perSource,
    fetched, deduped: deduped.length, eligible: eligible.length,
    droppedExcl, droppedOffProfile, droppedStale, droppedRepost, droppedCrowded,
    droppedLang, droppedExp, droppedSponsor,
  };

  const persistSeen = async () => {
    seenRaw.ids = seen.ids;
    seenRaw.keys = seen.keys;
    seenRaw.lastRun = new Date().toISOString();
    await fs.mkdir(path.dirname(seenPath), { recursive: true });
    await fs.writeFile(seenPath, JSON.stringify(seenRaw, null, 2));
  };

  if (fresh.length === 0) {
    console.log("no new jobs; skipping notifications");
    if (!dryRun) await persistSeen();
    return;
  }

  if (dryRun) {
    console.log("dry-run: would notify these:");
    for (const j of fresh.slice(0, 25)) {
      console.log(`  [${j.score}] ${j.n.title} @ ${j.n.company} — ${j.n.location} — via ${j.n.source}`);
      console.log(`         ${j.n.url}`);
    }
    return;
  }

  // Email shows the top-by-fit slice; the Sheet gets the complete list.
  const emailCap = cfg.digestEmailLimit ?? 75;
  const emailJobs = fresh.slice(0, emailCap);
  meta.total = fresh.length;

  const results = [];
  if (doEmail) {
    try {
      await sendEmail(emailJobs, meta, cfg);
      results.push(`email sent (${emailJobs.length}/${fresh.length})`);
    } catch (err) {
      results.push(`email FAILED: ${err.message}`);
    }
  }
  if (doSheet && spreadsheetId) {
    try {
      await appendToSheet(fresh, spreadsheetId, cfg.sheetTab || "JobRadar");
      results.push("sheet updated");
    } catch (err) {
      results.push(`sheet FAILED: ${err.message}`);
    }
  }

  // Persist seen (mark all fresh as seen by id AND canonical key).
  const nowIso = new Date().toISOString();
  for (const j of fresh) {
    seen.ids[j.n.id] = nowIso;
    if (j.n._key) seen.keys[j.n._key] = nowIso;
  }
  await persistSeen();

  console.log(`notified ${fresh.length} new jobs -> ${results.join("; ")}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// Exported for offline testing (no side effects on import; main() only runs
// when this file is executed directly).
export {
  buildExclusionRe,
  buildTitleRequireRe,
  makeForeignLanguageTest,
  requiredYears,
  sponsorshipStatus,
  eligibility,
  scoreJob,
  locationAllowed,
};
