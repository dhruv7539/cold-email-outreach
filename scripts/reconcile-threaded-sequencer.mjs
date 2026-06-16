#!/usr/bin/env node

import { getAccessToken, getDefaultOauthPaths } from "./gmail-api.mjs";
import { getSheetsAccessToken, getSheetValues, updateSheetValues } from "./sheets-api.mjs";
import { getOutreachSpreadsheetId } from "./config.mjs";
const DEFAULT_RANGE = "Queue!A1:AB2000";
const TERMINAL_STATUSES = new Set(["completed", "replied", "bounced", "cancelled", "failed"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
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

function getHeaderMap(headers = []) {
  const map = new Map();
  for (const header of headers) {
    if (!header?.name) {
      continue;
    }
    map.set(String(header.name).toLowerCase(), header.value ?? "");
  }
  return map;
}

function getHeader(headers, name) {
  return getHeaderMap(headers).get(String(name).toLowerCase()) ?? "";
}

function isBounceLikeSubject(subject) {
  const value = String(subject || "").toLowerCase();
  return [
    "delivery status notification",
    "delivery failure",
    "undeliverable",
    "returned mail",
    "delivery incomplete",
    "message blocked",
    "delivery has failed",
    "failure notice",
  ].some((pattern) => value.includes(pattern));
}

function headerContainsEmail(headerValue, email) {
  return Boolean(email) && normalizeEmail(headerValue || "").includes(email);
}

function isBounceMessage({ fromEmail, subject, autoSubmitted, failedRecipients, recipientEmail }) {
  const normalizedFrom = normalizeEmail(fromEmail || "");
  const normalizedRecipient = normalizeEmail(recipientEmail || "");
  const autoValue = String(autoSubmitted || "").toLowerCase();
  const fromLooksLikeBounce =
    normalizedFrom.includes("mailer-daemon") || normalizedFrom.includes("postmaster");
  const autoLooksGenerated =
    autoValue === "auto-replied" || autoValue === "auto-generated";
  const recipientMatched = headerContainsEmail(failedRecipients, normalizedRecipient);

  if (recipientMatched && (fromLooksLikeBounce || autoLooksGenerated || isBounceLikeSubject(subject))) {
    return true;
  }

  return fromLooksLikeBounce && isBounceLikeSubject(subject);
}

function buildBounceReason(recipientEmail, subject, failedRecipients, fromHeader) {
  const parts = [`Bounce detected for ${recipientEmail}.`];
  if (subject) {
    parts.push(`Subject: ${subject}.`);
  }
  if (failedRecipients) {
    parts.push(`Failed recipients: ${failedRecipients}.`);
  }
  if (fromHeader) {
    parts.push(`From: ${fromHeader}.`);
  }
  return parts.join(" ");
}

async function gmailRequest(accessToken, pathname) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail API request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function getThread(accessToken, threadId) {
  const params = new URLSearchParams({
    format: "metadata",
    metadataHeaders: "From",
  });
  params.append("metadataHeaders", "Message-ID");
  params.append("metadataHeaders", "Subject");
  params.append("metadataHeaders", "Auto-Submitted");
  params.append("metadataHeaders", "X-Failed-Recipients");
  return gmailRequest(accessToken, `threads/${encodeURIComponent(threadId)}?${params.toString()}`);
}

function detectThreadOutcome(thread, row) {
  const ignoreIds = new Set(
    [row.root_message_id, row.last_message_id]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const senderEmail = normalizeEmail(row.sender_email || "");
  const recipientEmail = normalizeEmail(row.recipient_email || "");

  for (const message of thread.messages || []) {
    const headers = message.payload?.headers || [];
    const messageId = getHeader(headers, "Message-ID");
    if (messageId && ignoreIds.has(messageId)) {
      continue;
    }

    const fromHeader = getHeader(headers, "From");
    const fromEmail = normalizeEmail(fromHeader);
    const subject = getHeader(headers, "Subject");
    const autoSubmitted = getHeader(headers, "Auto-Submitted");
    const failedRecipients = getHeader(headers, "X-Failed-Recipients");

    if (
      isBounceMessage({
        fromEmail,
        subject,
        autoSubmitted,
        failedRecipients,
        recipientEmail,
      })
    ) {
      return {
        type: "bounced",
        detectedAt: new Date(Number(message.internalDate || Date.now())).toISOString(),
        reason: buildBounceReason(recipientEmail, subject, failedRecipients, fromHeader),
      };
    }

    if (fromEmail && senderEmail && fromEmail !== senderEmail) {
      return {
        type: "replied",
        detectedAt: new Date(Number(message.internalDate || Date.now())).toISOString(),
        fromEmail,
      };
    }
  }

  return null;
}

function rowObjectFromValues(headers, rowValues) {
  return Object.fromEntries(headers.map((header, index) => [header, rowValues[index] ?? ""]));
}

function rowValuesFromObject(headers, rowObject) {
  return headers.map((header) => rowObject[header] ?? "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = args["spreadsheet-id"] ?? getOutreachSpreadsheetId();
  const range = args.range ?? DEFAULT_RANGE;
  const apply = args.apply === "true";

  const { accessToken: gmailAccessToken } = await (async () => {
    const { oauthPath, credentialsPath } = getDefaultOauthPaths();
    const accessToken = await getAccessToken(oauthPath, credentialsPath);
    return { accessToken };
  })();
  const { accessToken: sheetsAccessToken } = await getSheetsAccessToken();

  const sheet = await getSheetValues(sheetsAccessToken, spreadsheetId, range);
  const [headers = [], ...rows] = sheet.values || [];
  if (headers.length === 0) {
    throw new Error(`No headers found in ${range}`);
  }

  const changes = [];

  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = i + 2;
    const row = rowObjectFromValues(headers, rows[i]);
    const status = String(row.status || "").trim();

    if (TERMINAL_STATUSES.has(status)) {
      continue;
    }

    if (!String(row.gmail_thread_id || "").trim()) {
      continue;
    }

    const thread = await getThread(gmailAccessToken, row.gmail_thread_id);
    const outcome = detectThreadOutcome(thread, row);
    if (!outcome) {
      continue;
    }

    const nextRow = { ...row };
    nextRow.active_step = "done";
    nextRow.updated_at = new Date().toISOString();

    if (outcome.type === "replied") {
      nextRow.status = "replied";
      nextRow.reply_detected_at = row.reply_detected_at || outcome.detectedAt;
      nextRow.error = "";
    } else if (outcome.type === "bounced") {
      nextRow.status = "bounced";
      nextRow.error = outcome.reason || row.error || "Bounce detected.";
    }

    changes.push({
      rowNumber,
      contactName: row.contact_name,
      company: row.company,
      recipientEmail: row.recipient_email,
      fromStatus: status,
      toStatus: nextRow.status,
      detectedAt: outcome.detectedAt,
      reason: outcome.reason || "",
      values: rowValuesFromObject(headers, nextRow),
    });
  }

  if (apply) {
    for (const change of changes) {
      await updateSheetValues(
        sheetsAccessToken,
        spreadsheetId,
        `Queue!A${change.rowNumber}:AB${change.rowNumber}`,
        [change.values]
      );
    }
  }

  const summary = {
    spreadsheetId,
    range,
    apply,
    scannedRows: rows.length,
    changesCount: changes.length,
    changes: changes.map(({ values, ...rest }) => rest),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
