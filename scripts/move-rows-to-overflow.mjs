#!/usr/bin/env node
/**
 * Move pending Queue rows from the PRIMARY sheet to the OVERFLOW (second
 * mailbox) sheet so they send from the second account instead.
 *
 * Safe by design:
 *   - Maps columns by HEADER NAME (the two sheets have different column orders).
 *   - Re-keys each moved row as a fresh `queued` main (clears sent/thread ids).
 *   - Preserves the original follow-up cadence (gap from the source row).
 *   - CANCELS the source row so it never double-sends from the primary account.
 *   - Dry-run by default; skips recipients already present in the overflow Queue.
 *
 * Examples:
 *   # Preview moving every overdue, unsent main to the overflow sheet:
 *   node scripts/move-rows-to-overflow.mjs --overdue
 *
 *   # Move at most 40 overdue rows for real:
 *   node scripts/move-rows-to-overflow.mjs --overdue --max 40 --apply
 *
 *   # Move an explicit source row range:
 *   node scripts/move-rows-to-overflow.mjs --rows 533:620 --apply
 */

import { getOutreachSpreadsheetId, getOverflowSpreadsheetId, loadOutreachConfig } from "./config.mjs";
import {
  getSheetsAccessToken,
  getSheetValues,
  updateSheetValues,
  appendSheetValues,
} from "./sheets-api.mjs";

const OVERFLOW_SPREADSHEET_ID_DEFAULT = "";
const TERMINAL_STATUSES = new Set(["completed", "replied", "bounced", "cancelled", "failed"]);
const DEFAULT_GAP1_DAYS = 3;
const DEFAULT_GAP2_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
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

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1");
}

function parseRowRange(value) {
  const match = String(value || "").match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) {
    throw new Error(`Invalid --rows value "${value}" (expected START:END)`);
  }
  return { start: Number(match[1]), end: Number(match[2]) };
}

function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function headerMap(headerRow) {
  const map = {};
  headerRow.forEach((name, i) => {
    map[String(name).trim()] = i;
  });
  return map;
}

