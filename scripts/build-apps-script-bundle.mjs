#!/usr/bin/env node
// Concatenates the individual .gs files in apps-script/threaded-sequencer/
// into a single Code.gs under .clasp-push/ so `clasp push` can deploy from
// there. Apps Script has a flat namespace so file order matters only for
// readability — we keep the original order (Config, QueueProcessor,
// GmailService, Setup, Code) and separate each with a labelled banner.
//
// Usage:
//   node scripts/build-apps-script-bundle.mjs                 # build
//   node scripts/build-apps-script-bundle.mjs --push          # build + clasp push

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "apps-script", "threaded-sequencer");
const DEST_DIR = path.join(SRC_DIR, ".clasp-push");

// Code.gs in the parent folder is the single canonical source. The other
// .gs files (Config.gs, Setup.gs, QueueProcessor.gs, GmailService.gs) are
// legacy stubs from an aborted file-split refactor — Code.gs still contains
// every declaration they claim to own, so including them here would cause
// "Identifier already declared" errors on clasp push.
const FILE_ORDER = ["Code.gs"];

async function main() {
  const argv = process.argv.slice(2);
  const shouldPush = argv.includes("--push");

  const parts = [];
  for (const name of FILE_ORDER) {
    const p = path.join(SRC_DIR, name);
    let body;
    try {
      body = await fs.readFile(p, "utf8");
    } catch (err) {
      console.error(`[bundle] skipping missing ${name}: ${err.message}`);
      continue;
    }
    parts.push(`// ============================================================`);
    parts.push(`// ${name}`);
    parts.push(`// ============================================================\n`);
    parts.push(body.trimEnd());
    parts.push("\n");
  }

  const merged = parts.join("\n");
  const outPath = path.join(DEST_DIR, "Code.gs");
  await fs.writeFile(outPath, merged);
  console.error(`[bundle] Wrote ${outPath} (${merged.length} bytes from ${FILE_ORDER.length} source files).`);

  // Also mirror appsscript.json if the source has one.
  const appsscriptSrc = path.join(SRC_DIR, "appsscript.json");
  try {
    const aj = await fs.readFile(appsscriptSrc, "utf8");
    await fs.writeFile(path.join(DEST_DIR, "appsscript.json"), aj);
  } catch (err) {
    void err;
  }

  if (!shouldPush) {
    console.error(`[bundle] Run with --push to clasp-push, or manually: (cd ${DEST_DIR} && clasp push)`);
    return;
  }

  console.error(`[bundle] Running clasp push...`);
  await new Promise((resolve, reject) => {
    const child = spawn("clasp", ["push"], { cwd: DEST_DIR, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`clasp push exited ${code}`));
    });
    child.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
