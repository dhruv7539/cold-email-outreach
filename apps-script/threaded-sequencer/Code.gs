const OUTREACH_SHEET_NAMES = {
  QUEUE: "Queue",
  SETTINGS: "Settings",
  ARCHIVE: "Archive",
  BLACKLIST: "Blacklist",
  REPLIES: "Replies",
  ANALYTICS: "Analytics",
};

const OUTREACH_BLACKLIST_HEADERS = [
  "email",
  "reason",
  "first_observed_at",
  "source_queue_row",
];

const OUTREACH_REPLIES_HEADERS = [
  "queue_row",
  "classified_at",
  "company",
  "contact_name",
  "recipient_email",
  "subject",
  "classification",
  "confidence",
  "snippet",
  "received_at",
  "needs_action",
  "actioned",
  "note",
];

const OUTREACH_ANALYTICS_HEADERS = [
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
];

const OUTREACH_SCRIPT_PROPERTY_KEYS = {
  SPREADSHEET_ID: "OUTREACH_SPREADSHEET_ID",
};

// IMPORTANT: This list MUST stay in sync with:
//   - scripts/export-spec-to-apps-script-queue.mjs (QUEUE_HEADERS)
//   - apps-script/threaded-sequencer/README.md (Queue Columns)
// Adding a column requires updating all three places and re-running setupOutreachSheet
// on a fresh sheet (or migrating existing sheets manually).
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
  "recipient_timezone",
];

const OUTREACH_SETTINGS_HEADERS = ["key", "value", "notes"];

const OUTREACH_DEFAULT_SETTINGS = [
  ["timezone", "America/Los_Angeles", "Fallback business-hour zone when a row has no recipient_timezone."],
  ["allow_weekends", "false", "Set to true only for testing."],
  ["send_start_hour", "9", "24-hour clock. Evaluated in each recipient's local timezone."],
  ["send_end_hour", "17", "24-hour clock. 17 means stop after 5 PM (recipient-local)."],
  ["max_send_per_run", "2", "Caps sends per trigger execution. Low on purpose so catch-up never bursts; pacing is governed by the throttles below."],
  ["min_seconds_between_sends", "90", "Minimum spacing between any two sends (human pacing / anti-burst)."],
  ["max_send_per_hour", "45", "Rolling 60-minute send cap across all recipients."],
  ["max_send_per_day", "400", "Daily ceiling/governor, reset at midnight in `timezone`."],
  ["per_domain_min_minutes", "12", "Minimum gap between two sends to the same recipient domain."],
  ["sender_email", "", "Optional override for reply detection."],
  ["warmup_start_date", "", "Optional YYYY-MM-DD. When set, ramps the daily cap base*factor^day (clamped to max_send_per_day). Leave blank to disable (established accounts)."],
  ["warmup_base_per_day", "40", "Day-0 daily cap when warm-up is active."],
  ["warmup_factor", "2", "Daily multiplier during warm-up (2 = double each day)."],
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

// Absolute upper bound on sends per single processQueue execution. The Settings
// sheet's `max_send_per_run` may lower this, but cannot raise it. This protects
// against accidental misconfiguration that could blow daily quotas (Google
// Workspace allows ~2,000 sends/day via the Gmail Advanced Service).
const OUTREACH_MAX_SEND_PER_RUN_HARD_CAP = 10;

// Representative US zones used for the broad "is anyone in business hours right
// now?" envelope check. The per-row gate (in each recipient's own zone) is the
// real control; this only short-circuits whole runs when it is the middle of
// the night across the entire country.
const OUTREACH_BUSINESS_ENVELOPE_ZONES = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
];

// ScriptProperties key holding the JSON send-pacing state (last send time,
// rolling hour log, daily counter, per-domain last-send timestamps).
const OUTREACH_PACING_PROP_KEY = "SEND_PACING";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Outreach Sequencer")
    .addItem("Setup Sheet", "setupOutreachSheet")
    .addItem("Install Trigger", "installOutreachTrigger")
    .addItem("Remove Trigger", "removeOutreachTriggers")
    .addItem("Check Replies Now", "checkRepliesAndBounces")
    .addItem("Archive Terminal Rows", "archiveTerminalRowsNow")
    .addItem("Reschedule Overdue (Help)", "showRescheduleOverdueHelp")
    .addToUi();
}

function showRescheduleOverdueHelp() {
  var ui = SpreadsheetApp.getUi();
  ui.alert(
    "Reschedule Overdue Follow-ups",
    "Run this from your laptop (Node.js):\n\n" +
      "1) cd into the project folder\n" +
      "2) Dry run:  node scripts/reschedule-overdue-followups.mjs\n" +
      "3) Apply:    node scripts/reschedule-overdue-followups.mjs --apply\n\n" +
      "It distributes overdue rows over the next business days, caps at ~200/day, " +
      "and keeps follow-up 2 at least 4 days after follow-up 1 for the same recipient.",
    ui.ButtonSet.OK
  );
}

function setupOutreachSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty(
    OUTREACH_SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID,
    spreadsheet.getId()
  );

  ensureHeaderSheet_(spreadsheet, OUTREACH_SHEET_NAMES.QUEUE, OUTREACH_QUEUE_HEADERS);
  ensureSettingsSheet_(spreadsheet);
  ensureArchiveSheet_(spreadsheet);
  ensureHeaderSheet_(spreadsheet, OUTREACH_SHEET_NAMES.BLACKLIST, OUTREACH_BLACKLIST_HEADERS);
  ensureHeaderSheet_(spreadsheet, OUTREACH_SHEET_NAMES.REPLIES, OUTREACH_REPLIES_HEADERS);
  ensureHeaderSheet_(spreadsheet, OUTREACH_SHEET_NAMES.ANALYTICS, OUTREACH_ANALYTICS_HEADERS);
}

function ensureHeaderSheet_(spreadsheet, sheetName, headers) {
  const sheet = ensureSheet_(spreadsheet, sheetName);
  if (sheet.getLastRow() < 1) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureSettingsSheet_(spreadsheet) {
  const settingsSheet = ensureHeaderSheet_(
    spreadsheet,
    OUTREACH_SHEET_NAMES.SETTINGS,
    OUTREACH_SETTINGS_HEADERS
  );
  if (settingsSheet.getLastRow() < 2) {
    settingsSheet
      .getRange(2, 1, OUTREACH_DEFAULT_SETTINGS.length, OUTREACH_DEFAULT_SETTINGS[0].length)
      .setValues(OUTREACH_DEFAULT_SETTINGS);
  }
  return settingsSheet;
}

function ensureArchiveSheet_(spreadsheet) {
  return ensureHeaderSheet_(spreadsheet, OUTREACH_SHEET_NAMES.ARCHIVE, OUTREACH_QUEUE_HEADERS);
}

function installOutreachTrigger() {
  removeOutreachTriggers();
  ScriptApp.newTrigger("processQueue").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("checkRepliesAndBounces").timeBased().everyMinutes(15).create();
}

function removeOutreachTriggers() {
  const managed = { processQueue: true, checkRepliesAndBounces: true };
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i += 1) {
    if (managed[triggers[i].getHandlerFunction()]) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function ensureSheet_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

// Optional warm-up ramp for new sender accounts. When `warmup_start_date`
// (YYYY-MM-DD) is set in Settings, the effective daily cap ramps as
// `warmup_base_per_day * warmup_factor^dayIndex` (dayIndex = full days since
// the start date, in `timezone`), clamped to the configured `max_send_per_day`
// ceiling. Returns the ceiling unchanged when `warmup_start_date` is blank or
// malformed, so established accounts (e.g. the primary sender) are unaffected.
function applyWarmupRamp_(ceiling, settings) {
  const startRaw = String((settings && settings.warmup_start_date) || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startRaw);
  if (!m) {
    return ceiling;
  }
  const base = settingNumber_(settings.warmup_base_per_day, 40);
  const factor = settingNumber_(settings.warmup_factor, 2);
  const tz = (settings && settings.timezone) || "America/Los_Angeles";
  const startUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const todayParts = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd").split("-");
  const todayUtc = Date.UTC(
    Number(todayParts[0]),
    Number(todayParts[1]) - 1,
    Number(todayParts[2])
  );
  let dayIndex = Math.floor((todayUtc - startUtc) / 86400000);
  if (dayIndex < 0) {
    dayIndex = 0;
  }
  const ramp = Math.round(base * Math.pow(factor, dayIndex));
  return Math.max(1, Math.min(ceiling, ramp));
}

function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return;
  }

  try {
    const spreadsheet = getOutreachSpreadsheet_();
    const queueSheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.QUEUE);
    if (!queueSheet) {
      throw new Error("Queue sheet not found. Run setupOutreachSheet first.");
    }

    const settings = getOutreachSettings_(spreadsheet);
    // Broad envelope: if it is outside business hours in EVERY supported US
    // zone (i.e. the middle of the night nationwide), skip the whole run. The
    // real gate is per-row, in each recipient's own timezone, applied below.
    if (!isWithinAnyBusinessWindow_(new Date(), settings)) {
      return;
    }

    const values = queueSheet.getDataRange().getValues();
    if (values.length < 2) {
      return;
    }

    // Hard cap of OUTREACH_MAX_SEND_PER_RUN_HARD_CAP keeps us well under daily
    // quotas even if Settings is misconfigured (e.g. set to 9999). The
    // user-controlled setting can lower it but cannot raise it.
    const maxSendPerRun = Math.min(
      settingNumber_(settings.max_send_per_run, 2),
      OUTREACH_MAX_SEND_PER_RUN_HARD_CAP
    );

    // Pacing throttles (anti-spam spacing). These keep the absolute send rhythm
    // human even when many rows come due at once.
    const minMsBetweenSends = settingNumber_(settings.min_seconds_between_sends, 90) * 1000;
    const maxSendPerHour = settingNumber_(settings.max_send_per_hour, 45);
    const maxSendPerDay = applyWarmupRamp_(
      settingNumber_(settings.max_send_per_day, 400),
      settings
    );
    const perDomainMinMs = settingNumber_(settings.per_domain_min_minutes, 12) * 60 * 1000;
    const dailyKey = Utilities.formatDate(
      new Date(),
      settings.timezone || "America/Los_Angeles",
      "yyyy-MM-dd"
    );

    const pacing = loadPacingState_();
    prunePacingState_(pacing, Date.now(), dailyKey);

    let sendCount = 0;

    for (let i = 1; i < values.length; i += 1) {
      const rowNumber = i + 1;
      const row = rowValuesToObject_(values[i], values[0]);

      if (!row.recipient_email || !row.subject) {
        continue;
      }

      if (OUTREACH_TERMINAL_STATUSES.indexOf(String(row.status || "").trim()) !== -1) {
        continue;
      }

      const nextStep = getNextDueStep_(row, new Date());
      if (!nextStep) {
        continue;
      }

      if (nextStep === "complete") {
        row.status = "completed";
        row.active_step = "done";
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
        continue;
      }

      // Once we hit the per-run cap, no more rows can send this minute.
      // Stop scanning so we don't pay for Gmail lookups we won't act on.
      // checkRepliesAndBounces handles proactive reply/bounce detection on its
      // own time-driven schedule.
      if (sendCount >= maxSendPerRun) {
        break;
      }

      // Global pacing gates (apply across all recipients). Hitting any of these
      // stops the run; the next 1-minute trigger picks up where we left off.
      const nowMs = Date.now();
      if (pacing.daily.count >= maxSendPerDay) {
        break;
      }
      if (pacing.hourLog.length >= maxSendPerHour) {
        break;
      }
      if (nowMs - pacing.lastSendMs < minMsBetweenSends) {
        break;
      }

      // Per-row business-hours gate in the recipient's OWN timezone. A row that
      // is outside its local window is simply skipped this run (not blocked
      // forever) so other in-window recipients can still send.
      const rowSettings = recipientWindowSettings_(row, settings);
      if (!isWithinBusinessWindow_(new Date(), rowSettings)) {
        continue;
      }

      // Per-domain spacing so multiple contacts at the same company are not
      // sent back-to-back. Skip (try later) rather than break.
      const recipientDomain = recipientDomain_(row.recipient_email);
      const domainLastMs = recipientDomain ? pacing.domainLast[recipientDomain] || 0 : 0;
      if (recipientDomain && nowMs - domainLastMs < perDomainMinMs) {
        continue;
      }

      // For follow-ups, re-check the thread immediately before sending so we
      // never follow up someone who just replied. Only the row we are about to
      // send pays the Gmail-API cost — not the entire queue.
      if (nextStep !== "main" && row.gmail_thread_id) {
        let threadOutcome = null;
        try {
          threadOutcome = getQueuedThreadOutcome_(row, settings);
        } catch (outcomeError) {
          // A Gmail read failure on one row must never abort the entire run
          // (the outer try has no catch). Record it and fall through to send;
          // checkRepliesAndBounces is the authoritative reply/bounce backstop.
          const outcomeMessage =
            outcomeError instanceof Error ? outcomeError.message : String(outcomeError);
          console.error("Reply/bounce check failed for row " + rowNumber + ": " + outcomeMessage);
          row.notes = String(row.notes || "") + " | reply-check error: " + outcomeMessage;
          threadOutcome = null;
        }
        if (threadOutcome && threadOutcome.type === "bounced") {
          row.status = "bounced";
          row.active_step = "done";
          row.error = threadOutcome.reason || "Bounce detected for recipient.";
          row.updated_at = nowIso_();
          writeRowObject_(queueSheet, rowNumber, row, values[0]);
          appendToBlacklist_(queueSheet.getParent(), row.recipient_email, row.error, rowNumber);
          continue;
        }

        if (threadOutcome && threadOutcome.type === "replied") {
          row.status = "replied";
          row.active_step = "done";
          row.reply_detected_at = row.reply_detected_at || nowIso_();
          row.error = "";
          row.updated_at = nowIso_();
          writeRowObject_(queueSheet, rowNumber, row, values[0]);
          continue;
        }
      }

      try {
        const sent = processQueuedStep_(row, nextStep, settings);
        row.updated_at = nowIso_();
        if (row.status !== "bounced") {
          row.error = "";
        }
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
        if (sent) {
          sendCount += 1;
          const sentMs = Date.now();
          pacing.lastSendMs = sentMs;
          pacing.hourLog.push(sentMs);
          pacing.daily.count += 1;
          if (recipientDomain) {
            pacing.domainLast[recipientDomain] = sentMs;
          }
        }
      } catch (error) {
        row.status = "failed";
        row.error = error instanceof Error ? error.message : String(error);
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
      }
    }

    if (sendCount > 0) {
      savePacingState_(pacing);
    }

    archiveTerminalRows_(spreadsheet, queueSheet);
  } finally {
    lock.releaseLock();
  }
}

function archiveTerminalRowsNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return;
  }
  try {
    const spreadsheet = getOutreachSpreadsheet_();
    const queueSheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.QUEUE);
    if (!queueSheet) {
      return;
    }
    archiveTerminalRows_(spreadsheet, queueSheet);
  } finally {
    lock.releaseLock();
  }
}

function archiveTerminalRows_(spreadsheet, queueSheet) {
  const values = queueSheet.getDataRange().getValues();
  if (values.length < 2) {
    return 0;
  }

  const headers = values[0];
  const statusIndex = headers.indexOf("status");
  if (statusIndex === -1) {
    return 0;
  }

  const terminalRows = [];
  const terminalRowNumbers = [];
  for (let i = 1; i < values.length; i += 1) {
    const status = String(values[i][statusIndex] || "").trim();
    if (OUTREACH_TERMINAL_STATUSES.indexOf(status) === -1) {
      continue;
    }
    terminalRows.push(values[i]);
    terminalRowNumbers.push(i + 1);
  }

  if (terminalRows.length === 0) {
    return 0;
  }

  const archiveSheet = ensureArchiveSheet_(spreadsheet);
  const appendStartRow = archiveSheet.getLastRow() + 1;
  archiveSheet
    .getRange(appendStartRow, 1, terminalRows.length, headers.length)
    .setValues(terminalRows);

  // Coalesce the row numbers into contiguous ranges so we can use deleteRows
  // (start, count) instead of N individual deleteRow calls. A queue with 500
  // archived rows would otherwise issue 500 separate Sheets writes.
  const ranges = [];
  let runStart = terminalRowNumbers[0];
  let runLength = 1;
  for (let i = 1; i < terminalRowNumbers.length; i += 1) {
    if (terminalRowNumbers[i] === runStart + runLength) {
      runLength += 1;
    } else {
      ranges.push({ start: runStart, length: runLength });
      runStart = terminalRowNumbers[i];
      runLength = 1;
    }
  }
  ranges.push({ start: runStart, length: runLength });

  // Delete from the bottom up so earlier indices stay valid.
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    queueSheet.deleteRows(ranges[i].start, ranges[i].length);
  }

  // Adjust (don't reset) the round-robin cursor used by checkRepliesAndBounces:
  // each row deleted *before* the cursor shifts the cursor down by one. A blind
  // deleteProperty would force every cycle to restart at row 2, which means
  // the tail of the queue would never get scanned for replies/bounces.
  const props = PropertiesService.getScriptProperties();
  const cursorStr = props.getProperty("REPLY_CHECK_CURSOR");
  if (cursorStr) {
    const cursor = Number(cursorStr);
    if (Number.isFinite(cursor) && cursor > 1) {
      let removedBeforeCursor = 0;
      for (let i = 0; i < terminalRowNumbers.length; i += 1) {
        if (terminalRowNumbers[i] < cursor) {
          removedBeforeCursor += 1;
        }
      }
      if (removedBeforeCursor > 0) {
        const newCursor = Math.max(1, cursor - removedBeforeCursor);
        props.setProperty("REPLY_CHECK_CURSOR", String(newCursor));
      }
    }
  }

  return terminalRows.length;
}

