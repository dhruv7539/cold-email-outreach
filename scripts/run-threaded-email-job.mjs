#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRawMessage,
  getAccessToken,
  getDefaultOauthPaths,
  getHeader,
  getMessage,
  getThread,
  readJson,
  sendMessage,
  writeJson,
} from "./gmail-api.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(isoTimestamp) {
  while (true) {
    const remaining = new Date(isoTimestamp).getTime() - Date.now();
    if (remaining <= 0) {
      return;
    }

    await sleep(Math.min(remaining, 15_000));
  }
}

async function loadJob(jobPath) {
  return readJson(jobPath);
}

async function saveJob(jobPath, job) {
  await writeJson(jobPath, job);
}

function formatBody(bodySpec) {
  if (!bodySpec) {
    return {};
  }

  if (bodySpec.html) {
    return { html: bodySpec.html };
  }

  return { text: bodySpec.text };
}

async function sendScheduledMessage({ accessToken, job, phase }) {
  const bodySpec = phase === "main" ? job.main : job.followUp;
  const raw = await buildRawMessage(
    {
      to: job.to,
      subject: job.subject,
      ...formatBody(bodySpec),
      ...(phase === "followUp"
        ? {
            inReplyTo: job.threading?.lastMessageHeaderId ?? job.threading?.rootMessageHeaderId,
            references: job.threading?.references ?? job.threading?.rootMessageHeaderId,
          }
        : {}),
    },
    null
  );

  const sent = await sendMessage(accessToken, raw, phase === "followUp" ? job.threading?.threadId : undefined);
  const message = await getMessage(accessToken, sent.id, "metadata");
  const headers = message.payload?.headers ?? [];
  const headerMessageId = getHeader(headers, "Message-ID");
  const references = getHeader(headers, "References");
  const from = getHeader(headers, "From");

  return {
    gmailMessageId: sent.id,
    threadId: sent.threadId,
    headerMessageId,
    references,
    from,
    internalDate: message.internalDate,
  };
}

function threadHasExternalReply(thread, senderHeader) {
  const messages = thread.messages ?? [];
  const sender = (senderHeader ?? "").toLowerCase();

  for (const message of messages) {
    const headers = message.payload?.headers ?? [];
    const from = (getHeader(headers, "From") ?? "").toLowerCase();
    const messageId = getHeader(headers, "Message-ID");

    if (!from || !messageId) {
      continue;
    }

    if (messageId === thread.rootMessageHeaderId || messageId === thread.lastMessageHeaderId) {
      continue;
    }

    if (sender && !from.includes(sender)) {
      return true;
    }
  }

  return false;
}

async function run(jobPath) {
  const job = await loadJob(jobPath);
  const { oauthPath, credentialsPath } = getDefaultOauthPaths(job);
  const accessToken = await getAccessToken(oauthPath, credentialsPath);

  job.status = "scheduled";
  await saveJob(jobPath, job);

  await waitUntil(job.main.scheduledAt);
  job.status = "sending_main";
  await saveJob(jobPath, job);

  const mainSent = await sendScheduledMessage({ accessToken, job, phase: "main" });
  job.main.sent = {
    ...mainSent,
    sentAt: new Date().toISOString(),
  };
  job.threading = {
    threadId: mainSent.threadId,
    rootMessageHeaderId: mainSent.headerMessageId,
    lastMessageHeaderId: mainSent.headerMessageId,
    references: mainSent.references ?? mainSent.headerMessageId,
    senderFrom: mainSent.from,
  };
  job.status = "main_sent";
  await saveJob(jobPath, job);

  await waitUntil(job.followUp.scheduledAt);
  job.status = "checking_follow_up";
  await saveJob(jobPath, job);

  const thread = await getThread(accessToken, job.threading.threadId, "metadata");
  thread.rootMessageHeaderId = job.threading.rootMessageHeaderId;
  thread.lastMessageHeaderId = job.threading.lastMessageHeaderId;

  if (threadHasExternalReply(thread, job.threading.senderFrom)) {
    job.status = "follow_up_skipped_reply_detected";
    job.followUp.skipped = {
      skippedAt: new Date().toISOString(),
      reason: "reply_detected_in_thread",
    };
    await saveJob(jobPath, job);
    return;
  }

  job.status = "sending_follow_up";
  await saveJob(jobPath, job);

  const followUpSent = await sendScheduledMessage({ accessToken, job, phase: "followUp" });
  job.followUp.sent = {
    ...followUpSent,
    sentAt: new Date().toISOString(),
  };
  job.threading.lastMessageHeaderId = followUpSent.headerMessageId;
  job.threading.references = followUpSent.references ?? job.threading.references;
  job.status = "completed";
  await saveJob(jobPath, job);
}

async function main() {
  const jobPath = process.argv[2];

  if (!jobPath) {
    throw new Error("Usage: node scripts/run-threaded-email-job.mjs <job-json-path>");
  }

  await run(path.resolve(jobPath));
}

main().catch(async (error) => {
  const jobPath = process.argv[2];
  if (jobPath) {
    try {
      const resolved = path.resolve(jobPath);
      const job = await loadJob(resolved);
      job.status = "failed";
      job.error = {
        message: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      };
      await saveJob(resolved, job);
    } catch {
      // Ignore writeback failures in crash path.
    }
  }

  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
