#!/usr/bin/env node
// Run Apify actor code_crafter/leads-finder (Leads Finder) and save dataset JSON.
// Use when Apollo search/enrich is blocked or credits are exhausted.
//
// Requires APIFY_TOKEN in env (or .env at repo root). Create at:
//   https://console.apify.com/account/integrations
//
// Usage:
//   node scripts/apify-leads-finder-run.mjs \
//     --input path/to/leads-finder-input.json \
//     --output output/discovery/my-run-apify.json
//
// Post-process a JSON dataset exported from the Apify UI (same validated filter
// and --target slice). No APIFY_TOKEN required:
//   node scripts/apify-leads-finder-run.mjs \
//     --dataset-json ~/Downloads/dataset_leads-finder.json \
//     --target 20 \
//     --output output/discovery/my-run-apify.json
//
// Shorthand (merged on top of optional --input):
//   node scripts/apify-leads-finder-run.mjs \
//     --company-domain notion.com \
//     --contact-location "San Francisco Bay Area" \
//     --contact-job-title "recruiter,engineering manager,software engineer" \
//     --target 20 \
//     --output output/discovery/notion-apify.json
//
// Flags:
//   --target N       Efficient fetch_count ≈ N + buffer (default buffer 25% of N, min 5).
//                    After the run, keeps only validated/verified work emails, then slices to N.
//   --fetch-count N  Override actor fetch_count (disables --target sizing unless --target only slices).
//   --target-buffer M  Extra leads to request above --target (default max(5, ceil(target*0.25))).
//   --no-slice       After filtering, keep all rows (no cap at --target).
//   --allow-unknown-email  Passes unknown into actor email_status (default: validated only).
//
// Notes:
// - Actor is search/list based (domains, titles, location). It does not accept Apollo person IDs.
// - Free Apify plan: actor README says up to ~100 leads/run cap.
// - Free Apify plan: this actor may refuse API runs ("through the UI and not
//   via other methods") — use Apify Console → Run → Dataset export, or upgrade.
// - Pay per event on Apify; pricing is separate from Apollo.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const ACTOR_ID = "code_crafter~leads-finder";
const API_BASE = "https://api.apify.com/v2";

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
    // no .env
  }
}