function checkRepliesAndBounces() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return;
  }

  try {
    var spreadsheet = getOutreachSpreadsheet_();
    var queueSheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.QUEUE);
    if (!queueSheet) {
      return;
    }

    var settings = getOutreachSettings_(spreadsheet);
    var values = queueSheet.getDataRange().getValues();
    if (values.length < 2) {
      return;
    }

    var startMs = Date.now();
    var maxRuntimeMs = 4.5 * 60 * 1000;
    var checksPerRun = 60;
    var checksCount = 0;

    var startIndex = getReplyCheckCursor_();
    if (startIndex < 1 || startIndex >= values.length) {
      startIndex = 1;
    }

    var i = startIndex;
    var looped = false;

    while (checksCount < checksPerRun && (Date.now() - startMs) < maxRuntimeMs) {
      if (i >= values.length) {
        i = 1;
        looped = true;
      }
      if (looped && i >= startIndex) {
        break;
      }

      var rowNumber = i + 1;
      var row = rowValuesToObject_(values[i], values[0]);
      i += 1;

      if (!row.recipient_email || !row.subject) {
        continue;
      }

      var status = String(row.status || "").trim();
      if (OUTREACH_TERMINAL_STATUSES.indexOf(status) !== -1) {
        continue;
      }

      if (!row.gmail_thread_id) {
        continue;
      }

      checksCount += 1;

      var threadOutcome = getQueuedThreadOutcome_(row, settings);
      if (threadOutcome && threadOutcome.type === "bounced") {
        row.status = "bounced";
        row.active_step = "done";
        row.error = threadOutcome.reason || "Bounce detected for recipient.";
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
        appendToBlacklist_(queueSheet.getParent(), row.recipient_email, row.error, rowNumber);
        continue;
      }

      if (threadOutcome && threadOutcome.type === "replied") {
        row.status = "replied";
        row.active_step = "done";
        row.reply_detected_at = row.reply_detected_at || nowIso_();
        row.error = "";
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
        continue;
      }
    }

    setReplyCheckCursor_(i);
  } finally {
    lock.releaseLock();
  }
}

function getReplyCheckCursor_() {
  var value = PropertiesService.getScriptProperties().getProperty("REPLY_CHECK_CURSOR");
  return value ? Number(value) : 1;
}

