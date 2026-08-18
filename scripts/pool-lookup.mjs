#!/usr/bin/env node
// Shared pool LOOKUP — check the shared contact pool for a company BEFORE
// spending Apollo credits. On a hit, writes output/enrich/<slug>.json in the
// SAME shape apollo-rest-enrich-person.mjs produces, so the rest of the
// pipeline consumes it unchanged (select 4-6 -> briefs -> spec).
//
// Policy is SUPPLEMENT: a hit gives you the pooled contacts; if they don't
// cover the team you need, still run the normal Apollo buckets and pool-push
// the new finds afterward.
//
// Usage:
//   node scripts/pool-lookup.mjs --domain company.com [--company "Name"] \
//     [--slug my-slug] [--output output/enrich/my-slug.json] [--max-age-days 120]
//
// Exit codes: 0 = hit (file written), 3 = miss, 2 = pool not configured, 1 = error.

import fs from "node:fs/promises";
import path from "node:path";
import {
  getSharedPoolId,
  getAccessToken,
  getCompanyContacts,
  getBriefsForEmails,
} from "./shared-pool.mjs";

const DEFAULT_COOLDOWN_DAYS = 14;

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

function ageDays(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

// Send dates are stored bucketed to the Monday of their week, so a send could
// have happened up to 6 days AFTER the stored date. Measure from the end of the
// week to stay conservative — better to over-warn than to double-tap a contact.
function daysSinceWeek(week) {
  const t = Date.parse(`${week}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const endOfWeek = t + 6 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((Date.now() - endOfWeek) / (24 * 60 * 60 * 1000)));
}

function outreachInfo(rec) {
  const weeks = rec.sent_weeks ?? [];
  if (!weeks.length) return null;
  const latest = weeks.slice().sort().at(-1);
  return { daysAgo: daysSinceWeek(latest), waves: weeks.length };
}

function slugifyKey(name, email) {
  const base = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (base) return base;
  return String(email || "contact").split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spreadsheetId = getSharedPoolId();
  if (!spreadsheetId) {
    console.log("shared pool not configured (set google.shared_pool_spreadsheet_id) — skipping");
    process.exit(2);
  }

  const domain = args.domain;
  const company = args.company;
  if (!domain && !company) {
    console.error("required: --domain company.com (and/or --company \"Name\")");
    process.exit(1);
  }

  const accessToken = await getAccessToken(args);
  const allRecords = await getCompanyContacts(accessToken, spreadsheetId, {
    domain,
    company,
    maxAgeDays: args["max-age-days"],
  });

  if (!allRecords.length) {
    console.log(`pool MISS: ${domain || company} not in shared pool -> run Apollo discovery/enrich`);
    process.exit(3);
  }

  // Never draft to an address a friend already saw bounce / opt out.
  const suppressed = allRecords.filter((r) => r.do_not_send);
  let records = allRecords.filter((r) => !r.do_not_send);
  if (suppressed.length) {
    console.log(`suppressed ${suppressed.length} do-not-send contact(s) (bounced/opted-out) for ${domain || company}.`);
  }

  // Collision avoidance: someone in the pool may have emailed these contacts
  // very recently. Two people hitting the same recruiter in the same fortnight
  // reads as a spam wave and costs the whole group its reply rate.
  const cooldownDays = Number(args["cooldown-days"]) > 0 ? Number(args["cooldown-days"]) : DEFAULT_COOLDOWN_DAYS;
  const recent = records.filter((r) => {
    const info = outreachInfo(r);
    return info && info.daysAgo !== null && info.daysAgo <= cooldownDays;
  });
  if (recent.length && args["exclude-recent"]) {
    const recentSet = new Set(recent.map((r) => r.person.email));
    records = records.filter((r) => !recentSet.has(r.person.email));
    console.log(`excluded ${recent.length} contact(s) emailed within the last ${cooldownDays}d (--exclude-recent).`);
  }

  if (!records.length) {
    console.log(
      `pool has ${allRecords.length} contact(s) for ${domain || company} but all are do-not-send -> run Apollo discovery/enrich`
    );
    process.exit(3);
  }

  const slug = args.slug || (domain ? domain.replace(/\./g, "-") : String(company).toLowerCase().replace(/\s+/g, "-"));
  const outPath = args.output || path.join("output", "enrich", `${slug}.json`);

  const results = records.map((r) => {
    const info = outreachInfo(r);
    // Surface the anonymous reply gist so the drafter can prioritize contacts a
    // friend already had a positive exchange with (pool_reply_status only —
    // never the reply text), plus how recently the group last touched them.
    const person = { ...r.person };
    if (r.reply_status) person.pool_reply_status = r.reply_status;
    if (info) {
      person.pool_last_outreach_days_ago = info.daysAgo;
      person.pool_outreach_waves = info.waves;
    }
    return { id: r.person.id, ok: true, cached: true, person };
  });
  const out = {
    requested: results.length,
    kept: results.length,
    cache_hits: results.length,
    http_calls: 0,
    dropped_unverified: 0,
    skipped_due_to_queue: 0,
    source: "shared_pool",
    results,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2));

  console.log(`pool HIT: ${records.length} contact(s) for ${domain || company} -> wrote ${outPath} (skip Apollo)`);
  for (const r of records) {
    const p = r.person;
    const age = ageDays(r.added_at);
    const loc = [p.city, p.state, p.country].filter(Boolean).join(", ");
    const reply = r.reply_status ? `  [reply seen: ${r.reply_status}]` : "";
    const info = outreachInfo(r);
    const touch =
      info && info.daysAgo !== null && info.daysAgo <= cooldownDays
        ? `  [RECENT OUTREACH: ~${info.daysAgo}d ago, ${info.waves} wave(s)]`
        : info
          ? `  [last touched ~${info.daysAgo}d ago]`
          : "";
    console.log(
      `  ${p.name || "?"} | ${p.title || "?"} | ${p.email || "?"} (${p.email_status || "?"}) | ${loc}${age !== null ? ` | ${age}d old` : ""}${reply}${touch}`
    );
  }

  if (recent.length && !args["exclude-recent"]) {
    console.log(
      `\nCOLLISION WARNING: ${recent.length} of these were emailed by someone in the pool within ${cooldownDays}d.` +
        "\n  Prefer a different contact at this company, or wait out the cooldown. Re-run with --exclude-recent to drop them automatically."
    );
  }

  // Materialize any shared briefs so the agent skips the research subagent.
  if (!args["no-briefs"]) {
    const emails = records.map((r) => r.person.email).filter(Boolean);
    const briefs = await getBriefsForEmails(accessToken, spreadsheetId, emails);
    if (briefs.size) {
      const briefDir = path.join("output", "contact-briefs", slug);
      await fs.mkdir(briefDir, { recursive: true });
      for (const r of records) {
        const b = briefs.get(String(r.person.email || "").toLowerCase());
        if (!b) continue;
        const file = path.join(briefDir, `${slugifyKey(r.person.name, r.person.email)}.md`);
        await fs.writeFile(file, b.brief_md.endsWith("\n") ? b.brief_md : `${b.brief_md}\n`);
      }
      console.log(
        `\nreused ${briefs.size} shared contact brief(s) -> ${path.join("output", "contact-briefs", slug)}/` +
          "\n  Do NOT re-run brief subagents for those contacts."
      );
    }
  }

  console.log(
    "\nSUPPLEMENT: if these don't cover the team you need, run the normal Apollo buckets and pool-push the new finds."
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
