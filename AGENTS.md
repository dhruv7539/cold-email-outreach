# AGENTS.md

Cursor auto-loads this file. Keep it tight — skim to run.

## What this project does

Runs tailored cold-email outreach for the candidate's job search. A JD goes in →
20–35 personalized emails go out over the next 24–48 hours, sent by the Apps Script
queue processor from a Google Sheet.

## Setup gate (run BEFORE any campaign work)

If `outreach.config.json` is missing OR `setup_complete` is false:

1. Read [`SETUP.md`](SETUP.md) end-to-end and execute every phase.
2. Do not start JD discovery, spec, export, or import until
   `node scripts/validate-setup.mjs` exits 0.
3. Then continue with the campaign workflow below.

## Canonical config (read every session)

- **Spreadsheet ID:** `google.primary_spreadsheet_id` in `outreach.config.json`
  (or `OUTREACH_SPREADSHEET_ID` env override). Load via `scripts/load-config.mjs`
  or `getOutreachSpreadsheetId()` from `scripts/config.mjs`.
- **Apps Script source:** `apps-script/threaded-sequencer/`
- **Candidate background:** `master_data.md` + `COLD_EMAIL_PROOF_BANK.md`
- **Signature:** use `first_name` from config — see Signature block below.

## Start here when picking up the project

1. Read `CAMPAIGN_LOG.md` — chronological ledger of campaigns already sent,
   including Queue row ranges. Tells you what's been touched.
2. Read `COLD_EMAIL_PLAYBOOK.md` — strategy rules (tone, CTAs, phrases to
   avoid, etc.). Still the authority on copy.
3. Read this file + the two rule files under `.cursor/rules/` — operational
   mechanics (discovery, spec format, exporter/import flags).

You almost never need to read every script in `scripts/` — only the five
listed in the workflow below.

## JD eligibility gate (hard stop — check before any discovery)

**Do not run discovery, spec, export, or import** when the JD requires any of:

- U.S. citizenship (or "US citizen only")
- Ability to obtain / hold a **security clearance** (Secret, Top Secret, TS/SCI, etc.)
- "Must be a U.S. person" / export-control citizenship gates

Tell the user **no** with a one-line reason when `candidate.us_citizen` is false in
`outreach.config.json`. Do not queue outreach and do not pad with
"clearance-eligible" framing if the candidate is not a U.S. citizen.

(Federal/govcon roles often embed this in qualifications — read before step 1.)

## End-to-end workflow for a new JD