function setReplyCheckCursor_(index) {
  PropertiesService.getScriptProperties().setProperty("REPLY_CHECK_CURSOR", String(index));
}

function processQueuedStep_(row, step, settings) {
  if (step === "main") {
    const mainSent = sendQueuedMessage_(row, step);
    row.gmail_thread_id = mainSent.threadId;
    row.root_message_id = mainSent.headerMessageId;
    row.last_message_id = mainSent.headerMessageId;
    row.sender_email = row.sender_email || settings.sender_email || mainSent.fromEmail || "";
    row.main_sent_at = mainSent.sentAt;
    row.last_sent_at = mainSent.sentAt;

    const nextStep = getNextConfiguredStepAfter_(row, "main");
    if (nextStep) {
      row.status = "sent_main";
      row.active_step = nextStep;
    } else {
      row.status = "completed";
      row.active_step = "done";
    }
    return true;
  }

  // Reply/bounce gating already happened in processQueue right before this
  // call (and on a separate schedule via checkRepliesAndBounces). Doing it
  // again here would double the per-send Gmail-API cost for every follow-up.
  const followUpSent = sendQueuedMessage_(row, step);
  row.last_message_id = followUpSent.headerMessageId;
  row[OUTREACH_STEP_CONFIG[step].sentAtHeader] = followUpSent.sentAt;
  row.last_sent_at = followUpSent.sentAt;

  const nextStep = getNextConfiguredStepAfter_(row, step);
  if (nextStep) {
    row.status = step === "follow_up_1" ? "sent_follow_up_1" : "sent_follow_up_2";
    row.active_step = nextStep;
  } else {
    row.status = "completed";
    row.active_step = "done";
  }
  return true;
}

function getNextDueStep_(row, now) {
  for (let i = 0; i < OUTREACH_STEP_ORDER.length; i += 1) {
    const step = OUTREACH_STEP_ORDER[i];
    if (!isStepConfigured_(row, step)) {
      continue;
    }

    if (hasStepBeenSent_(row, step)) {
      continue;
    }

    if (step !== "main" && !row.gmail_thread_id) {
      return null;
    }

    const dueAt = parseDateValue_(row[OUTREACH_STEP_CONFIG[step].scheduleHeader]);
    if (!dueAt || dueAt.getTime() > now.getTime()) {
      return null;
    }

    return step;
  }

  return hasAnyConfiguredPendingStep_(row) ? null : "complete";
}

function hasAnyConfiguredPendingStep_(row) {
  for (let i = 0; i < OUTREACH_STEP_ORDER.length; i += 1) {
    const step = OUTREACH_STEP_ORDER[i];
    if (isStepConfigured_(row, step) && !hasStepBeenSent_(row, step)) {
      return true;
    }
  }
  return false;
}

function getNextConfiguredStepAfter_(row, currentStep) {
  const currentIndex = OUTREACH_STEP_ORDER.indexOf(currentStep);
  for (let i = currentIndex + 1; i < OUTREACH_STEP_ORDER.length; i += 1) {
    const step = OUTREACH_STEP_ORDER[i];
    if (isStepConfigured_(row, step) && !hasStepBeenSent_(row, step)) {
      return step;
    }
  }
  return "";
}

function isStepConfigured_(row, step) {
  const config = OUTREACH_STEP_CONFIG[step];
  return Boolean(row[config.htmlHeader] && row[config.scheduleHeader]);
}

function hasStepBeenSent_(row, step) {
  return Boolean(row[OUTREACH_STEP_CONFIG[step].sentAtHeader]);
}

function getOutreachSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    OUTREACH_SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID
  );
  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOutreachSettings_(spreadsheet) {
  const settingsSheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.SETTINGS);
  const settings = {};

  if (!settingsSheet || settingsSheet.getLastRow() < 2) {
    return settings;
  }

  const rows = settingsSheet.getRange(2, 1, settingsSheet.getLastRow() - 1, 3).getValues();
  for (let i = 0; i < rows.length; i += 1) {
    const key = String(rows[i][0] || "").trim();
    if (!key) {
      continue;
    }
    settings[key] = String(rows[i][1] || "").trim();
  }

  return settings;
}

function rowValuesToObject_(rowValues, headers) {
  const row = {};
  for (let i = 0; i < headers.length; i += 1) {
    row[String(headers[i])] = rowValues[i];
  }
  return row;
}

function writeRowObject_(sheet, rowNumber, rowObject, headers) {
  const rowValues = [];
  for (let i = 0; i < headers.length; i += 1) {
    const key = String(headers[i]);
    rowValues.push(Object.prototype.hasOwnProperty.call(rowObject, key) ? rowObject[key] : "");
  }
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([rowValues]);
}

