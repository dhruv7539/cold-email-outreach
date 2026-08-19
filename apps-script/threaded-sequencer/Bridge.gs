// Bridge.gs — the hosted-product "pull bridge".
//
// This file is shipped ONLY in the hosted-product copy of the sheet, alongside
// Code.gs. It lets the sheet talk to the Outreach Hub without granting the Hub
// any Google access:
//
//   1. It reports local events (sends, replies, bounces) from the Queue/Archive
//      tabs up to the Hub.
//   2. It pulls approved rows the Hub has queued and appends them to the Queue.
//
// Everything runs under the sheet owner's own authorization. The Hub only ever
// sees a pairing token, event metadata, and (for opt-out handling) a short
// snippet of inbound replies. It never sees a Google credential.
//
// Config lives in the Settings tab: api_base_url and pairing_token.

var HUB_PROTOCOL_VERSION = 1;
var HUB_SYNC_LOCK_MS = 30 * 1000;
var HUB_CURSOR_PROP_KEY = "HUB_SYNC_CURSOR";
var HUB_SEEN_JOBS_PROP_KEY = "HUB_SEEN_JOB_IDS";

// Extends the Outreach Sequencer menu (called from Code.gs onOpen when present).
function addHubMenuItems_(menu) {
  return menu
    .addSeparator()
    .addItem("Connect to Hub (test)", "testHubConnection")
    .addItem("Sync With Hub Now", "syncWithHub")
    .addItem("Install Hub Sync Trigger", "installHubSyncTrigger")
    .addItem("Remove Hub Sync Trigger", "removeHubSyncTriggers");
}

function hubConfig_(settings) {
  var baseUrl = String((settings && settings.api_base_url) || "").trim().replace(/\/+$/, "");
  var token = String((settings && settings.pairing_token) || "").trim();
  if (!baseUrl || !token) {
    return null;
  }
  return { baseUrl: baseUrl, token: token };
}

function hubSenderEmail_(settings) {
  var configured = String((settings && settings.sender_email) || "").trim();
  if (configured) {
    return configured;
  }
  try {
    return Session.getActiveUser().getEmail() || "";
  } catch (err) {
    return "";
  }
}

function testHubConnection() {
  var ui = SpreadsheetApp.getUi();
  var spreadsheet = getOutreachSpreadsheet_();
  var settings = getOutreachSettings_(spreadsheet);
  var config = hubConfig_(settings);
  if (!config) {
    ui.alert(
      "Not configured",
      "Add api_base_url and pairing_token to the Settings tab first (get the token from the web app).",
      ui.ButtonSet.OK
    );
    return;
  }

  try {
    var response = hubPost_(config, "/api/agent/hello", { protocol: HUB_PROTOCOL_VERSION });
    if (response && response.ok) {
      ui.alert("Connected", "The sheet reached the Hub successfully.", ui.ButtonSet.OK);
    } else {
      ui.alert("Connection failed", "The Hub rejected the request. Check your pairing token.", ui.ButtonSet.OK);
    }
  } catch (err) {
    ui.alert("Connection failed", String(err), ui.ButtonSet.OK);
  }
}

function installHubSyncTrigger() {
  removeHubSyncTriggers();
  ScriptApp.newTrigger("syncWithHub").timeBased().everyMinutes(5).create();
}

function removeHubSyncTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i += 1) {
    if (triggers[i].getHandlerFunction() === "syncWithHub") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function syncWithHub() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(HUB_SYNC_LOCK_MS)) {
    return;
  }

  try {
    var spreadsheet = getOutreachSpreadsheet_();
    var settings = getOutreachSettings_(spreadsheet);
    var config = hubConfig_(settings);
    if (!config) {
      return;
    }

    var cursor = hubGetCursor_();
    var collected = hubCollectEvents_(spreadsheet, cursor);

    var response = hubPost_(config, "/api/agent/sync", {
      protocol: HUB_PROTOCOL_VERSION,
      cursor: cursor,
      sender_email: hubSenderEmail_(settings),
      events: collected.events,
    });

    if (!response) {
      return;
    }

    // Advance the cursor only after the Hub accepted the batch, so a failed POST
    // simply re-reports next run instead of dropping events.
    if (collected.maxUpdatedAt) {
      hubSetCursor_(collected.maxUpdatedAt);
    }

    if (response.rows && response.rows.length) {
      hubAppendRows_(spreadsheet, response.rows);
    }
  } catch (err) {
    console.error("syncWithHub failed: " + err);
  } finally {
    lock.releaseLock();
  }
}

function hubPost_(config, endpointPath, payload) {
  var response = UrlFetchApp.fetch(config.baseUrl + endpointPath, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + config.token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Hub responded " + code + ": " + response.getContentText().slice(0, 200));
  }
  return JSON.parse(response.getContentText());
}

function hubGetCursor_() {
  return PropertiesService.getScriptProperties().getProperty(HUB_CURSOR_PROP_KEY) || "";
}

function hubSetCursor_(iso) {
  PropertiesService.getScriptProperties().setProperty(HUB_CURSOR_PROP_KEY, iso);
}

