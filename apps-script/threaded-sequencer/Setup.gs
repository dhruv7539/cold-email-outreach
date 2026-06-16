// NOTE: Legacy stub. The real setup lives in Code.gs (setupOutreachSheet).
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Outreach Sequencer")
    .addItem("Setup Sheet", "setupOutreachSheet")
    .addItem("Install Trigger", "installOutreachTrigger")
    .addItem("Remove Trigger", "removeOutreachTriggers")
    .addToUi();
}

function setupOutreachSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty(
    OUTREACH_SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID,
    spreadsheet.getId()
  );

  const queueSheet = ensureSheet_(spreadsheet, OUTREACH_SHEET_NAMES.QUEUE);
  queueSheet.clear();
  queueSheet
    .getRange(1, 1, 1, OUTREACH_QUEUE_HEADERS.length)
    .setValues([OUTREACH_QUEUE_HEADERS])
    .setFontWeight("bold");
  queueSheet.setFrozenRows(1);

  const settingsSheet = ensureSheet_(spreadsheet, OUTREACH_SHEET_NAMES.SETTINGS);
  settingsSheet.clear();
  settingsSheet
    .getRange(1, 1, 1, OUTREACH_SETTINGS_HEADERS.length)
    .setValues([OUTREACH_SETTINGS_HEADERS])
    .setFontWeight("bold");
  settingsSheet
    .getRange(2, 1, OUTREACH_DEFAULT_SETTINGS.length, OUTREACH_DEFAULT_SETTINGS[0].length)
    .setValues(OUTREACH_DEFAULT_SETTINGS);
  settingsSheet.setFrozenRows(1);

}

function ensureBlacklistSheet_(spreadsheet) {
  const name = (typeof OUTREACH_SHEET_NAMES !== "undefined" && OUTREACH_SHEET_NAMES.BLACKLIST) || "Blacklist";
  const sheet = ensureSheet_(spreadsheet, name);
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, 4)
      .setValues([["email", "reason", "first_observed_at", "source_queue_row"]])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureRepliesSheet_(spreadsheet) {
  const name = (typeof OUTREACH_SHEET_NAMES !== "undefined" && OUTREACH_SHEET_NAMES.REPLIES) || "Replies";
  const headers = [
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
  const sheet = ensureSheet_(spreadsheet, name);
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureAnalyticsSheet_(spreadsheet) {
  const name = (typeof OUTREACH_SHEET_NAMES !== "undefined" && OUTREACH_SHEET_NAMES.ANALYTICS) || "Analytics";
  const headers = [
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
  const sheet = ensureSheet_(spreadsheet, name);
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function installOutreachTrigger() {
  removeOutreachTriggers();
  ScriptApp.newTrigger("processQueue").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("checkRepliesAndBounces").timeBased().everyMinutes(5).create();
}

function removeOutreachTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i += 1) {
    const handler = triggers[i].getHandlerFunction();
    if (handler === "processQueue" || handler === "checkRepliesAndBounces") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function ensureSheet_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}