```bash
# 0. Pick a run slug — convention: company-role-YYYY-MM-DD
SLUG="cotiviti-aswe-2026-04-20"
COMPANY="Cotiviti"
# Extract the JD's team/org-unit ("Build Team / Developer Productivity",
# "Data Platform", "Atlas") — drives Bucket D + --rank-keywords below.
TEAM_TERMS="developer productivity,build,bazel,release engineering"

# 1. Discovery — four bucket searches: recruiter / hiring manager / SWE, plus
#    a same-team bucket (Bucket D) when the JD names a distinctive team.
#    Default target sizes below are current practice (see "Sizing" section).
node scripts/apollo-rest-search-people.mjs \
  --domains company.com \
  --locations "United States" \
  --titles "recruiter,technical recruiter,talent acquisition,university recruiter,campus recruiter,talent partner,sourcer,talent advisor" \
  --target 15 --max-pages 4 \
  --output output/discovery/${SLUG}-bucketA.json
# Hiring-manager + SWE buckets: add --rank-keywords "$TEAM_TERMS" so on-team
# contacts float to the top of the kept slice. Bucket D: add --keywords "<team>"
# for a same-team server filter. Full four-bucket pattern + selection priority
# (same-team match is #1): .cursor/rules/apollo-discovery.md

# 2. Pick final IDs → enrich
IDS=$(node -e "...selection logic, see spec-and-export rule...")
node scripts/apollo-rest-enrich-person.mjs --ids "$IDS" \
  --output output/enrich/${SLUG}.json

# 2b. (optional, recommended for HM/SWE) GitHub-signal personalization.
#     Batch-fetches public GitHub signals for engineering contacts only.
#     Use a confident top_repo/recent_languages as the sentence-1 trigger.
#     Set GITHUB_TOKEN for the 5000 req/hr rate on full batches.
node scripts/github-signals-batch.mjs --enrich output/enrich/${SLUG}.json
#     → writes output/signals/${SLUG}.json

# 3. Write the spec file — runs/${SLUG}.spec.mjs
#    Format is enforced in .cursor/rules/spec-and-export.md
#    HARD COPY RULE: every email needs an explicit candidacy anchor or a
#    routing/fit/scheduling CTA — a curiosity question alone is a lint ERROR
#    (missing_explicit_ask; this is what generated "what are you asking?"
#    replies). Rotate 3-4 scaffolds + >=2 CTA shapes; tag subjectVariant
#    (role/team/plain) + copyStructure for analytics.
#    Author per-contact followUp1Html/followUp2Html (new angle + referral
#    ask) — REQUIRED: the exporter refuses unauthored follow-ups (the generic
#    fallback was removed).
#    Then lint: node scripts/review-cold-email-spec.mjs runs/${SLUG}.spec.mjs --strict

# 4. Export spec → CSV
#    Add --per-day 8 when queueing >10 contacts at one company (spreads the
#    campaign across 2-3 business days; see Sizing).
node scripts/export-spec-to-apps-script-queue.mjs runs/${SLUG}.spec.mjs \
  --out output/apps-script/${SLUG}.queue.csv \
  --company "${COMPANY}"

# 5. Import CSV → Google Sheet
node scripts/import-queue-csv-to-sheet.mjs \
  --csv output/apps-script/${SLUG}.queue.csv
# (--spreadsheet-id optional — defaults to outreach.config.json)

# 6. Verify — read the last ~30 Queue rows to confirm contiguous append.
#    import-queue-csv-to-sheet.mjs reports an updatedRange that is often
#    MISLEADING. Always verify by reading the actual sheet state.

# 7. Append one row to CAMPAIGN_LOG.md.
```

## Targeting (be as specific as the JD allows)

The highest-leverage lever is **same-team match**: an email that names the
contact's actual team/product converts far better than "saw you're a SWE at X."

1. Extract the team/org-unit from the JD first (step 0 above).
2. Run the four-bucket pattern: rank hiring-manager + SWE buckets with
   `--rank-keywords "<team terms>"`, and add Bucket D
   (`--keywords "<team>"`) when the team name is distinctive.
3. In selection, **same-team / same-org-unit match is priority #1** (ahead of
   seniority and stack), and recruiters follow the team-aligned → technical →
   university/early-career → senior generic → coordinator ladder.

Full rules + the `--rank-keywords` mechanics: `.cursor/rules/apollo-discovery.md`.

## Sizing (current practice — hiring-influence first)

Fill tier totals with **recruiters + hiring managers + eng leaders** who own
or route the req. **No cap** on that group within the tier ceiling. Peer
SWEs are **0–3 max** and only when they pass the peer exception bar (below).

| Company scale                 | Total contacts | Split guidance |
|-------------------------------|----------------|----------------|
| Mega-cap (Adobe, Apple)       | **15–30**      | All verified rec + HM on/adjacent team; peers **0–3** max |
| Large enterprise (GMF, ~10K)  | **15–20**      | Rec + HM; peers **0–3** max |
| Mid-large / mid-size          | **15–20**      | Rec + HM; peers **0–3** max |
| Small startup (<50 employees) | **6–10**       | Founders + eng leaders; peers **0–3** max |
| Tiny / pre-seed (<15)         | **4–7**        | Founders + eng leaders; peers **0–3** max |
| Staffing agency               | **2–5**        | Recruiters only |

