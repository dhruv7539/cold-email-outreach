#!/usr/bin/env node
import { getSheetValues, getSheetsAccessToken } from "./sheets-api.mjs";
import { getOutreachSpreadsheetId } from "./config.mjs";

const TERMINAL = new Set(["completed", "replied", "bounced", "failed"]);

function bucketDaysAgo(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

async function main() {
  const { accessToken } = await getSheetsAccessToken();
  const resp = await getSheetValues(accessToken, getOutreachSpreadsheetId(), "Queue!A1:AC10000");
  const rows = resp.values || [];
  if (rows.length < 2) {
    console.log("Queue is empty.");
    return;
  }

  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const now = new Date();

  let total = 0;
  let terminalInQueue = 0;
  const overdueMain = [];
  const overdueFu1 = [];
  const overdueFu2 = [];
  const futureMain = [];
  const futureFu1 = [];
  const futureFu2 = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    total++;
    const status = String(r[idx.status] || "").trim();
    if (TERMINAL.has(status)) {
      terminalInQueue++;
      continue;
    }

    const mainSentAt = r[idx.main_sent_at];
    const fu1SentAt = r[idx.follow_up_1_sent_at];
    const fu2SentAt = r[idx.follow_up_2_sent_at];
    const mainSched = r[idx.main_send_at];
    const fu1Sched = r[idx.follow_up_1_send_at];
    const fu2Sched = r[idx.follow_up_2_send_at];

    // Determine the next pending step
    if (!mainSentAt && mainSched) {
      const daysAgo = bucketDaysAgo(mainSched, now);
      if (daysAgo === null) continue;
      if (daysAgo >= 0) overdueMain.push(daysAgo);
      else futureMain.push(-daysAgo);
    } else if (mainSentAt && !fu1SentAt && fu1Sched) {
      const daysAgo = bucketDaysAgo(fu1Sched, now);
      if (daysAgo === null) continue;
      if (daysAgo >= 0) overdueFu1.push(daysAgo);
      else futureFu1.push(-daysAgo);
    } else if (fu1SentAt && !fu2SentAt && fu2Sched) {
      const daysAgo = bucketDaysAgo(fu2Sched, now);
      if (daysAgo === null) continue;
      if (daysAgo >= 0) overdueFu2.push(daysAgo);
      else futureFu2.push(-daysAgo);
    }
  }

  const summarize = (arr) => {
    if (arr.length === 0) return { count: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      count: arr.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(sorted.length / 2)],
    };
  };

  console.log(`Total rows: ${total}`);
  console.log(`Terminal-status rows still in Queue: ${terminalInQueue}`);
  console.log("");
  console.log("OVERDUE (scheduled in the past, not yet sent):");
  console.log(`  Main emails:      ${JSON.stringify(summarize(overdueMain))}`);
  console.log(`  Follow-up 1:      ${JSON.stringify(summarize(overdueFu1))}`);
  console.log(`  Follow-up 2:      ${JSON.stringify(summarize(overdueFu2))}`);
  console.log(`  TOTAL overdue:    ${overdueMain.length + overdueFu1.length + overdueFu2.length}`);
  console.log("");
  console.log("FUTURE (scheduled going forward):");
  console.log(`  Main emails:      ${JSON.stringify(summarize(futureMain))}`);
  console.log(`  Follow-up 1:      ${JSON.stringify(summarize(futureFu1))}`);
  console.log(`  Follow-up 2:      ${JSON.stringify(summarize(futureFu2))}`);
  console.log(`  TOTAL future:     ${futureMain.length + futureFu1.length + futureFu2.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
