// NOTE: This file is a legacy stub kept for reference only. The canonical
// constants and setup logic live in Code.gs, which is the single file the
// clasp bundle ships. Do not edit here expecting it to deploy.
const OUTREACH_SHEET_NAMES = {
  QUEUE: "Queue",
  SETTINGS: "Settings",
};

const OUTREACH_SCRIPT_PROPERTY_KEYS = {
  SPREADSHEET_ID: "OUTREACH_SPREADSHEET_ID",
};

const OUTREACH_QUEUE_HEADERS = [
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
];

const OUTREACH_SETTINGS_HEADERS = ["key", "value", "notes"];

const OUTREACH_DEFAULT_SETTINGS = [
  ["timezone", "America/Los_Angeles", "Used for business-hour checks."],
  ["allow_weekends", "false", "Set to true only for testing."],
  ["send_start_hour", "9", "24-hour clock."],
  ["send_end_hour", "17", "24-hour clock. 17 means stop after 5 PM."],
  ["max_send_per_run", "5", "Caps sends per trigger execution."],
  ["sender_email", "", "Optional override for reply detection."],
];

const OUTREACH_STEP_CONFIG = {
  main: {
    htmlHeader: "main_html",
    scheduleHeader: "main_send_at",
    sentAtHeader: "main_sent_at",
  },
  follow_up_1: {
    htmlHeader: "follow_up_1_html",
    scheduleHeader: "follow_up_1_send_at",
    sentAtHeader: "follow_up_1_sent_at",
  },
  follow_up_2: {
    htmlHeader: "follow_up_2_html",
    scheduleHeader: "follow_up_2_send_at",
    sentAtHeader: "follow_up_2_sent_at",
  },
};

const OUTREACH_STEP_ORDER = ["main", "follow_up_1", "follow_up_2"];
const OUTREACH_TERMINAL_STATUSES = ["completed", "replied", "bounced", "cancelled", "failed"];
