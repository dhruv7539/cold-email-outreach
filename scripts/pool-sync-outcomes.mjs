#!/usr/bin/env node
// Shared pool OUTCOME SYNC — contribute reply + bounce signals to the shared
// pool so every friend benefits from what happened after outreach:
//   - if ANY friend got a reply from a contact, the pool records the GIST
//     (a category only: positive / referral / negative / auto_reply / unclear).
//     The reply text is never shared.
//   - if an email bounced or opted out, the pool flags do_not_send so nobody
//     wastes a send on a dead address.
//
// It reads YOUR OWN outreach sheet (google.primary_spreadsheet_id) — the
// Queue, Archive, Blacklist and Replies tabs — defensively by header NAME, so
// it works across old and new versions of the system (missing tabs/columns are
// simply skipped). Nothing about who observed an outcome is written.
//
// Usage:
//   node scripts/pool-sync-outcomes.mjs [--spreadsheet <YOUR_SHEET_ID>]
//
// Exit codes: 0 = ok, 2 = pool not configured, 1 = error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSharedPoolId,
  getAccessToken,
  applyOutcomes,
} from "./shared-pool.mjs";
import { getSheetValues } from "./sheets-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Queue/Archive `outcome` cell -> shared reply_status category.
const REPLY_FROM_OUTCOME = {
  replied_positive: "positive",
  replied_referral: "referral",
  replied_confused: "unclear",
  replied_negative: "negative",
  replied_unclear: "unclear",
  auto_reply: "auto_reply",
};

// Replies-tab `classification` -> shared reply_status category.
const REPLY_FROM_CLASSIFICATION = {
  positive: "positive",
  referral: "referral",
  confused: "unclear",
  not_interested: "negative",
  negative: "negative",
  auto_reply: "auto_reply",
  unclear: "unclear",
};

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

function getPrimarySpreadsheetId() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "outreach.config.json"), "utf8"));
    const id = cfg?.google?.primary_spreadsheet_id;
    return id && String(id).trim() ? String(id).trim() : null;
  } catch {
    return null;
  }
}

// Read a tab into {headerIndex(name)->col, rows}. Returns null if the tab is
// absent (older systems may not have Replies/Analytics, etc.).
async function readTab(accessToken, spreadsheetId, tab) {
  let res;
  try {
    res = await getSheetValues(accessToken, spreadsheetId, `${tab}!A:BZ`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to parse range/i.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  const values = res?.values ?? [];
  if (!values.length) return null;
  const header = values[0].map((h) => String(h || "").trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  return { col, rows: values.slice(1) };
}

function addSignal(map, email, sig) {
  const em = String(email ?? "").trim().toLowerCase();
  if (!em || !em.includes("@")) return;
  const cur = map.get(em) ?? { email: em };
  if (sig.reply_status) cur.reply_status = sig.reply_status; // applyOutcomes ranks
  if (sig.do_not_send) cur.do_not_send = true;
  if (sig.dns_reason && !cur.dns_reason) cur.dns_reason = sig.dns_reason;
  map.set(em, cur);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const poolId = getSharedPoolId();
  if (!poolId) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }
  const primaryId = args.spreadsheet && args.spreadsheet !== "true" ? args.spreadsheet : getPrimarySpreadsheetId();
  if (!primaryId) {
    console.error("no source sheet: set google.primary_spreadsheet_id or pass --spreadsheet <id>");
    process.exit(1);
  }

  const accessToken = await getAccessToken(args);

  // signals keyed by email; applyOutcomes does the highest-rank / sticky merge.
  const signals = new Map();
  const tally = { positive: 0, referral: 0, negative: 0, auto_reply: 0, unclear: 0, do_not_send: 0 };

  // 1. Queue + Archive: `outcome` (reply category) and `status` == bounced.
  for (const tab of ["Queue", "Archive"]) {
    const t = await readTab(accessToken, primaryId, tab);
    if (!t) continue;
    const emailCol = t.col("recipient_email");
    const outcomeCol = t.col("outcome");
    const statusCol = t.col("status");
    if (emailCol < 0) continue;
    for (const row of t.rows) {
      const email = row[emailCol];
      if (!email) continue;
      if (outcomeCol >= 0) {
        const oc = String(row[outcomeCol] || "").trim().toLowerCase();
        const rs = REPLY_FROM_OUTCOME[oc];
        if (rs) {
          addSignal(signals, email, { reply_status: rs });
          tally[rs] += 1;
        }
      }
      if (statusCol >= 0) {
        const st = String(row[statusCol] || "").trim().toLowerCase();
        if (st.includes("bounce")) {
          addSignal(signals, email, { do_not_send: true, dns_reason: "bounce" });
          tally.do_not_send += 1;
        }
      }
    }
  }

  // 2. Replies tab (if present): richer classification per email.
  {
    const t = await readTab(accessToken, primaryId, "Replies");
    if (t) {
      const emailCol = t.col("recipient_email");
      const clsCol = t.col("classification");
      if (emailCol >= 0 && clsCol >= 0) {
        for (const row of t.rows) {
          const email = row[emailCol];
          const cls = String(row[clsCol] || "").trim().toLowerCase();
          const rs = REPLY_FROM_CLASSIFICATION[cls];
          if (email && rs) {
            addSignal(signals, email, { reply_status: rs });
          }
        }
      }
    }
  }

  // 3. Blacklist tab: every listed email is do_not_send (bounce or opt-out).
  {
    const t = await readTab(accessToken, primaryId, "Blacklist");
    if (t) {
      const emailCol = t.col("email");
      const reasonCol = t.col("reason");
      if (emailCol >= 0) {
        for (const row of t.rows) {
          const email = row[emailCol];
          if (!email) continue;
          const reason = reasonCol >= 0 ? String(row[reasonCol] || "").trim().toLowerCase() : "";
          const norm = /bounce/.test(reason) ? "bounce" : /opt|unsub/.test(reason) ? "opt_out" : reason || "blacklist";
          addSignal(signals, email, { do_not_send: true, dns_reason: norm });
        }
      }
    }
  }

  const outcomes = [...signals.values()];
  if (!outcomes.length) {
    console.log("no reply/bounce signals found in your sheet — nothing to sync.");
    return;
  }

  const res = await applyOutcomes(accessToken, poolId, outcomes);
  const dns = outcomes.filter((o) => o.do_not_send).length;
  const replies = outcomes.filter((o) => o.reply_status).length;
  console.log(
    `synced outcomes for ${outcomes.length} email(s): ${replies} with a reply, ${dns} do-not-send.`
  );
  console.log(`  pool rows updated: ${res.updated}, new signal-only rows added: ${res.added}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
