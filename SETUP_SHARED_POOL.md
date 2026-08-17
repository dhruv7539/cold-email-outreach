# Shared contact pool — setup

A shared Google Sheet that caches enriched contacts across everyone using this
system. When anyone runs outreach for a company and finds people, those
contacts land in the shared sheet. The next person who targets that company
gets them for free — no Apollo credits spent.

It is **additive**: six new files, no changes to the rest of the system. It is
**anonymous**: rows store only contact data plus a timestamp, never who added
them.

## One-time, by the pool owner

1. Create a new Google Sheet (any name, e.g. "Outreach Shared Pool"). Copy its
   ID from the URL: `https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`.
2. Share it (**Editor**) with each friend's Google account — the same Google
   account they use for the outreach OAuth (their `sender_email`).
3. Send everyone the sheet ID.

You do NOT need to create tabs or headers by hand — the setup command does that.

## One-time, by each person (after `git pull`)

Run one command:

```bash
node scripts/setup-shared-pool.mjs --id <SHARED_SHEET_ID>
```

It writes `google.shared_pool_spreadsheet_id` into your local (gitignored)
`outreach.config.json`, verifies your Google login can read and write the
sheet, and creates the `Contacts` tab + header if they don't exist yet.
Idempotent — safe to re-run.

Prefer to let Cursor do it? Paste this one line into a chat:

> Set up the shared contact pool: `<SHARED_SHEET_ID>`

## That's it — the rest is automatic

An always-apply Cursor rule (`.cursor/rules/shared-pool.mdc`) makes the agent:

- check the pool **before** spending Apollo credits, and
- push new contacts **after** enriching.

So you just paste a JD as usual. Manually, the two commands are:

```bash
# before discovery — HIT writes output/enrich/<slug>.json and you skip Apollo
node scripts/pool-lookup.mjs --domain company.com --company "Company" --slug <slug>

# after a fresh Apollo enrich — share what you found
node scripts/pool-push.mjs --enrich output/enrich/<slug>.json --domain company.com --company "Company"
```

## Policy and notes

- **Supplement, not all-or-nothing.** A pool hit gives you the cached contacts.
  If they don't cover the specific team a JD needs, still run the normal Apollo
  buckets for the gap and push the new finds back.
- **Stale emails are safe.** Cached addresses can age; the exporter re-verifies
  every recipient and drops bad ones at send-export time. `pool-lookup` also
  supports `--max-age-days N` to ignore very old rows.
- **Anonymous within the group, not private.** Every member can read all
  pooled contacts (that's the point) and no row says who added it. The Google
  Sheet's own revision history is a separate surface visible only to the sheet
  owner.
- **PII sharing is intentional.** Contact names/emails are shared among the
  friend group by design; only pool with people you trust.
- **Not configured?** If you skip setup, the commands print a skip notice and
  exit; campaigns just use Apollo normally.
