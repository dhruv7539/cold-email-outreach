#!/usr/bin/env node

import {
  authorizeWithLocalServer,
  getDefaultSheetsOauthPaths,
  GOOGLE_SHEETS_SCOPE,
} from "./google-oauth.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { oauthPath, credentialsPath } = getDefaultSheetsOauthPaths(args);

  const result = await authorizeWithLocalServer({
    oauthPath,
    credentialsPath,
    scopes: [GOOGLE_SHEETS_SCOPE],
    port: Number(args.port || 3000),
    host: args.host || "127.0.0.1",
    openCommand: args.open === "true",
  });

  console.log(
    JSON.stringify(
      {
        credentialsPath,
        scope: result.credentials.scope,
        redirectUri: result.redirectUri,
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

