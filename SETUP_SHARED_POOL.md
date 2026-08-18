# Shared contact pool — setup

A shared Google Sheet that caches enriched contacts across everyone using this
system. When anyone runs outreach for a company and finds people, those
contacts land in the shared sheet. The next person who targets that company
gets them for free — no Apollo credits spent.

It also shares **outcomes**: if any friend gets a reply, the pool records the
gist (a category — positive / referral / negative / auto_reply / unclear —
never the reply text), and if an email bounces or opts out it's flagged
`do_not_send` so nobody wastes a send on it.

Two more things ride along:

- **Collision avoidance.** The pool remembers the *week* each contact was
  emailed by someone in the group. If you look up a company and a contact was
  hit in the last 14 days, you get a warning — because two people emailing the
  same recruiter in the same fortnight reads as a spam wave and drags down
  everyone's reply rate.
- **Shared contact briefs.** The research subagent step is the slowest, most
  expensive part of a campaign. Briefs are pooled and reused, so the second
  person to target a company gets the research for free. Only *contact
  research* is shared — the parts about which proof to lead with and how to
  draft are stripped, since those are personal to whoever wrote them.

It is **additive**: new files only, no changes to the rest of the system. It is
**anonymous**: rows store contact data, a timestamp, and outcome categories —
never who added a contact or who observed an outcome.

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
sheet, creates the `Contacts` / `Briefs` tabs if they don't exist yet, and then
**backfills your whole history**: every contact you've enriched
(`output/enrich/*.json`), your reply/bounce/send outcomes, and your contact
briefs. Idempotent — safe to re-run. Pass `--no-backfill` to skip the history
seed.

Prefer to let Cursor do it? Paste this one line into a chat:

> Set up the shared contact pool: `<SHARED_SHEET_ID>`

## That's it — the rest is automatic

An always-apply Cursor rule (`.cursor/rules/shared-pool.mdc`) makes the agent:

- check the pool **before** spending Apollo credits (skipping contacts other
  friends saw bounce / opt out, and warning about anyone emailed recently),
- reuse pooled contact briefs instead of re-running research subagents,
- push new contacts **after** enriching, and
- contribute reply + bounce outcomes after replies are classified.

So you just paste a JD as usual. Manually, the commands are:

```bash
# before discovery — HIT writes output/enrich/<slug>.json, materializes any
# shared briefs, and warns about recently-contacted people
node scripts/pool-lookup.mjs --domain company.com --company "Company" --slug <slug>

# after a fresh Apollo enrich — share what you found
node scripts/pool-push.mjs --enrich output/enrich/<slug>.json --domain company.com --company "Company"

# after replies get classified — share the outcome gist + bounces + send weeks
node scripts/pool-sync-outcomes.mjs

# after writing briefs — share the contact research (auto-sanitized)
node scripts/pool-push-briefs.mjs --slug <slug>
```

## Policy and notes

- **Supplement, not all-or-nothing.** A pool hit gives you the cached contacts.
  If they don't cover the specific team a JD needs, still run the normal Apollo
  buckets for the gap and push the new finds back.
- **Stale emails are safe.** Cached addresses can age; the exporter re-verifies
  every recipient and drops bad ones at send-export time. `pool-lookup` also
  supports `--max-age-days N` to ignore very old rows.
- **Anonymous within the group, not private.** Every member can read all
  pooled contacts, outcomes and briefs (that's the point) and no row says who
  added a contact or who received a reply/bounce. Only a reply *category* is
  shared, never the message text. Send dates are bucketed to the week so a
  batch of rows can't be fingerprinted back to one person's campaign, and
  briefs are stripped of pitch guidance and author names. The Google Sheet's
  own revision history is a separate surface visible only to the sheet owner.
- **Cooldown is advice, not a lock.** `pool-lookup` warns about contacts hit in
  the last 14 days (`--cooldown-days N` to change, `--exclude-recent` to drop
  them). It never silently blocks you from contacting someone.
- **PII sharing is intentional.** Contact names/emails are shared among the
  friend group by design; only pool with people you trust.
- **Not configured?** If you skip setup, the commands print a skip notice and
  exit; campaigns just use Apollo normally.
