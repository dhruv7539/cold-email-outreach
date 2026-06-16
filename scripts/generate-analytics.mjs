#!/usr/bin/env node
// Per-JD (and overall) analytics rollup.
//
// Reads the Queue sheet, optionally joins with the Replies sheet, computes
// campaign-level metrics, and writes them to the Analytics tab so you have
// a single place to compare reply rates across companies and contact types.
//
// Columns written:
//   generated_at, scope, total_contacts, sent, replies, positive_replies,
//   bounces, reply_rate_pct, positive_reply_rate_pct, bounce_rate_pct,
//   avg_hours_to_reply, top_contact_type
//
// `scope` values emitted:
//   ALL                      — rollup across every row in Queue
//   company=<company>        — one per distinct company
//   contact_type=<type>      — one per distinct contact_type across all companies
//   subject_variant=<x>      — one per distinct subject variant (from notes),
//                              so reply/positive rates by subject style are
//                              visible for A/B comparison
//   cta_type=<x>             — one per CTA shape (routing/fit/scheduling/...)
//                              tagged by the exporter in notes
//   copy_structure=<x>       — one per copy scaffold tagged in the spec
//                              (draft.copyStructure) and carried via notes
//
// Reply-stage attribution: replies_after_main / _fu1 / _fu2 compare
// reply_detected_at against follow-up sent timestamps so you can see which
// touch in the sequence actually triggered the reply.
//
// Usage:
//   node scripts/generate-analytics.mjs                  # write full rollup
//   node scripts/generate-analytics.mjs --dry-run        # print to stdout, no sheet writes
//   node scripts/generate-analytics.mjs --company Garmin # only write that company's row + ALL
//   node scripts/generate-analytics.mjs --min-sent 3     # skip rows with <3 sends (default 1)

import {
  getOutreachSpreadsheetId(),
  OUTREACH_QUEUE_HEADERS,
  OUTREACH_SHEET_NAMES,
} from "./config.mjs";
import {
  getSheetsAccessToken,
  getSheetValues,
  appendSheetValues,
  clearSheetRange,
} from "./sheets-api.mjs";

const ANALYTICS_HEADERS = [
  "generated_at",
  "scope",
  "total_contacts",
  "sent",
  "replies",
  "positive_replies",
  "bounces",
  "reply_rate_pct",
  "positive_reply_rate_pct",
  "bounce_rate_pct",
  "avg_hours_to_reply",
  "top_contact_type",
  "replies_after_main",
  "replies_after_fu1",
  "replies_after_fu2",
];

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

function col(header, name) {
  return header.indexOf(name);
}

// The exporter writes tags into the notes column as "key=<value>" fragments
// (pipe-delimited): subject_variant=, cta_type=, copy_structure=.
function parseNoteTag(notes, key) {
  const m = String(notes ?? "").match(new RegExp(`${key}=([^|]+)`, "i"));
  return m ? m[1].trim() : "";
}

function parseSubjectVariant(notes) {
  return parseNoteTag(notes, "subject_variant");
}

function pct(num, denom) {
  if (!denom) return "";
  return ((num / denom) * 100).toFixed(1);
}

function hoursBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (1000 * 60 * 60);
}

// Reduce an iterable of rows into a metrics object. This is separated from
// the sheet I/O so it's trivially testable.
export function computeMetrics(rows, headerMap) {
  const metrics = {
    total_contacts: 0,
    sent: 0,
    replies: 0,
    positive_replies: 0,
    bounces: 0,
    hoursToReplyList: [],
    contactTypeReplies: new Map(),
    repliesAfterMain: 0,
    repliesAfterFu1: 0,
    repliesAfterFu2: 0,
  };
  for (const r of rows) {
    metrics.total_contacts += 1;
    const status = String(r[headerMap.status] ?? "").toLowerCase();
    const mainSentAt = String(r[headerMap.main_sent_at] ?? "").trim();
    const replyAt = String(r[headerMap.reply_detected_at] ?? "").trim();
    if (mainSentAt) metrics.sent += 1;
    if (status === "bounced") metrics.bounces += 1;
    if (replyAt || status === "replied") {
      metrics.replies += 1;
      const hrs = hoursBetween(mainSentAt, replyAt);
      if (hrs !== null && hrs >= 0) metrics.hoursToReplyList.push(hrs);
      const ct = String(r[headerMap.contact_type] ?? "unknown").toLowerCase();
      metrics.contactTypeReplies.set(ct, (metrics.contactTypeReplies.get(ct) || 0) + 1);

      // Stage attribution: which touch most recently preceded the reply?
      const fu1At = headerMap.follow_up_1_sent_at >= 0
        ? String(r[headerMap.follow_up_1_sent_at] ?? "").trim()
        : "";
      const fu2At = headerMap.follow_up_2_sent_at >= 0
        ? String(r[headerMap.follow_up_2_sent_at] ?? "").trim()
        : "";
      const replyMs = replyAt ? new Date(replyAt).getTime() : NaN;
      const fu1Ms = fu1At ? new Date(fu1At).getTime() : NaN;
      const fu2Ms = fu2At ? new Date(fu2At).getTime() : NaN;
      if (Number.isFinite(replyMs) && Number.isFinite(fu2Ms) && replyMs >= fu2Ms) {
        metrics.repliesAfterFu2 += 1;
      } else if (Number.isFinite(replyMs) && Number.isFinite(fu1Ms) && replyMs >= fu1Ms) {
        metrics.repliesAfterFu1 += 1;
      } else {
        metrics.repliesAfterMain += 1;
      }
    }
  }
  return metrics;
}

