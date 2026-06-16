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
  const sinceDate = parseDateValue_(row.main_sent_at || row.last_sent_at || "");

  const threadOutcome = detectThreadOutcome_(
    row.gmail_thread_id,
    senderEmail,
    recipientEmail,
    row.root_message_id,
    row.last_message_id
  );
  if (threadOutcome) {
    return threadOutcome;
  }

  return detectRecentBounceForRecipient_(recipientEmail, sinceDate);
}

function detectThreadOutcome_(threadId, senderEmail, recipientEmail, rootMessageId, lastMessageId) {
  if (!threadId) {
    return null;
  }

  const thread = Gmail.Users.Threads.get("me", threadId, {
    format: "metadata",
    metadataHeaders: ["From", "Message-ID", "Subject", "Auto-Submitted", "X-Failed-Recipients"],
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

    if (isBounceMessage_({
      fromEmail: fromEmail,
      subject: subject,
      autoSubmitted: autoSubmitted,
      failedRecipients: failedRecipients,
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

function threadHasExternalReply_(threadId, senderEmail, rootMessageId, lastMessageId) {
  if (!threadId) {
    return false;
  }

  const thread = Gmail.Users.Threads.get("me", threadId, {
    format: "metadata",
    metadataHeaders: ["From", "Message-ID"],
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

    const fromEmail = extractEmail_(gmailHeader_(headers, "From"));
    if (fromEmail && senderEmail && fromEmail !== senderEmail) {
      return true;
    }
  }

  return false;
}

function detectRecentBounceForRecipient_(recipientEmail, sinceDate) {
  if (!recipientEmail || !sinceDate) {
    return null;
  }

  const query = [
    "in:anywhere",
    "from:(mailer-daemon OR postmaster)",
    "after:" + Utilities.formatDate(sinceDate, Session.getScriptTimeZone(), "yyyy/MM/dd"),
  ].join(" ");
  const listed = Gmail.Users.Messages.list("me", {
    q: query,
    maxResults: 25,
  });
  const messages = listed && listed.messages ? listed.messages : [];

  for (let i = 0; i < messages.length; i += 1) {
    const metadata = Gmail.Users.Messages.get("me", messages[i].id, {
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Auto-Submitted", "X-Failed-Recipients"],
    });
    const headers = metadata.payload && metadata.payload.headers ? metadata.payload.headers : [];
    const fromHeader = gmailHeader_(headers, "From");
    const subject = gmailHeader_(headers, "Subject");
    const autoSubmitted = gmailHeader_(headers, "Auto-Submitted");
    const failedRecipients = gmailHeader_(headers, "X-Failed-Recipients");
    const toHeader = gmailHeader_(headers, "To");

    if (
      isBounceMessage_({
        fromEmail: extractEmail_(fromHeader),
        subject: subject,
        autoSubmitted: autoSubmitted,
        failedRecipients: failedRecipients,
        recipientEmail: recipientEmail,
      }) ||
      (headerContainsEmail_(failedRecipients, recipientEmail) && isBounceLikeSubject_(subject)) ||
      (headerContainsEmail_(toHeader, recipientEmail) && isBounceLikeSubject_(subject))
    ) {
      return {
        type: "bounced",
        reason: buildBounceReason_(recipientEmail, subject, failedRecipients, fromHeader),
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
  const recipientEmail = normalizeEmail_(message.recipientEmail || "");
  const fromLooksLikeBounce =
    fromEmail.indexOf("mailer-daemon") !== -1 || fromEmail.indexOf("postmaster") !== -1;
  const autoLooksGenerated =
    autoSubmitted === "auto-replied" || autoSubmitted === "auto-generated";
  const recipientMatched = headerContainsEmail_(failedRecipients, recipientEmail);

  if (recipientMatched && (fromLooksLikeBounce || autoLooksGenerated || isBounceLikeSubject_(subject))) {
    return true;
  }

  return fromLooksLikeBounce && isBounceLikeSubject_(subject);
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
  const headers = [
    "MIME-Version: 1.0",
    "To: " + message.to,
    "Subject: " + message.subject,
  ];

  if (message.inReplyTo) {
    headers.push("In-Reply-To: " + message.inReplyTo);
  }
  if (message.references) {
    headers.push("References: " + message.references);
  }

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
      "Content-Transfer-Encoding: 7bit",
      "",
      message.html,
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
    "Content-Transfer-Encoding: 7bit",
    "",
    message.html,
  ].join("\r\n");

  return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime, "message/rfc822").getBytes());
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
  return String(value || "").replace(/"/g, "");
}