function parseDateValue_(value) {
  if (!value) {
    return null;
  }
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isWithinBusinessWindow_(date, settings) {
  const timezone = settings.timezone || "America/Los_Angeles";
  const parts = Utilities.formatDate(date, timezone, "u,H");
  const split = parts.split(",");
  const weekday = Number(split[0]);
  const hour = Number(split[1]);
  const allowWeekends = String(settings.allow_weekends || "").trim().toLowerCase() === "true";
  const startHour = settingNumber_(settings.send_start_hour, 9);
  const endHour = settingNumber_(settings.send_end_hour, 17);

  if (!allowWeekends && weekday >= 6) {
    return false;
  }

  return hour >= startHour && hour < endHour;
}

// True when `date` falls inside the business window of ANY supported US zone.
// Used as a cheap run-level short-circuit; the per-row check is authoritative.
function isWithinAnyBusinessWindow_(date, settings) {
  for (let i = 0; i < OUTREACH_BUSINESS_ENVELOPE_ZONES.length; i += 1) {
    const zoneSettings = cloneSettingsWithZone_(settings, OUTREACH_BUSINESS_ENVELOPE_ZONES[i]);
    if (isWithinBusinessWindow_(date, zoneSettings)) {
      return true;
    }
  }
  return false;
}

// Shallow settings copy with the timezone overridden (start/end hours and
// allow_weekends are preserved).
function cloneSettingsWithZone_(settings, timezone) {
  const copy = {};
  for (const key in settings) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      copy[key] = settings[key];
    }
  }
  copy.timezone = timezone;
  return copy;
}

// Business-window settings for a specific queue row: prefer the row's
// recipient_timezone, fall back to the global timezone.
function recipientWindowSettings_(row, settings) {
  const tz = String(row.recipient_timezone || "").trim();
  if (!tz) {
    return settings;
  }
  return cloneSettingsWithZone_(settings, tz);
}

function recipientDomain_(email) {
  const at = String(email || "").indexOf("@");
  if (at === -1) {
    return "";
  }
  return String(email).slice(at + 1).trim().toLowerCase();
}

// --- Send-pacing state (persisted in ScriptProperties as one JSON blob) ---
function loadPacingState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(OUTREACH_PACING_PROP_KEY);
  const empty = { lastSendMs: 0, hourLog: [], daily: { date: "", count: 0 }, domainLast: {} };
  if (!raw) {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      lastSendMs: Number(parsed.lastSendMs) || 0,
      hourLog: Array.isArray(parsed.hourLog) ? parsed.hourLog : [],
      daily:
        parsed.daily && typeof parsed.daily === "object"
          ? { date: String(parsed.daily.date || ""), count: Number(parsed.daily.count) || 0 }
          : { date: "", count: 0 },
      domainLast:
        parsed.domainLast && typeof parsed.domainLast === "object" ? parsed.domainLast : {},
    };
  } catch (error) {
    return empty;
  }
}

function savePacingState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    OUTREACH_PACING_PROP_KEY,
    JSON.stringify(state)
  );
}

// Reset the daily counter when the local date rolls over, drop hour-log entries
// older than 60 minutes, and forget per-domain timestamps older than 24h.
function prunePacingState_(state, nowMs, dailyKey) {
  if (state.daily.date !== dailyKey) {
    state.daily.date = dailyKey;
    state.daily.count = 0;
  }
  const hourAgo = nowMs - 60 * 60 * 1000;
  state.hourLog = state.hourLog.filter(function (ts) {
    return Number(ts) >= hourAgo;
  });
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const prunedDomains = {};
  for (const domain in state.domainLast) {
    if (Object.prototype.hasOwnProperty.call(state.domainLast, domain)) {
      if (Number(state.domainLast[domain]) >= dayAgo) {
        prunedDomains[domain] = state.domainLast[domain];
      }
    }
  }
  state.domainLast = prunedDomains;
}

