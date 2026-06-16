// Shared configuration for Node.js helper scripts in this repo.
//
// Spreadsheet ID resolution order:
//   1. OUTREACH_SPREADSHEET_ID env var
//   2. google.primary_spreadsheet_id in outreach.config.json
//
// Copy outreach.config.example.json → outreach.config.json before first use (SETUP.md).

import {
  loadOutreachConfigSync,
  requireSpreadsheetId,
  getCandidate,
  getGoogleConfig,
  getApolloConfig,
  getSignatureHtml,
  getOverflowSpreadsheetId,
  isSetupComplete,
} from "./load-config.mjs";

export function getOutreachSpreadsheetId() {
  if (process.env.OUTREACH_SPREADSHEET_ID?.trim()) {
    return process.env.OUTREACH_SPREADSHEET_ID.trim();
  }
  const config = loadOutreachConfigSync();
  return requireSpreadsheetId(config);
}

export {
  loadOutreachConfigSync as loadOutreachConfig,
  getCandidate,
  getGoogleConfig,
  getApolloConfig,
  getSignatureHtml,
  getOverflowSpreadsheetId,
  isSetupComplete,
};

export const OUTREACH_SHEET_NAMES = {
  QUEUE: "Queue",
  SETTINGS: "Settings",
  BLACKLIST: "Blacklist",
  REPLIES: "Replies",
  ANALYTICS: "Analytics",
};

export const OUTREACH_QUEUE_HEADERS = [
  "job_id",
  "company",
  "contact_name",
  "contact_type",
  "recipient_email",
  "subject",
  "main_html",
  "main_send_at",
  "follow_up_1_html",
  "follow_up_1_send_at",
  "follow_up_2_html",
  "follow_up_2_send_at",
  "attachment_file_id",
  "status",
  "active_step",
  "gmail_thread_id",
  "root_message_id",
  "last_message_id",
  "sender_email",
  "main_sent_at",
  "follow_up_1_sent_at",
  "follow_up_2_sent_at",
  "reply_detected_at",
  "last_sent_at",
  "created_at",
  "updated_at",
  "notes",
  "error",
  "recipient_timezone",
];