function splitCsv(s) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Loose work-email check (actor already filters; this drops empties / garbage). */
function looksLikeWorkEmail(email) {
  if (!email || typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Prefer work-style fields the actor may use instead of `email`. */
function primaryOutreachEmail(item) {
  const candidates = [
    item.email,
    item.business_email,
    item.work_email,
    item.professional_email,
    item.company_email,
  ];
  for (const c of candidates) {
    if (looksLikeWorkEmail(c)) return c.trim();
  }
  return null;
}

/** Keep rows that look outreach-safe: work email + validated/verified when the field exists. */
function isValidatedVerifiedRow(item) {
  if (!primaryOutreachEmail(item)) return false;
  const st = (item.email_status ?? item.emailStatus ?? "").toString().trim().toLowerCase();
  if (!st) return true;
  if (st === "not_validated" || st === "invalid") return false;
  return st === "validated" || st === "verified" || st === "valid" || st === "deliverable";
}

function normalizeItemEmail(item) {
  const email = primaryOutreachEmail(item);
  return email ? { ...item, email } : item;
}

function defaultTargetBuffer(target) {
  return Math.max(5, Math.ceil(target * 0.25));
}

/** Actor rejects mixed-case region strings; allowed values are lowercase. */
function normalizeLocationArrays(obj) {
  for (const key of ["contact_location", "contact_not_location"]) {
    if (Array.isArray(obj[key])) {
      obj[key] = obj[key].map((s) => (typeof s === "string" ? s.toLowerCase() : s));
    }
  }
}

async function apifyFetch(token, pathname, { method = "GET", body } = {}) {
  const url = `${API_BASE}${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitForRun(token, runId, { maxMs = 45 * 60 * 1000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const json = await apifyFetch(token, `/actor-runs/${runId}`);
    const status = json?.data?.status;
    if (status === "SUCCEEDED") return json.data;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      throw new Error(`Actor run ${status}: ${JSON.stringify(json?.data?.statusMessage ?? json?.data)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for run ${runId} after ${maxMs}ms`);
}

async function fetchAllDatasetItems(token, datasetId) {
  const limit = 1000;
  const items = [];
  let offset = 0;
  for (;;) {
    const path = `/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}&offset=${offset}`;
    const chunk = await apifyFetch(token, path);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    items.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return items;
}

function isDatasetErrorRow(r) {
  return Boolean(r && typeof r === "object" && "error" in r && r.error);
}

/**
 * @returns {{ items: object[], rawCount: number, errorRows: number, dataRowCount: number, filtered: object[] }}
 */
function processRawLeadRows(rawItems, { requestedTarget, noSlice }) {
  const rawCount = rawItems.length;
  const errorRows = rawItems.filter(isDatasetErrorRow);
  const dataRows = rawItems.filter((r) => r && typeof r === "object" && !isDatasetErrorRow(r));
  if (errorRows.length && !dataRows.length) {
    const msg = errorRows.map((r) => String(r.error ?? r)).join("; ").slice(0, 800);
    throw new Error(`Dataset contains error row(s) only (no leads). First message: ${msg}`);
  }

  const filtered = dataRows.filter(isValidatedVerifiedRow).map(normalizeItemEmail);
  let items;
  if (!noSlice && requestedTarget !== null && filtered.length > requestedTarget) {
    items = filtered.slice(0, requestedTarget);
  } else {
    items = filtered;
  }
  return {
    items,
    rawCount,
    errorRows: errorRows.length,
    dataRowCount: dataRows.length,
    filtered,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("Need --output path.json");

  const target =
    args.target !== undefined && args.target !== "true" ? parseInt(String(args.target), 10) : null;
  if (target !== null && (Number.isNaN(target) || target < 1)) {
    throw new Error("--target must be a positive integer");
  }
  const targetBuffer =
    args["target-buffer"] !== undefined
      ? parseInt(String(args["target-buffer"]), 10)
      : target !== null
        ? defaultTargetBuffer(target)
        : 0;
  if (args["target-buffer"] !== undefined && (Number.isNaN(targetBuffer) || targetBuffer < 0)) {
    throw new Error("--target-buffer must be a non-negative integer");
  }
  const noSlice = args["no-slice"] === "true";
  const requestedTarget = target;

  if (args["dataset-json"]) {
    const rawBlob = JSON.parse(await fs.readFile(path.resolve(args["dataset-json"]), "utf8"));
    const rawItems = Array.isArray(rawBlob) ? rawBlob : rawBlob.items ?? [];
    const { items, rawCount, errorRows, dataRowCount, filtered } = processRawLeadRows(rawItems, {
      requestedTarget,
      noSlice,
    });
    const out = {
      source: "apify-dataset-json",
      actor: "code_crafter/leads-finder",
      email_status_filter: "validated/verified rows only (post-process)",
      requestedTarget: requestedTarget ?? null,
      targetBuffer: target !== null ? targetBuffer : null,
      rawDatasetCount: rawCount,
      datasetErrorRows: errorRows,
      validatedEmailRowCount: filtered.length,
      itemCount: items.length,
      items,
    };
    await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await fs.writeFile(path.resolve(args.output), JSON.stringify(out, null, 2));
    console.error(
      `Wrote ${items.length} items from --dataset-json (raw=${rawCount}, validated_rows=${filtered.length}, target=${requestedTarget ?? "n/a"}) -> ${args.output}`
    );
    if (requestedTarget !== null && items.length < requestedTarget) {
      console.error(
        `Note: fewer than --target ${requestedTarget} validated emails after filter; loosen source filters or use --allow-unknown-email when re-exporting from Apify.`
      );
    }
    if (dataRowCount > 0 && filtered.length === 0) {
      const r0 = rawItems.find((r) => r && typeof r === "object" && !isDatasetErrorRow(r));
      const keys = r0 && typeof r0 === "object" ? Object.keys(r0) : [];
      console.error(
        `Debug: lead rows present but none passed validated-email filter. Sample keys: ${keys.join(", ") || "(none)"}`
      );
    }
    return;
  }

  await loadDotEnv();
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN missing (add to .env — Apify Integrations page)");

  let input = {};
  if (args.input) {
    const raw = await fs.readFile(path.resolve(args.input), "utf8");
    input = JSON.parse(raw);
  }

  if (args["company-domain"]) {
    input.company_domain = splitCsv(args["company-domain"]).map((d) =>
      d.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    );
  }
  if (args["contact-location"]) {
    input.contact_location = splitCsv(args["contact-location"]).map((s) => s.toLowerCase());
  }
  if (args["contact-not-location"]) {
    input.contact_not_location = splitCsv(args["contact-not-location"]).map((s) => s.toLowerCase());
  }
  if (args["contact-city"]) input.contact_city = splitCsv(args["contact-city"]);
  if (args["contact-job-title"]) input.contact_job_title = splitCsv(args["contact-job-title"]);
  if (args["contact-not-job-title"]) input.contact_not_job_title = splitCsv(args["contact-not-job-title"]);
  if (args["allow-unknown-email"] === "true") {
    input.email_status = args["email-status"]
      ? splitCsv(args["email-status"])
      : ["validated", "unknown"];
  } else if (args["email-status"]) {
    input.email_status = splitCsv(args["email-status"]);
  } else if (!input.email_status?.length) {
    input.email_status = ["validated"];
  }

  if (args["fetch-count"]) {
    input.fetch_count = parseInt(String(args["fetch-count"]), 10);
    if (Number.isNaN(input.fetch_count) || input.fetch_count < 1) {
      throw new Error("--fetch-count must be a positive integer");
    }
  } else if (target !== null) {
    input.fetch_count = target + targetBuffer;
  }

  if (args["file-name"]) input.file_name = args["file-name"];
  if (args["seniority-level"]) input.seniority_level = splitCsv(args["seniority-level"]);
  if (args["functional-level"]) input.functional_level = splitCsv(args["functional-level"]);

  if (!Object.keys(input).length) {
    throw new Error("Provide --input file.json and/or shorthand flags like --company-domain, --contact-job-title");
  }

  normalizeLocationArrays(input);

  const fetchCountUsed = input.fetch_count ?? null;

  const startJson = await apifyFetch(token, `/acts/${ACTOR_ID}/runs`, {
    method: "POST",
    body: input,
  });
  const runId = startJson?.data?.id;
  const defaultDatasetId = startJson?.data?.defaultDatasetId;
  if (!runId) throw new Error(`Unexpected start response: ${JSON.stringify(startJson).slice(0, 400)}`);

  console.error(`Started run ${runId} (dataset ${defaultDatasetId}) …`);
  const finished = await waitForRun(token, runId);
  const datasetId = finished.defaultDatasetId;
  const rawItems = await fetchAllDatasetItems(token, datasetId);
  const { items, rawCount, errorRows, dataRowCount, filtered } = processRawLeadRows(rawItems, {
    requestedTarget,
    noSlice,
  });

  const out = {
    source: "apify",
    actor: "code_crafter/leads-finder",
    runId,
    datasetId,
    finishedAt: finished.finishedAt ?? null,
    email_status_input: input.email_status,
    fetch_count_input: fetchCountUsed,
    requestedTarget: requestedTarget ?? null,
    targetBuffer: target !== null ? targetBuffer : null,
    rawDatasetCount: rawCount,
    datasetErrorRows: errorRows,
    validatedEmailRowCount: filtered.length,
    itemCount: items.length,
    items,
  };

  await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  await fs.writeFile(path.resolve(args.output), JSON.stringify(out, null, 2));
  console.error(
    `Wrote ${items.length} items (raw=${rawCount}, validated_rows=${filtered.length}, target=${requestedTarget ?? "n/a"}) -> ${args.output}`
  );
  if (requestedTarget !== null && items.length < requestedTarget) {
    console.error(
      `Note: fewer than --target ${requestedTarget} validated emails after filter; loosen titles/location or use --allow-unknown-email (weaker).`
    );
  }
  if (dataRowCount > 0 && filtered.length === 0) {
    const r0 = rawItems.find((r) => r && typeof r === "object" && !isDatasetErrorRow(r));
    const keys = r0 && typeof r0 === "object" ? Object.keys(r0) : [];
    console.error(
      `Debug: lead row(s) present but none passed validated-email filter. First row keys: ${keys.join(", ") || "(none)"}`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