**Peer SWE exception bar (hard cap 0–3 per campaign):** queue a
`software_engineer` only when they are **verified alumni** (see `apollo.alumni_school_id`
in config), or **same-team + referral/hiring headline + campaign note** documents
near-certain help. Default **0** generic peer SWEs. Default **0** generic
`hr` unless zero eng TA exists (max 1 HR router).

If the user specifies counts explicitly, honor those.

If Apollo returns fewer hiring-path contacts than the tier ceiling, **ship
what you have** — never pad with peer SWEs or low-influence roles.

Two overriding rules:

- **Never compromise hiring-influence coverage** for peer padding. Queue
  every high-conviction recruiter and HM Apollo returns within the tier total.
- **Spread one company over 2–3 business days** when queueing >10 contacts
  there: pass `--per-day 8` to the exporter. Same-day saturation of one
  domain is the most reportable pattern we generate.

**Discovery defaults:** Buckets A + B + D at full targets (`--target 15` /
`15` / `8`). **Skip Bucket C** (peer SWE) unless screening for alumni
(`apollo.alumni_school_id`) or near-certain referral signals (`--target 3` max).

## Scheduling + pacing (recipient-timezone, anti-spam spacing)

The system now paces sends to look human and lands them in each recipient's
**local** business hours. Two layers cooperate:

**1. Exporter (when building the CSV) — `main_send_at` is a "not-before" anchor.**
- Resolves each recipient's IANA timezone by auto-joining
  `output/enrich/<slug>.json` (email -> US state -> zone; AZ = Phoenix/no-DST;
  default `America/Los_Angeles` when state/enrich is missing) and writes it to
  the `recipient_timezone` column.
- Spreads each day's sends **evenly across the recipient's local 9-5 window**
  (gap = window / that day's volume) with ±35% jitter, interleaves by domain so
  same-company contacts are not consecutive, and spills past `--per-day` (default
  400) onto the next business day. Follow-ups inherit the recipient's zone/hour.
- Useful flags: `--per-day`, `--jitter-frac`, `--default-timezone`, `--enrich`,
  `--start-hour` / `--end-hour`.

**2. Apps Script runtime (`Code.gs`) — the real gate.** `processQueue` runs every
minute and enforces, in order:
- Broad envelope: skip the whole run only when it is after-hours in *every* US
  zone.
- Per-row business-hours check in that row's `recipient_timezone` (fallback to
  the global `timezone` setting). Out-of-window rows are skipped, not blocked.
- `min_seconds_between_sends` (default 90) — minimum spacing between any two
  sends (anti-burst; this is the binding throttle, ~30-40/hr).
- `max_send_per_hour` (default 45) — rolling 60-min cap.
- `max_send_per_day` (default 400) — daily governor, reset at midnight in the
  global `timezone`.
- `per_domain_min_minutes` (default 12) — gap between two sends to the same
  domain.
- `max_send_per_run` (default 2, hard cap 10) — kept low on purpose so catch-up
  never bursts. Pacing state lives in ScriptProperties (`SEND_PACING`).

Realistic throughput with defaults: ~300-400/day across a multi-timezone batch
(the union of local windows widens the absolute send envelope to ~10-12h). To
go faster, lower `min_seconds_between_sends` (60 aligns with the 1-min trigger
for ~60/hr) and/or raise `max_send_per_hour` — but keep spacing human.

- `main_send_at` is a "not-before" timestamp, not an exact time. You do **not**
  need to reschedule new campaigns around old ones; the processor serializes
  naturally under the throttles above.

> Migration note: `recipient_timezone` was appended to the Queue schema after
> `error`. On the live sheet, add the header in the next empty column (see
> `apps-script/threaded-sequencer/README.md`). Blank values fall back to the
> global timezone. After editing `Code.gs`, re-deploy the Apps Script project
> and add the new `Settings` rows (`min_seconds_between_sends`,
> `max_send_per_hour`, `max_send_per_day`, `per_domain_min_minutes`) — or re-run
> `setupOutreachSheet` on a fresh sheet.

## Deduplication