function renderMetricsRow(scope, m, positiveBy = new Map()) {
  const positive = positiveBy.get(scope) || 0;
  const avgHours = m.hoursToReplyList.length
    ? (
        m.hoursToReplyList.reduce((a, b) => a + b, 0) / m.hoursToReplyList.length
      ).toFixed(1)
    : "";
  const topCT = [...m.contactTypeReplies.entries()].sort((a, b) => b[1] - a[1])[0];
  return [
    new Date().toISOString(),
    scope,
    String(m.total_contacts),
    String(m.sent),
    String(m.replies),
    String(positive),
    String(m.bounces),
    pct(m.replies, m.sent),
    pct(positive, m.sent),
    pct(m.bounces, m.sent),
    avgHours,
    topCT ? `${topCT[0]} (${topCT[1]})` : "",
    String(m.repliesAfterMain),
    String(m.repliesAfterFu1),
    String(m.repliesAfterFu2),
  ];
}

async function readReplies(accessToken, spreadsheetId) {
  // Returns map: company (lowercased) -> positive_reply_count, and overall total.
  const range = `${OUTREACH_SHEET_NAMES.REPLIES}!A:M`;
  let values;
  try {
    values = await getSheetValues(accessToken, spreadsheetId, range);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) {
      return { byCompany: new Map(), byContactType: new Map(), total: 0 };
    }
    throw err;
  }
  const rows = values?.values ?? [];
  if (rows.length < 2) return { byCompany: new Map(), byContactType: new Map(), total: 0 };
  const header = rows[0];
  const companyIdx = header.indexOf("company");
  const classIdx = header.indexOf("classification");
  const byCompany = new Map();
  let total = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const cls = String(rows[i][classIdx] ?? "").toLowerCase();
    if (cls !== "positive") continue;
    total += 1;
    const comp = String(rows[i][companyIdx] ?? "").toLowerCase();
    if (comp) byCompany.set(comp, (byCompany.get(comp) || 0) + 1);
  }
  return { byCompany, total };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const minSent = Number(args["min-sent"] ?? 1);
  const wantCompany = args.company ? args.company.toLowerCase() : null;
  const dryRun = args["dry-run"] === "true";

  const { accessToken } = await getSheetsAccessToken(args);

  const queueRange = `${OUTREACH_SHEET_NAMES.QUEUE}!A:AB`;
  const queueValues = await getSheetValues(accessToken, spreadsheetId, queueRange);
  const queueRows = queueValues?.values ?? [];
  if (queueRows.length < 2) {
    console.error("[analytics] Queue is empty.");
    return;
  }
  const header = queueRows[0];
  const headerMap = {
    company: col(header, "company"),
    contact_type: col(header, "contact_type"),
    status: col(header, "status"),
    main_sent_at: col(header, "main_sent_at"),
    reply_detected_at: col(header, "reply_detected_at"),
  };
  if (Object.values(headerMap).some((v) => v < 0)) {
    throw new Error(`Queue header missing expected columns. Got: ${JSON.stringify(header)}`);
  }
  // Optional columns (older sheets may lack them) — used for reply-stage
  // attribution; -1 just zeroes those counters into the main bucket.
  headerMap.follow_up_1_sent_at = col(header, "follow_up_1_sent_at");
  headerMap.follow_up_2_sent_at = col(header, "follow_up_2_sent_at");
  // notes is optional (older sheets may lack it) — used only for the
  // subject_variant rollup, so a missing column just skips that scope.
  const notesIdx = col(header, "notes");

  // Partition rows by company, by contact_type, and by subject_variant.
  const rows = queueRows.slice(1);
  const byCompany = new Map();
  const byContactType = new Map();
  const byVariant = new Map();
  const byCtaType = new Map();
  const byStructure = new Map();
  for (const r of rows) {
    const company = String(r[headerMap.company] ?? "").trim() || "(unknown)";
    const ct = String(r[headerMap.contact_type] ?? "").trim() || "(unknown)";
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push(r);
    if (!byContactType.has(ct)) byContactType.set(ct, []);
    byContactType.get(ct).push(r);
    if (notesIdx >= 0) {
      const variant = parseSubjectVariant(r[notesIdx]);
      if (variant) {
        if (!byVariant.has(variant)) byVariant.set(variant, []);
        byVariant.get(variant).push(r);
      }
      const ctaType = parseNoteTag(r[notesIdx], "cta_type");
      if (ctaType) {
        if (!byCtaType.has(ctaType)) byCtaType.set(ctaType, []);
        byCtaType.get(ctaType).push(r);
      }
      const structure = parseNoteTag(r[notesIdx], "copy_structure");
      if (structure) {
        if (!byStructure.has(structure)) byStructure.set(structure, []);
        byStructure.get(structure).push(r);
      }
    }
  }

  const { byCompany: positiveByCompany, total: positiveTotal } = await readReplies(
    accessToken,
    spreadsheetId
  );

  const output = [];

  // Overall rollup.
  const allMetrics = computeMetrics(rows, headerMap);
  const allPositiveMap = new Map([["ALL", positiveTotal]]);
  output.push(renderMetricsRow("ALL", allMetrics, allPositiveMap));

  // Per-company.
  for (const [company, crows] of [...byCompany.entries()].sort()) {
    if (wantCompany && company.toLowerCase() !== wantCompany) continue;
    const m = computeMetrics(crows, headerMap);
    if (m.sent < minSent) continue;
    const scope = `company=${company}`;
    const posMap = new Map([[scope, positiveByCompany.get(company.toLowerCase()) || 0]]);
    output.push(renderMetricsRow(scope, m, posMap));
  }

  // Per-contact_type (across all companies).
  if (!wantCompany) {
    for (const [ct, crows] of [...byContactType.entries()].sort()) {
      const m = computeMetrics(crows, headerMap);
      if (m.sent < minSent) continue;
      output.push(renderMetricsRow(`contact_type=${ct}`, m, new Map()));
    }

    // Per-subject_variant (A/B comparison across all companies). Positive
    // counts aren't tracked per-variant (the Replies sheet has no variant
    // tag), so the positive column stays blank here — reply_rate is the
    // comparison signal.
    for (const [variant, vrows] of [...byVariant.entries()].sort()) {
      const m = computeMetrics(vrows, headerMap);
      if (m.sent < minSent) continue;
      output.push(renderMetricsRow(`subject_variant=${variant}`, m, new Map()));
    }

    // Per-CTA shape and per-copy scaffold (tags written by the exporter into
    // notes). Reply_rate by CTA type answers "which ask shape converts".
    for (const [ctaType, crows] of [...byCtaType.entries()].sort()) {
      const m = computeMetrics(crows, headerMap);
      if (m.sent < minSent) continue;
      output.push(renderMetricsRow(`cta_type=${ctaType}`, m, new Map()));
    }
    for (const [structure, srows] of [...byStructure.entries()].sort()) {
      const m = computeMetrics(srows, headerMap);
      if (m.sent < minSent) continue;
      output.push(renderMetricsRow(`copy_structure=${structure}`, m, new Map()));
    }
  }

  if (dryRun) {
    console.log(ANALYTICS_HEADERS.join("\t"));
    for (const row of output) console.log(row.join("\t"));
    console.error(`[analytics] --dry-run: ${output.length} row(s) not written.`);
    return;
  }

  // Rewrite Analytics sheet atomically: clear existing body rows, re-append
  // header + new rollup. Header-row layout matches ensureAnalyticsSheet_ in
  // Setup.gs so a stale deployment will still accept the data.
  const sheetRange = `${OUTREACH_SHEET_NAMES.ANALYTICS}!A:${String.fromCharCode(
    64 + ANALYTICS_HEADERS.length
  )}`;
  try {
    await clearSheetRange(accessToken, spreadsheetId, sheetRange);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unable to parse range/i.test(msg) && !/not found/i.test(msg)) throw err;
    throw new Error(
      `Analytics sheet is missing. Run "Outreach Sequencer > Setup Sheet" in Apps Script first.`
    );
  }
  await appendSheetValues(accessToken, spreadsheetId, sheetRange, [
    ANALYTICS_HEADERS,
    ...output,
  ]);
  console.error(`[analytics] Wrote ${output.length} rollup row(s) to ${OUTREACH_SHEET_NAMES.ANALYTICS}.`);
  console.error("");
  console.error("Top-line:");
  console.error(
    `  ALL: ${allMetrics.total_contacts} contacts, ${allMetrics.sent} sent, ${allMetrics.replies} replies (${pct(
      allMetrics.replies,
      allMetrics.sent
    )}%), ${positiveTotal} positive (${pct(positiveTotal, allMetrics.sent)}%), ${allMetrics.bounces} bounces (${pct(
      allMetrics.bounces,
      allMetrics.sent
    )}%).`
  );
}

import { pathToFileURL } from "node:url";
const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