// Parse a Settings-sheet numeric value, treating "" / null / undefined / NaN as
// "not set" (use fallback). Critically, "0" is a valid value here — a plain
// `Number(value || fallback)` would silently swap zero for the fallback, so a
// user could not, for example, set max_send_per_run=0 to pause sending.
function settingNumber_(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return fallback;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso_() {
  return new Date().toISOString();
}

function normalizeEmail_(value) {
  return String(value || "").trim().toLowerCase();
}

function sendQueuedMessage_(row, step) {
  const config = OUTREACH_STEP_CONFIG[step];
  const raw = buildRawMime_({
    to: row.recipient_email,
    subject: row.subject,
    html: row[config.htmlHeader],
    attachmentFileId: step === "main" ? String(row.attachment_file_id || "").trim() : "",
    inReplyTo: step === "main" ? "" : row.last_message_id || row.root_message_id || "",
    references: step === "main" ? "" : row.last_message_id || row.root_message_id || "",
  });

  const request = {
    raw: raw,
  };

  if (step !== "main" && row.gmail_thread_id) {
    request.threadId = row.gmail_thread_id;
  }

  const sent = Gmail.Users.Messages.send(request, "me");
  const metadata = Gmail.Users.Messages.get("me", sent.id, {
    format: "metadata",
    metadataHeaders: ["From", "Message-ID", "References", "Subject"],
  });
  const headers = metadata.payload && metadata.payload.headers ? metadata.payload.headers : [];
  const fromHeader = gmailHeader_(headers, "From");

  return {
    gmailMessageId: sent.id,
    threadId: sent.threadId,
    headerMessageId: gmailHeader_(headers, "Message-ID"),
    references: gmailHeader_(headers, "References"),
    from: fromHeader,
    fromEmail: extractEmail_(fromHeader),
    sentAt: new Date(Number(metadata.internalDate || Date.now())).toISOString(),
  };
}

function getQueuedThreadOutcome_(row, settings) {
  const senderEmail = normalizeEmail_(row.sender_email || settings.sender_email || "");
  const recipientEmail = normalizeEmail_(row.recipient_email || "");

  // Inspect just the existing Gmail thread for this row. Most DSN bounces are
  // delivered as a reply to the original send, so they show up here.
  // The previous "in:anywhere from:mailer-daemon" fallback issued an extra
  // Gmail search + messages.get per row — at queue scale that exceeds Gmail's
  // 20k/day quota and starves the rest of the script.
  return detectThreadOutcome_(
    row.gmail_thread_id,
    senderEmail,
    recipientEmail,
    row.root_message_id,
    row.last_message_id
  );
}

function detectThreadOutcome_(threadId, senderEmail, recipientEmail, rootMessageId, lastMessageId) {
  if (!threadId) {
    return null;
  }

  const thread = Gmail.Users.Threads.get("me", threadId, {
    format: "metadata",
    metadataHeaders: ["From", "To", "Message-ID", "Subject", "Auto-Submitted", "X-Failed-Recipients"],
  });
  const messages = thread.messages || [];
  const ignoreIds = {};
  if (rootMessageId) {
    ignoreIds[rootMessageId] = true;
  }
  if (lastMessageId) {
    ignoreIds[lastMessageId] = true;
  }

  for (let i = 0; i < messages.length; i += 1) {
    const headers = messages[i].payload && messages[i].payload.headers ? messages[i].payload.headers : [];
    const messageId = gmailHeader_(headers, "Message-ID");
    if (messageId && ignoreIds[messageId]) {
      continue;
    }

    const fromHeader = gmailHeader_(headers, "From");
    const fromEmail = extractEmail_(fromHeader);
    const subject = gmailHeader_(headers, "Subject");
    const autoSubmitted = gmailHeader_(headers, "Auto-Submitted");
    const failedRecipients = gmailHeader_(headers, "X-Failed-Recipients");
    const toHeader = gmailHeader_(headers, "To");

    if (isBounceMessage_({
      fromEmail: fromEmail,
      subject: subject,
      autoSubmitted: autoSubmitted,
      failedRecipients: failedRecipients,
      toHeader: toHeader,
      recipientEmail: recipientEmail,
    })) {
      return {
        type: "bounced",
        reason: buildBounceReason_(recipientEmail, subject, failedRecipients, fromHeader),
      };
    }

    if (fromEmail && senderEmail && fromEmail !== senderEmail) {
      return {
        type: "replied",
        fromEmail: fromEmail,
      };
    }
  }

  return null;
}

function isBounceMessage_(message) {
  const fromEmail = normalizeEmail_(message.fromEmail || "");
  const subject = String(message.subject || "");
  const autoSubmitted = String(message.autoSubmitted || "").toLowerCase();
  const failedRecipients = String(message.failedRecipients || "");
  const toHeader = String(message.toHeader || "");
  const recipientEmail = normalizeEmail_(message.recipientEmail || "");
  const fromLooksLikeBounce =
    fromEmail.indexOf("mailer-daemon") !== -1 || fromEmail.indexOf("postmaster") !== -1;
  const autoLooksGenerated =
    autoSubmitted === "auto-replied" || autoSubmitted === "auto-generated";
  const subjectLooksLikeBounce = isBounceLikeSubject_(subject);

  // Tier 1: recipient explicitly named in X-Failed-Recipients or the DSN's To
  // header. Any single bounce-like signal then confirms. (Cheapest case: a
  // full MTA like Postfix or Exchange.)
  if (
    recipientEmail &&
    (headerContainsEmail_(failedRecipients, recipientEmail) ||
      headerContainsEmail_(toHeader, recipientEmail))
  ) {
    return fromLooksLikeBounce || autoLooksGenerated || subjectLooksLikeBounce;
  }

  // Tier 2: we can't match the recipient in the headers. This happens with
  // Gmail intra-domain bounces -- the DSN's To is the SENDER, and Gmail does
  // not populate X-Failed-Recipients; the bad address lives only in the body.
  //
  // Anchor on the one signal real users essentially never forge: a From
  // address of mailer-daemon@ or postmaster@. Pair it with either a
  // bounce-like subject or an Auto-Submitted header so a human who happens
  // to be named "Postmaster" replying normally isn't flagged.
  return fromLooksLikeBounce && (subjectLooksLikeBounce || autoLooksGenerated);
}

function isBounceLikeSubject_(subject) {
  const value = String(subject || "").toLowerCase();
  const patterns = [
    "delivery status notification",
    "delivery failure",
    "undeliverable",
    "returned mail",
    "delivery incomplete",
    "message blocked",
    "delivery has failed",
    "failure notice",
  ];

  for (let i = 0; i < patterns.length; i += 1) {
    if (value.indexOf(patterns[i]) !== -1) {
      return true;
    }
  }

  return false;
}

function headerContainsEmail_(headerValue, email) {
  return Boolean(email) && normalizeEmail_(headerValue || "").indexOf(email) !== -1;
}

function buildBounceReason_(recipientEmail, subject, failedRecipients, fromHeader) {
  const pieces = ["Bounce detected for " + recipientEmail + "."];
  if (subject) {
    pieces.push("Subject: " + subject + ".");
  }
  if (failedRecipients) {
    pieces.push("Failed recipients: " + failedRecipients + ".");
  }
  if (fromHeader) {
    pieces.push("From: " + fromHeader + ".");
  }
  return pieces.join(" ");
}

function buildRawMime_(message) {
  // Strip CR/LF from every header value to prevent MIME header injection
  // (e.g. a recipient_email or subject containing "\r\nBcc: attacker@x.com"
  // would otherwise inject a Bcc header). Defense in depth: even though our
  // inputs come from our own sheet, an imported CSV or pasted contact name
  // could contain a stray newline.
  const safeTo = sanitizeHeaderValue_(message.to);
  const safeSubject = sanitizeHeaderValue_(message.subject);
  const safeInReplyTo = sanitizeHeaderValue_(message.inReplyTo);
  const safeReferences = sanitizeHeaderValue_(message.references);

  const headers = [
    "MIME-Version: 1.0",
    "To: " + safeTo,
    "Subject: " + encodeHeaderRfc2047_(safeSubject),
  ];

  if (safeInReplyTo) {
    headers.push("In-Reply-To: " + safeInReplyTo);
  }
  if (safeReferences) {
    headers.push("References: " + safeReferences);
  }

  // Encode the HTML body as base64 with explicit UTF-8 charset. The previous
  // 7bit encoding silently corrupted any byte > 0x7F (em dashes, smart quotes,
  // currency symbols, accented characters) once the message hit Gmail's
  // outbound MIME pipeline. base64 is binary-safe and survives every MTA.
  const htmlBody = chunkBase64_(
    Utilities.base64Encode(Utilities.newBlob(String(message.html || ""), "text/html").getBytes())
  );

  if (message.attachmentFileId) {
    const file = DriveApp.getFileById(message.attachmentFileId);
    const blob = file.getBlob();
    const filename = sanitizeHeaderValue_(file.getName());
    const boundary = "mixed_" + Utilities.getUuid().replace(/-/g, "");
    const attachmentBody = chunkBase64_(Utilities.base64Encode(blob.getBytes()));
    const mime = [
      headers.join("\r\n"),
      'Content-Type: multipart/mixed; boundary="' + boundary + '"',
      "",
      "--" + boundary,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      htmlBody,
      "",
      "--" + boundary,
      "Content-Type: " + (blob.getContentType() || "application/octet-stream") + '; name="' + filename + '"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="' + filename + '"',
      "",
      attachmentBody,
      "--" + boundary + "--",
    ].join("\r\n");
    return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime, "message/rfc822").getBytes());
  }

  const mime = [
    headers.join("\r\n"),
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlBody,
  ].join("\r\n");

  return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime, "message/rfc822").getBytes());
}