Always check the Queue + Blacklist before queueing:

```bash
node scripts/list-skip-emails.mjs --company "Cotiviti"
```

Output is emails that are already in Queue or Blacklist. Filter them out of
new discovery before enriching. The enrichment script also accepts
`--skip-emails` to drop matches automatically.

> Dedup spans BOTH sheets now. When checking before a new campaign, also
> consider the overflow sheet (below) so you don't queue the same person twice.

## Second mailbox (overflow sender — optional)

See [`SETUP_OVERFLOW.md`](SETUP_OVERFLOW.md) for full setup. Summary:

- Separate Google account + separate Google Sheet (not a shared queue).
- IDs live in `outreach.config.json` → `google.overflow_spreadsheet_id`.
- Move rows with `scripts/move-rows-to-overflow.mjs` (dry-run by default).

## Signature block (copy into every spec)

Load `first_name` from `outreach.config.json` (or ask the user during setup):

```js
const signature = `
<p>Thanks,<br>
${firstName}</p>
`;
```

Or use `getSignatureHtml(config)` from `scripts/load-config.mjs` in Node tooling.

## Common pitfalls (learned the hard way)

- **Apollo conflates related domains under a parent company.** Search
  `gmfinancial.com` and you get 68K GM+GMF+Cruise employees. Fix:
  `--keywords "Exact Company Name"` alongside (or instead of) domain.
  Example companies seen: GM Financial under GM, Verscend under Cotiviti.
  (Full guidance: `.cursor/rules/apollo-discovery.md`.)
- **Acquired companies have Apollo-verified emails on OLD domains.** Use
  them as-given — Apollo SMTP-verification works regardless of the current
  corporate branding. Examples: Anything team on `@create.xyz`, Lou Popa
  (Cotiviti) on `@verscend.com`.
- **US-Remote roles at multinational companies require a location filter**
  (`--locations "United States"`), otherwise India offshore dominates.
- **`contactType` is required on every draft.** Enum:
  `recruiter | hiring_manager | software_engineer | founder | hr`. Missing
  values break analytics downstream.
- **`import-queue-csv-to-sheet.mjs` reports a misleading `updatedRange`.**
  Always verify by reading the sheet directly after import.
- **The exporter's `--company` flag overrides** the filename-derived default.
  Pass it explicitly — otherwise you'll get slug-cased garbage in the
  `company` column (e.g. "gmf swe 2026 04 20").
- **Confused replies are recoverable.** `scripts/classify-replies.mjs` tags
  them `confused` (needs_action=yes); send the recovery template from
  COLD_EMAIL_PLAYBOOK.md "Reply Handling" within 24h — own the lack of
  clarity, state candidacy plainly, one yes/no ask.
- **Human voice in all email copy.** No em dashes (—) in spec HTML or manual
  replies; short sentences, contractions OK. `review-cold-email-spec.mjs`
  errors on `em_dash`. See playbook "Human voice" section.

## Checking Queue state directly (for verification)

```bash
node -e "
import('./scripts/sheets-api.mjs').then(async m => {
  import('./scripts/config.mjs').then(async c => {
    const { accessToken } = await m.getSheetsAccessToken();
    const sid = c.getOutreachSpreadsheetId();
    const r = await m.getSheetValues(accessToken, sid, 'Queue!A1:I30');
    (r.values||[]).forEach((row, i) => {
      console.log(\`r\${i+1}: [\${row[3]||''}] \${row[2]||''} (\${row[1]||''}) send=\${row[7]||''}\`);
    });
  });
});"
```

## Honest framing about stack gaps

Read `master_data.md` and `candidate.primary_stack_note` in config for the
candidate's primary stack. When a JD asks for a non-matching primary stack:

- Name the gap explicitly — "X would be my ramp"
- Lean on full-stack fundamentals + modern tooling habits as transferable
- For in-lane stacks, drop the apologetic framing and pitch direct fit

Don't overclaim. Recruiters notice, managers really notice.