// Reads Queue + Archive rows changed since the cursor and shapes them as events.
function hubCollectEvents_(spreadsheet, cursor) {
  var cursorTime = cursor ? new Date(cursor).getTime() : 0;
  var events = [];
  var maxUpdatedAt = cursor || "";

  var tabs = [OUTREACH_SHEET_NAMES.QUEUE, OUTREACH_SHEET_NAMES.ARCHIVE];
  for (var t = 0; t < tabs.length; t += 1) {
    var sheet = spreadsheet.getSheetByName(tabs[t]);
    if (!sheet) {
      continue;
    }
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      continue;
    }
    var header = values[0];
    var idx = {};
    for (var h = 0; h < header.length; h += 1) {
      idx[String(header[h])] = h;
    }

    for (var r = 1; r < values.length; r += 1) {
      var row = hubRowObject_(values[r], idx);
      var jobId = String(row.job_id || "").trim();
      if (!jobId) {
        continue;
      }
      var updatedIso = hubIso_(row.updated_at);
      var updatedTime = updatedIso ? new Date(updatedIso).getTime() : 0;
      if (cursorTime && updatedTime && updatedTime <= cursorTime) {
        continue;
      }
      if (updatedIso && updatedIso > maxUpdatedAt) {
        maxUpdatedAt = updatedIso;
      }

      var replyDetectedAt = hubIso_(row.reply_detected_at);

      events.push({
        job_id: jobId,
        status: String(row.status || ""),
        active_step: String(row.active_step || ""),
        location: tabs[t] === OUTREACH_SHEET_NAMES.ARCHIVE ? "archive" : "queue",
        gmail_thread_id: String(row.gmail_thread_id || ""),
        main_sent_at: hubIso_(row.main_sent_at),
        follow_up_1_sent_at: hubIso_(row.follow_up_1_sent_at),
        follow_up_2_sent_at: hubIso_(row.follow_up_2_sent_at),
        reply_detected_at: replyDetectedAt,
        updated_at: updatedIso,
        error: String(row.error || ""),
        // Only fetch a reply snippet when a reply was just detected, so we do not
        // re-read Gmail threads on every sync. Lets the Hub honor opt-outs.
        reply_snippet: replyDetectedAt ? hubReplySnippet_(row) : "",
      });
    }
  }

  return { events: events, maxUpdatedAt: maxUpdatedAt };
}

function hubRowObject_(rowValues, idx) {
  var obj = {};
  for (var key in idx) {
    if (Object.prototype.hasOwnProperty.call(idx, key)) {
      obj[key] = rowValues[idx[key]];
    }
  }
  return obj;
}

function hubIso_(value) {
  var parsed = parseDateValue_(value);
  return parsed ? parsed.toISOString() : "";
}

// The first ~300 chars of the most recent inbound message on a row's thread.
// Runs under the sheet owner's Gmail authorization (same scope Code.gs uses for
// reply detection), so no Gmail access is ever exposed to the Hub.
function hubReplySnippet_(row) {
  var threadId = String(row.gmail_thread_id || "").trim();
  if (!threadId) {
    return "";
  }
  try {
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) {
      return "";
    }
    var sender = String(row.sender_email || "").trim().toLowerCase();
    var messages = thread.getMessages();
    for (var i = messages.length - 1; i >= 0; i -= 1) {
      var from = String(messages[i].getFrom() || "").toLowerCase();
      if (sender && from.indexOf(sender) !== -1) {
        continue;
      }
      return String(messages[i].getPlainBody() || "").slice(0, 300);
    }
  } catch (err) {
    console.error("hubReplySnippet_ failed for thread " + threadId + ": " + err);
  }
  return "";
}

// Appends Hub rows to the Queue, skipping any job_id already present so repeated
// delivery of the same row (the Hub re-sends until it sees an event) is safe.
function hubAppendRows_(spreadsheet, rows) {
  var sheet = spreadsheet.getSheetByName(OUTREACH_SHEET_NAMES.QUEUE);
  if (!sheet) {
    return;
  }
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var seen = hubKnownJobIds_(spreadsheet);

  var toAppend = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var jobId = String(row.job_id || "").trim();
    if (!jobId || seen[jobId]) {
      continue;
    }
    seen[jobId] = true;
    var line = [];
    for (var c = 0; c < header.length; c += 1) {
      var key = String(header[c]);
      line.push(row[key] !== undefined && row[key] !== null ? row[key] : "");
    }
    toAppend.push(line);
  }

  if (toAppend.length) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, toAppend.length, header.length)
      .setValues(toAppend);
  }
}

function hubKnownJobIds_(spreadsheet) {
  var seen = {};
  var tabs = [OUTREACH_SHEET_NAMES.QUEUE, OUTREACH_SHEET_NAMES.ARCHIVE];
  for (var t = 0; t < tabs.length; t += 1) {
    var sheet = spreadsheet.getSheetByName(tabs[t]);
    if (!sheet) {
      continue;
    }
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      continue;
    }
    var jobCol = values[0].indexOf("job_id");
    if (jobCol === -1) {
      continue;
    }
    for (var r = 1; r < values.length; r += 1) {
      var jobId = String(values[r][jobCol] || "").trim();
      if (jobId) {
        seen[jobId] = true;
      }
    }
  }
  return seen;
}