function parseDate(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const args = parseArgs(process.argv);
  const apply = args.apply === "true";
  const config = loadOutreachConfig();
  const sourceId = args["source-id"] || getOutreachSpreadsheetId();
  const destId =
    args["dest-id"] ||
    getOverflowSpreadsheetId(config) ||
    OVERFLOW_SPREADSHEET_ID_DEFAULT;
  if (!destId) {
    throw new Error(
      "Overflow destination sheet ID required. Pass --dest-id or set google.overflow_spreadsheet_id in outreach.config.json (see SETUP_OVERFLOW.md)."
    );
  }
  const overdueOnly = args.overdue === "true";
  const max = args.max ? Number(args.max) : Infinity;
  const rowRange = args.rows ? parseRowRange(args.rows) : null;
  const companyFilter = args.company ? String(args.company).trim().toLowerCase() : null;
  const typeFilter = args["contact-types"]
    ? new Set(
        String(args["contact-types"]) 
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    : null;
  const now = new Date();
  const nowIso = now.toISOString();

  const { accessToken } = await getSheetsAccessToken();

  // --- Read source header + rows ---
  const srcAll = await getSheetValues(accessToken, sourceId, "Queue!A1:BZ5000");
  const srcRows = srcAll.values || [];
  if (srcRows.length < 2) throw new Error("Source Queue has no data rows.");
  const srcHeader = srcRows[0];
  const srcIdx = headerMap(srcHeader);
  const need = (n) => {
    if (!(n in srcIdx)) throw new Error(`Source Queue missing header "${n}"`);
    return srcIdx[n];
  };
  const sStatus = need("status");
  const sEmail = need("recipient_email");
  const sMainSent = need("main_sent_at");
  const sMainSendAt = need("main_send_at");
  const sFu1SendAt = srcIdx.follow_up_1_send_at;
  const sFu2SendAt = srcIdx.follow_up_2_send_at;
  const sCompany = srcIdx.company;
  const sName = srcIdx.contact_name;
  const sType = srcIdx.contact_type;
  const sNotes = srcIdx.notes;

  // --- Read dest header + existing recipients (dedup) ---
  const dstAll = await getSheetValues(accessToken, destId, "Queue!A1:BZ5000");
  const dstRows = dstAll.values || [];
  if (dstRows.length < 1) throw new Error("Dest Queue has no header row (run setupOutreachSheet).");
  const dstHeader = dstRows[0];
  const dstIdx = headerMap(dstHeader);
  const dEmailIdx = dstIdx.recipient_email;
  const existingDest = new Set(
    dstRows.slice(1).map((r) => normalizeEmail(r[dEmailIdx])).filter(Boolean)
  );

  // --- Select source rows ---
  const candidates = [];
  for (let i = 1; i < srcRows.length; i += 1) {
    const rowNumber = i + 1;
    const r = srcRows[i];
    if (!r || r.length === 0) continue;
    if (rowRange && (rowNumber < rowRange.start || rowNumber > rowRange.end)) continue;

    const status = String(r[sStatus] || "").trim().toLowerCase();
    const email = normalizeEmail(r[sEmail]);
    const mainSent = String(r[sMainSent] || "").trim();
    const company = sCompany != null ? String(r[sCompany] || "").trim() : "";

    if (!email) continue;
    if (TERMINAL_STATUSES.has(status)) continue; // already done/cancelled
    if (mainSent) continue; // main already sent from primary
    if (companyFilter && company.toLowerCase() !== companyFilter) continue;
    if (typeFilter) {
      const ct = sType != null ? String(r[sType] || "").trim().toLowerCase() : "";
      if (!typeFilter.has(ct)) continue;
    }

    if (overdueOnly) {
      const due = parseDate(r[sMainSendAt]);
      if (!due || due.getTime() > now.getTime()) continue;
    }
    candidates.push({ rowNumber, r, email, company });
  }

  // --- Build move actions (dedup + max) ---
  const actions = [];
  const seenThisRun = new Set();
  let skippedDup = 0;
  for (const c of candidates) {
    if (actions.length >= max) break;
    if (existingDest.has(c.email) || seenThisRun.has(c.email)) {
      skippedDup += 1;
      continue;
    }
    seenThisRun.add(c.email);

    // Preserve original follow-up gaps relative to original main_send_at.
    const origMain = parseDate(c.r[sMainSendAt]);
    let gap1 = DEFAULT_GAP1_DAYS * DAY_MS;
    let gap2 = DEFAULT_GAP2_DAYS * DAY_MS;
    if (origMain) {
      const f1 = sFu1SendAt != null ? parseDate(c.r[sFu1SendAt]) : null;
      const f2 = sFu2SendAt != null ? parseDate(c.r[sFu2SendAt]) : null;
      if (f1) gap1 = Math.max(DAY_MS, f1.getTime() - origMain.getTime());
      if (f2) gap2 = Math.max(gap1 + DAY_MS, f2.getTime() - origMain.getTime());
    }

    // Build dest row by header NAME (copy matching columns, then override).
    const destRow = new Array(dstHeader.length).fill("");
    for (const name in dstIdx) {
      if (name in srcIdx) destRow[dstIdx[name]] = c.r[srcIdx[name]] ?? "";
    }
    const setDest = (name, val) => {
      if (name in dstIdx) destRow[dstIdx[name]] = val;
    };
    setDest("status", "queued");
    setDest("active_step", "main");
    setDest("main_sent_at", "");
    setDest("follow_up_1_sent_at", "");
    setDest("follow_up_2_sent_at", "");
    setDest("last_sent_at", "");
    setDest("reply_detected_at", "");
    setDest("gmail_thread_id", "");
    setDest("root_message_id", "");
    setDest("last_message_id", "");
    setDest("error", "");
    setDest("sender_email", "");
    setDest("created_at", nowIso);
    setDest("updated_at", nowIso);
    setDest("main_send_at", nowIso);
    setDest("follow_up_1_send_at", new Date(now.getTime() + gap1).toISOString());
    setDest("follow_up_2_send_at", new Date(now.getTime() + gap2).toISOString());

    actions.push({ ...c, destRow });
  }

  // --- Report ---
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Source: ${sourceId}`);
  console.log(`Dest (overflow): ${destId}`);
  console.log(`Filter: ${overdueOnly ? "overdue mains" : rowRange ? `rows ${rowRange.start}:${rowRange.end}` : "all pending"}${companyFilter ? `, company=${companyFilter}` : ""}`);
  console.log(`Candidates: ${candidates.length} | to move: ${actions.length} | skipped (already in overflow): ${skippedDup}`);
  console.log("");
  for (const a of actions) {
    const name = sName != null ? String(a.r[sName] || "").trim() : "";
    const type = sType != null ? String(a.r[sType] || "").trim() : "";
    console.log(`  src r${a.rowNumber} [${a.company}] ${name} (${type}) <${a.email}>`);
  }

  if (!apply) {
    console.log(`\nDRY RUN. Re-run with --apply to move ${actions.length} row(s) and cancel them in the source.`);
    return;
  }
  if (actions.length === 0) {
    console.log("\nNothing to move.");
    return;
  }

  // --- Apply: append to dest, then cancel source rows ---
  const destValues = actions.map((a) => a.destRow);
  const dstLastCol = columnLetter(dstHeader.length - 1);
  await appendSheetValues(accessToken, destId, `Queue!A1:${dstLastCol}1`, destValues);
  console.log(`\nAppended ${destValues.length} row(s) to overflow Queue.`);

  const sStatusCol = columnLetter(sStatus);
  const tag = `moved-to-overflow@${nowIso.slice(0, 10)}`;
  for (const a of actions) {
    await updateSheetValues(accessToken, sourceId, `Queue!${sStatusCol}${a.rowNumber}`, [["cancelled"]]);
    if (sNotes != null) {
      const prev = String(a.r[sNotes] || "").trim();
      const sNotesCol = columnLetter(sNotes);
      await updateSheetValues(accessToken, sourceId, `Queue!${sNotesCol}${a.rowNumber}`, [
        [prev ? `${prev}; ${tag}` : tag],
      ]);
    }
  }
  console.log(`Cancelled ${actions.length} source row(s) (tag: ${tag}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
