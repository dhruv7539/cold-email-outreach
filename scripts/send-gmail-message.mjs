#!/usr/bin/env node

import {
  buildRawMessage,
  getAccessToken,
  getDefaultOauthPaths,
  sendMessage,
} from "./gmail-api.mjs";

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];

    if (value === undefined || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.to || !args.subject || (!args.html && !args.text)) {
    throw new Error(
      "Usage: node scripts/send-gmail-message.mjs --to <email> --subject <subject> (--html <html> | --text <text>) [--thread-id <id>] [--in-reply-to <message-id>] [--references <refs>] [--attachment-path <path>]"
    );
  }

  const { oauthPath, credentialsPath } = getDefaultOauthPaths(args);
  const accessToken = await getAccessToken(oauthPath, credentialsPath);

  const messageSpec = {
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    html: args.html,
    text: args.text,
    inReplyTo: args["in-reply-to"],
    references: args.references,
    attachmentPath: args["attachment-path"],
    attachmentFilename: args["attachment-filename"],
  };

  const raw = await buildRawMessage(messageSpec);
  const sent = await sendMessage(accessToken, raw, args["thread-id"]);

  console.log(
    JSON.stringify(
      {
        id: sent.id,
        threadId: sent.threadId,
        labelIds: sent.labelIds ?? [],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
