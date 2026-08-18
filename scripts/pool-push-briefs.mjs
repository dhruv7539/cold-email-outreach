#!/usr/bin/env node
// Shared pool BRIEFS — share contact research so nobody pays for the same
// research twice. Contact briefs are the most expensive step of a campaign
// (a research subagent per contact); this pushes them into the pool's `Briefs`
// tab, keyed by the contact's email. pool-lookup then materializes them
// automatically on a hit.
//
// WHAT GETS SHARED: research about the CONTACT only. Sections that are about
// how YOU should pitch (proof selection, draft guidance) are stripped, along
// with any line naming you or referring to "the candidate". That keeps the
// brief useful to everyone, correct for people with different backgrounds, and
// anonymous — a shared brief never hints at who wrote it.
//
// Usage:
//   node scripts/pool-push-briefs.mjs                 # all campaigns (backfill)
//   node scripts/pool-push-briefs.mjs --slug <slug>    # one campaign
//   node scripts/pool-push-briefs.mjs --dir <path>     # explicit directory
//   node scripts/pool-push-briefs.mjs --all --force     # replace pooled briefs
//   node scripts/pool-push-briefs.mjs --dry-run
//
// Exit codes: 0 = ok, 2 = pool not configured, 1 = error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getSharedPoolId,
  getAccessToken,
  putBriefs,
  normDomain,
} from "./shared-pool.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const BRIEF_ROOT = path.join("output", "contact-briefs");

// Headings whose content is about the SENDER's pitch, not the contact.
const SENDER_SECTION =
  /(best proof|proof to lead|draft guidance|drafting|suggested (angle|proof|copy)|pitch|email (plan|angle|draft)|why (me|this candidate)|cta)/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// Names to scrub so a shared brief can't be traced to its author.
export function candidateNamePattern() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, "outreach.config.json"), "utf8"));
  } catch {
    return null;
  }
  const c = cfg?.candidate ?? {};
  const parts = [c.first_name, c.last_name, c.full_name, c.name]
    .filter(Boolean)
    .flatMap((v) => String(v).split(/\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  const uniq = [...new Set(parts)].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return uniq.length ? new RegExp(`\\b(${uniq.join("|")})\\b`, "i") : null;
}

export function extractMeta(md) {
  const email =
    md.match(/^-\s*\*\*email:\*\*\s*<?([^\s<>|)]+@[^\s<>|)]+)/im)?.[1] ??
    md.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/)?.[1] ??
    "";
  const name =
    md.match(/^#\s*Contact Brief:\s*(.+)$/m)?.[1]?.trim() ??
    md.match(/^-\s*\*\*name:\*\*\s*(.+)$/im)?.[1]?.trim() ??
    "";
  const titleRaw = md.match(/^-\s*\*\*title:\*\*\s*(.+)$/im)?.[1]?.trim() ?? "";
  const title = titleRaw.replace(/\s*\(Apollo headline:.*$/i, "").trim();
  const company = titleRaw.match(/@\s*([A-Za-z0-9.&' -]+)/)?.[1]?.trim() ?? "";
  const emailCount = new Set(
    (md.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []).map((e) =>
      e.toLowerCase()
    )
  ).size;
  return { email: email.toLowerCase(), name, title, company, emailCount };
}

// Drop sender-specific sections and any line that names the author or talks
// about "the candidate".
export function sanitize(md, namePattern) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      skipping = SENDER_SECTION.test(heading[2]);
      if (skipping) continue;
    }
    if (skipping) continue;
    if (/\bthe candidate'?s?\b/i.test(line)) continue;
    if (namePattern && namePattern.test(line)) continue;
    if (/^-\s*\*\*(proof_id|leadProof|proof_type)\b/i.test(line)) continue;
    out.push(line);
  }
  const body = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) return "";
  return `${body}\n\n_Shared brief: contact research only. Pitch/proof guidance removed — write your own._\n`;
}

function collectBriefFiles(args) {
  const files = [];
  const pushDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md")) files.push({ file: path.join(dir, f), nested: true });
    }
  };

  if (args.dir && args.dir !== "true") {
    pushDir(args.dir);
    return files;
  }
  if (args.slug && args.slug !== "true") {
    pushDir(path.join(BRIEF_ROOT, args.slug));
    return files;
  }
  if (!fs.existsSync(BRIEF_ROOT)) return files;
  for (const entry of fs.readdirSync(BRIEF_ROOT, { withFileTypes: true })) {
    const full = path.join(BRIEF_ROOT, entry.name);
    if (entry.isDirectory()) pushDir(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push({ file: full, nested: false });
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sid = getSharedPoolId();
  if (!sid) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }

  const files = collectBriefFiles(args);
  if (!files.length) {
    console.log("no contact briefs found — nothing to push.");
    return;
  }

  const namePattern = candidateNamePattern();
  const briefs = [];
  let noEmail = 0;
  let multiContact = 0;
  let empty = 0;

  for (const { file, nested } of files) {
    let md;
    try {
      md = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const meta = extractMeta(md);
    if (!meta.email) {
      noEmail += 1;
      continue;
    }
    // Only share real per-contact briefs. Old flat per-campaign files often
    // cover several contacts (and read as campaign notes, not contact
    // research), and can't be split reliably.
    const perContact = nested || /^#\s*Contact Brief:/m.test(md);
    if (!perContact || meta.emailCount > 1) {
      multiContact += 1;
      continue;
    }
    const clean = sanitize(md, namePattern);
    if (!clean) {
      empty += 1;
      continue;
    }
    briefs.push({
      email: meta.email,
      name: meta.name,
      title: meta.title,
      company: meta.company,
      domain: normDomain(meta.email.split("@")[1] || ""),
      brief_md: clean,
    });
  }

  console.log(
    `briefs found=${files.length} | shareable=${briefs.length} | skipped: no-email=${noEmail}, multi-contact=${multiContact}, empty-after-scrub=${empty}`
  );

  if (args["dry-run"]) {
    console.log("--dry-run: not writing. Sample:");
    for (const b of briefs.slice(0, 3)) console.log(`   ${b.name} <${b.email}> (${b.brief_md.length} chars)`);
    return;
  }
  if (!briefs.length) return;

  const accessToken = await getAccessToken(args);
  const res = await putBriefs(accessToken, sid, briefs, { force: Boolean(args.force) });
  console.log(
    `pushed ${res.pushed} new brief(s), replaced ${res.replaced}, skipped ${res.skipped} (already pooled).`
  );
}

// Only run when invoked directly, so the sanitizer can be imported and tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
