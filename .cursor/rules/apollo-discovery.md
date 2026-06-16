---
description: Apollo contact discovery — domain conflation, location filtering, bucket searches
globs:
  - "scripts/apollo-rest-*.mjs"
  - "runs/*.spec.mjs"
  - "output/discovery/**"
alwaysApply: false
---

# Apollo Discovery Rules

See also: `.cursor/rules/apollo-enrichment.md` for rate limits and enrichment
loop patterns.

## The domain-conflation gotcha (check this FIRST)

Apollo sometimes groups a subsidiary under the parent company's org record,
returning identical result counts for both domains. Symptom:

```bash
node scripts/apollo-rest-search-people.mjs --domains gmfinancial.com --per-page 5
# → 68,709 entries (GM + GM Financial + Cruise + ...)

node scripts/apollo-rest-search-people.mjs --domains gm.com --per-page 5
# → 68,709 entries (identical set)
```

If you see identical totals across two domains you expected to differ, or if
the returned `organization_name` does not match the company you're searching,
Apollo has conflated them.

### Workaround

Use `--keywords "Exact Company Name"` to filter by the subsidiary's actual
org record:

```bash
node scripts/apollo-rest-search-people.mjs \
  --keywords "GM Financial" \
  --locations "Fort Worth, Texas" \
  --titles "recruiter,talent acquisition,..." \
  --target 20 --max-pages 4 \
  --output output/discovery/SLUG-bucketA.json
```

After the search, **verify `organization_name === "Target Company"`** for
every returned person. If some still show the parent's name, they're not
actually at the subsidiary.

Known examples:
- `GM Financial` under `General Motors` (`@gm.com` vs `@gmfinancial.com`)
- `Verscend` under `Cotiviti` (pre-2018 merger, `@verscend.com` still valid)

## Location filter for US-Remote roles

Companies with heavy offshore (especially India) engineering orgs will
flood results even when you filter by US-friendly titles. Always add:

```bash
--locations "United States"
```

when the JD says US-Remote, US-only, or lists a US city. Seen at Cotiviti
(~5.3K total, only 10 US-based recruiters).

## Old-domain email acceptance

Acquired / renamed companies often have Apollo-verified emails on the
pre-acquisition domain. **Use as-given** — Apollo's SMTP verification is
reliable and the corporate MX will forward internally.

Examples:
- Anything team on `@create.xyz` / `@createanything.com` (pre–Aug 2025
  domain acquisition)
- Lou Popa (Director SWE, Cotiviti) on `@verscend.com`

Do NOT rewrite the email to the "current" domain. Keep the Apollo-verified
address.

## Step 0 — Extract the team / org-unit from the JD (do this FIRST)

Before searching, pull the **team, product, or org-unit name** the role sits
in straight from the JD. This is the single highest-leverage targeting signal:
an email that names the contact's actual team converts far better than a
generic "saw you're a SWE at X" note.

Examples of team signals to extract:
- "The **Build Team** focuses on..." / "**Developer Productivity** org" (MongoDB)
- "**Data Platform** team" / "data products" / "event streams" (Together AI)
- Named platforms / products: "Atlas," "GreyMatter," "Voice of Client"

Turn the extracted team into two things:
- a distinctive `--keywords "<team>"` phrase for **Bucket D** (only when the
  team name is specific enough to filter — e.g. "Developer Productivity," not
  "platform"), and
- a `--rank-keywords "<term1,term2,...>"` list (team + adjacent tech terms)
  to layer onto Buckets B and C so on-team contacts float to the top.

## Four-bucket discovery pattern

Every new JD gets recruiter and hiring-manager buckets, plus a same-team
bucket when the JD names a distinctive team. **Bucket C (peer SWE) is off by
default** — run only when screening for USC alumni or near-certain referral
signals (`--target 3` max). See `AGENTS.md` → "Sizing" for tier totals and
the peer exception bar.

```bash
# Bucket A — recruiters / TA
node scripts/apollo-rest-search-people.mjs \
  --domains company.com \
  --locations "United States" \
  --titles "recruiter,technical recruiter,talent acquisition,university recruiter,early career recruiter,campus recruiter,talent partner,sourcer,talent advisor" \
  --target 15 --max-pages 4 \
  --output output/discovery/SLUG-bucketA.json

# Bucket B — hiring managers / eng leaders (rank by team terms)
--titles "engineering manager,software engineering manager,director of engineering,senior engineering manager,vp engineering,head of engineering,architect,technical lead,tech lead,lead software engineer,principal engineer,software architect,solution architect"
--rank-keywords "developer productivity,build,bazel,release engineering"
--target 15

# Bucket C — peer SWEs (OPTIONAL; off by default)
# Only when screening USC alumni or near-certain referral peers — max 3.
--titles "software engineer,senior software engineer,full stack engineer,backend engineer,java developer,.net developer,react developer,data engineer,software developer"
--rank-keywords "developer productivity,build,bazel,release engineering"
--target 3

# Bucket D — same-team match (ONLY when the team name is distinctive)
node scripts/apollo-rest-search-people.mjs \
  --domains company.com \
  --keywords "Developer Productivity" \
  --locations "United States" \
  --titles "software engineer,senior software engineer,engineering manager,staff engineer,principal engineer" \
  --rank-keywords "developer productivity,build,bazel,release" \
  --target 8 --max-pages 4 \
  --output output/discovery/SLUG-bucketD.json
```

