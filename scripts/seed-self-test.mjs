#!/usr/bin/env node
/**
 * Queue a self-test row (main + follow-up) to the candidate's own email.
 * Used at the end of SETUP.md Phase D.
 *
 * Usage:
 *   node scripts/seed-self-test.mjs
 *   node scripts/seed-self-test.mjs --apply
 *   node scripts/seed-self-test.mjs --apply --follow-up-minutes 2
 */

import { loadOutreachConfig, getCandidate, getPrimarySpreadsheetId, getGoogleConfig } from "./load-config.mjs";
import { OUTREACH_QUEUE_HEADERS } from "./config.mjs";
import { getSheetsAccessToken, getSheetValues, appendSheetValues, batchUpdateSheetValues } from "./sheets-api.mjs";

function parseArgs(argv) {
  const args = { apply: false, "follow-up-minutes": 2, "allow-weekends": true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadOutreachConfig();
  const candidate = getCandidate(config);
  const google = getGoogleConfig(config);
  const spreadsheetId = getPrimarySpreadsheetId(config);
  const to = candidate.email?.trim();
  const firstName = candidate.first_name?.trim() || "there";
  const senderEmail = google.sender_email?.trim();

  if (!to) throw new Error("candidate.email is required in outreach.config.json");
  if (!spreadsheetId) throw new Error("google.primary_spreadsheet_id is required");

  const followUpMin = Number(args["follow-up-minutes"]) || 2;
  const now = new Date();
  const mainSend = new Date(now.getTime() - 5000).toISOString();
  const fu1Send = new Date(now.getTime() + followUpMin * 60 * 1000).toISOString();

  const mainHtml = `<p>Hi ${firstName},</p><p>This is an automated <b>self-test</b> from your outreach sequencer. If you are reading this, the main send works.</p><p>Thanks,<br>${firstName}</p>`;
  const fu1Html = `<p>Hi ${firstName},</p><p>Self-test follow-up (threaded reply). If this lands in the same thread shortly after the first email, follow-ups work too.</p><p>Thanks,<br>${firstName}</p>`;

  const vals = {
    job_id: `setup-selftest-${now.getTime()}`,
    company: "Setup Self Test",
    contact_name: candidate.full_name || firstName,
    contact_type: "software_engineer",
    recipient_email: to,
    subject: "Outreach sequencer self-test",
    main_html: mainHtml,
    main_send_at: mainSend,
    follow_up_1_html: fu1Html,
    follow_up_1_send_at: fu1Send,
    status: "queued",
    active_step: "main",
    sender_email: senderEmail || "",
    created_at: now.toISOString(),
    notes: "SETUP.md Phase D self-test — safe to cancel after validation",
    recipient_timezone: google.timezone || "America/Los_Angeles",
  };

  const row = OUTREACH_QUEUE_HEADERS.map((k) => vals[k] ?? "");

  console.log(JSON.stringify({ dryRun: !args.apply, to, mainSend, fu1Send, spreadsheetId }, null, 2));

  if (!args.apply) {
    console.log("\nDry run. Re-run with --apply to queue the test row.");
    return;
  }

  const { accessToken } = await getSheetsAccessToken();
  await appendSheetValues(accessToken, spreadsheetId, "Queue!A1", [row]);

  if (args["allow-weekends"] === true || args["allow-weekends"] === "true") {
    await batchUpdateSheetValues(accessToken, spreadsheetId, [
      { range: "Settings!B3", values: [["TRUE"]] },
      { range: "Settings!B7", values: [["30"]] },
      { range: "Settings!B10", values: [["0"]] },
    ]);
    console.log("Temp settings: allow_weekends=TRUE, min_seconds_between_sends=30, per_domain_min_minutes=0");
    console.log("Revert these after the test passes (SETUP.md Phase D step 4).");
  }

  console.log("\nSelf-test row queued. Wait 2-3 minutes, then check Queue row status and your inbox.");
  console.log("Confirm: status=sent_main → follow_up_1 sent in same Gmail thread.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
