#!/usr/bin/env node

import {
  buildRawMessage,
  createDraft,
  getAccessToken,
  getDefaultOauthPaths,
  loadSpec,
} from "./gmail-api.mjs";

async function main() {
  const specPath = process.argv[2];

  if (!specPath) {
    throw new Error("Usage: node scripts/create-gmail-html-drafts.mjs <spec-file>");
  }

  const spec = await loadSpec(specPath);
  const { oauthPath, credentialsPath } = getDefaultOauthPaths(spec);
  const accessToken = await getAccessToken(oauthPath, credentialsPath);

  const results = [];
  for (const draftSpec of spec.drafts) {
    const raw = await buildRawMessage(draftSpec, spec.defaultAttachmentPath);
    const created = await createDraft(accessToken, raw, draftSpec.threadId);
    results.push({
      key: draftSpec.key,
      to: draftSpec.to,
      subject: draftSpec.subject,
      draftId: created.id,
      messageId: created.message?.id ?? null,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
