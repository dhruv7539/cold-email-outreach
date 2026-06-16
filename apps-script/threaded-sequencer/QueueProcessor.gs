function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    return;
  }

  try {
    const spreadsheet = getOutreachSpreadsheet_();
    const queueSheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.QUEUE);
    if (!queueSheet) {
      throw new Error("Queue sheet not found. Run setupOutreachSheet first.");
    }

    const settings = getOutreachSettings_(spreadsheet);
    if (!isWithinBusinessWindow_(new Date(), settings)) {
      return;
    }

    const values = queueSheet.getDataRange().getValues();
    if (values.length < 2) {
      return;
    }

    const maxSendPerRun = Number(settings.max_send_per_run || 5);
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

      const threadOutcome = getQueuedThreadOutcome_(row, settings);
      if (threadOutcome && threadOutcome.type === "bounced") {
        row.status = "bounced";
        row.active_step = "done";
        row.error = threadOutcome.reason || "Bounce detected for recipient.";
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
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

      if (sendCount >= maxSendPerRun) {
        continue;
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
        }
      } catch (error) {
        row.status = "failed";
        row.error = error instanceof Error ? error.message : String(error);
        row.updated_at = nowIso_();
        writeRowObject_(queueSheet, rowNumber, row, values[0]);
      }
    }
  } finally {
    lock.releaseLock();
  }
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

  const threadOutcome = getQueuedThreadOutcome_(row, settings);
  if (threadOutcome && threadOutcome.type === "bounced") {
    row.status = "bounced";
    row.active_step = "done";
    row.error = threadOutcome.reason || "Bounce detected for recipient.";
    return false;
  }

  if (threadOutcome && threadOutcome.type === "replied") {
    row.status = "replied";
    row.active_step = "done";
    row.reply_detected_at = nowIso_();
    return false;
  }

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
  const startHour = Number(settings.send_start_hour || 9);
  const endHour = Number(settings.send_end_hour || 17);

  if (!allowWeekends && weekday >= 6) {
    return false;
  }

  return hour >= startHour && hour < endHour;
}

function nowIso_() {
  return new Date().toISOString();
}

function normalizeEmail_(value) {
  return String(value || "").trim().toLowerCase();
}