// Encode a header value containing non-ASCII bytes per RFC 2047 ("encoded-word").
// Required for Subject lines with em dashes (—), smart quotes, accented chars,
// or any UTF-8 character. Without this, raw UTF-8 bytes in headers are misread
// as Latin-1 by many mail clients, producing mojibake like "Ã¢Â€Â"" instead of "—".
function encodeHeaderRfc2047_(value) {
  const text = String(value == null ? "" : value);
  let needsEncoding = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) {
      needsEncoding = true;
      break;
    }
  }
  if (!needsEncoding) {
    return text;
  }
  const bytes = Utilities.newBlob(text, "text/plain").getBytes();
  return "=?UTF-8?B?" + Utilities.base64Encode(bytes) + "?=";
}

function chunkBase64_(value) {
  return String(value || "").replace(/.{1,76}/g, "$&\r\n").trim();
}

function gmailHeader_(headers, name) {
  for (let i = 0; i < headers.length; i += 1) {
    if (String(headers[i].name || "").toLowerCase() === String(name).toLowerCase()) {
      return headers[i].value || "";
    }
  }
  return "";
}

function extractEmail_(value) {
  const text = String(value || "").trim();
  const match = text.match(/<([^>]+)>/);
  return normalizeEmail_(match ? match[1] : text);
}

function sanitizeHeaderValue_(value) {
  // Strip CR/LF (header-injection guard) and double quotes (which would
  // corrupt quoted-string headers like Content-Disposition filenames).
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "")
    .trim();
}

function appendToBlacklist_(spreadsheet, email, reason, sourceRow) {
  if (!email) return;
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) return;
  const name = (OUTREACH_SHEET_NAMES && OUTREACH_SHEET_NAMES.BLACKLIST) || "Blacklist";
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet
      .getRange(1, 1, 1, 4)
      .setValues([["email", "reason", "first_observed_at", "source_queue_row"]])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() > 1) {
    const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < existing.length; i += 1) {
      if (String(existing[i][0]).trim().toLowerCase() === normalized) return;
    }
  }
  sheet.appendRow([normalized, String(reason || "bounced"), nowIso_(), sourceRow || ""]);
}