Always pull slightly more than the target final count so you can prune
low-quality picks post-discovery.

### `--rank-keywords` notes

- Client-side scoring counts how many ranking terms appear in each person's
  `title + headline` (case-insensitive), then stable-sorts the pool so the
  highest `match_score` wins the `--target` slots. The output adds
  `match_score` per person and `ranked_by` at the top level.
- When ranking is active the script paginates the **full** pool (up to
  `--max-pages`) before slicing — a few extra masked-search requests, **no
  extra enrich credits**.
- **The masked search endpoint usually returns only `title` (no `headline`),**
  so ranking effectively scores against the title. That's still useful when
  titles carry team info ("SWE, Developer Productivity"); when they don't,
  `match_score` will be 0 across the board and you fall back to manual
  selection + Bucket D's `--keywords` server filter. `headline` is surfaced
  when present (e.g. after future endpoint changes) and falls back to `null`.
- `--keywords` (server-side `q_keywords`, used for the conflation workaround)
  and `--rank-keywords` (client-side ranking) are independent and compose:
  `--keywords "GM Financial"` + `--rank-keywords "data platform,event streams"`.

## Post-discovery selection rules

After inspecting each bucket, prune with these priorities (in order):

1. **Same-team / same-org-unit match** — the contact's title or headline names
   the JD's team, product, or org-unit ("SWE, Developer Productivity";
   "Data Platform Engineer"; anyone surfaced by Bucket D or with a high
   `match_score`). This is the strongest targeting signal — rank these above
   everything else for HM/SWE buckets.
2. **Organization match** — drop anyone whose `organization_name` isn't the
   target (catches residual conflation).
3. **Seniority for hiring managers** — Directors > Principals > Lead SWEs >
   Technical Leads. An SDE I / Associate SWE opening is owned by senior eng
   leadership, not a fellow Senior Engineer. (Within the same seniority tier,
   prefer the same-team match from rule #1.)
4. **Stack match for SWEs** — prefer candidates whose current title literally
   names the JD stack (e.g. ".NET Full-Stack Developer" for a Next.js+.NET
   role, "Lead Java Developer" for a Java role).

## Hiring-influence selection (post-2026-06)

Within the tier total from `AGENTS.md`:

- **Recruiters + HMs: uncapped** — apply the recruiter ladder and HM
  seniority/same-team rules, then **keep all** verified contacts that pass
  org match. Do not stop at 2 recruiters or 4 HMs when more qualified
  hiring-path contacts remain.
- **Peer SWEs: hard cap 0–3** — keep only contacts passing the peer
  exception bar (verified USC alumni, or same-team + referral/hiring signal
  with campaign-note justification). Default **0** generic peers.
- **HR: default 0** unless zero eng TA exists (max 1 router).

## GitHub-signal personalization (pre-spec, HM/SWE only)

After enriching, run a batch GitHub lookup over the engineering contacts to
find a person-specific trigger that beats a title restatement:

```bash
node scripts/github-signals-batch.mjs --enrich output/enrich/SLUG.json
# → output/signals/SLUG.json  (set GITHUB_TOKEN for 5000 req/hr on full batches)
```

- It filters to engineering-ish titles by default (HM + SWE); recruiters are
  skipped because their public GitHub is rarely useful and each lookup costs
  API calls. Pass `--all` to include everyone.
- Each contact's entry is the signal object (`top_repo`, `recent_languages`,
  `last_commit_date`, `match_score`) or `null` when nothing scored above the
  confidence threshold (`--min-score`, default 3). **Prefer silence to a
  wrong-person hook** — only use it when there's a confident match.
- When a contact has a confident signal, make it the sentence-1 trigger:
  "I saw your work on `<top_repo>` (`<lang>`)…". Otherwise fall back to the
  title / headline / team trigger.

## Recruiter priority ladder

Recruiter targeting is necessarily approximate — Apollo can't map a recruiter
to a specific req ID. Approximate "owns this req" with this order:

1. **Team / org-aligned recruiter** — title or headline names the JD's
   org-unit ("Recruiter, Cloud & Developer Productivity", "TA Partner,
   Platform Eng"). Closest proxy for the req owner.
2. **Technical recruiter** — "Technical Recruiter", "Manager TA (Tech)",
   "Sr Tech Recruiter AI & SWE" outweigh generic "Recruiter".
3. **University / early-career recruiter** — "University Relations",
   "Early Careers", "Campus Recruiter" for any new-grad / SDE I / Associate
   SWE / internship-track role. Promote these to #1 when the role is
   explicitly early-career.
4. **Senior generic recruiter** — senior TA without a tech/team signal.
5. **Coordinator / specialist** — last resort; they handle scheduling, not
   pipeline ownership.

### Senior-over-junior TA tiebreak

Within the generic-recruiter band, prefer senior TA people over Coordinators
or Specialists when the final count is tight. Rough hierarchy:

Director TA > Manager TA > Principal / Strategic Partner TA > Senior TA
Advisor / Partner > Team Lead TA > TA II > TA / Recruiter > TA Coordinator
