# Cold Email Playbook

This playbook is the default for future job-search cold emails.

## North Star

Optimize for `positive reply rate`, not open rate.

Rough benchmark expectations from current cold-email and recruiting outreach sources:

- Generic cold outreach: roughly `3-5%` reply rate
- Recruiting/job-related outreach: often `5-8%` when targeted well
- `0-1%` usually means the issue is targeting, deliverability, or message-market fit

## 2026-06 Sizing Update (authoritative)

Tier totals and contact mix are defined in `AGENTS.md` → "Sizing". Summary:

- Mega-cap: **15–30** (all relevant rec + HM; peers **0–3** max)
- Large / mid: **15–20**; small startup: **6–10**; tiny: **4–7**
- **Hiring-influence contacts are uncapped** within the tier total — never
  cut recruiters or HMs to make room for peer SWEs
- Peer `software_engineer` slots: **0–3 max**, only **USC alumni** or
  **near-certain referral** (same-team + hiring signal + campaign note)

The **strategy** (tone, CTA shape, proof rules, phrases to avoid, research
brief) below is still authoritative. Tier numbers in §Company Tiering are
overridden by `AGENTS.md` where they differ.

## What Changes Going Forward

### 0. Build a contact research brief before drafting

Do not jump straight from `JD + contact list` to email copy.

For every contact, first capture:

- `why this exact person`
- `team or function`
- `one concrete trigger`
- `one best proof line from my background`
- `one CTA that fits this contact type`
- `personalization confidence`

If an email cannot be supported by a real trigger, either:

- downgrade it to a simple recruiter-style fit check, or
- skip the contact and replace them

The goal is to make each of the 5 emails feel like it had a different reason to exist.

For every final batch summary shared with the user, include:

- contact `name`
- `job title`
- whether they are `USC alumni`, `warm non-alumni`, or `cold`

Do not make the user infer alumni status from lane names alone.

### 0.5. Use Apollo-only for work emails

Do not guess work emails.

Allowed for the `email` field:

- exact work email surfaced in Apollo

Not allowed:

- reconstructing from a published company pattern
- inferring from masked addresses
- guessing from first/last name conventions
- mixing public person research with non-Apollo email guessing

Public web research is still useful for:

- choosing the right people
- finding triggers
- writing better personalization
- finding LinkedIn-active contacts

But if Apollo does not give an exact work email, then:

- leave the `email` field blank
- do not queue that person into the email sequencer
- route them into the LinkedIn lane only if they have a real activity signal

### 0.75. Draft from `master_data.md`, not memory

Before writing copy, check:

- [master_data.md](master_data.md)
- [COLD_EMAIL_PROOF_BANK.md](COLD_EMAIL_PROOF_BANK.md)

Do not improvise the middle paragraph from a generic stack summary.

Instead:

- pick `1` role-matched proof from the proof bank
- prefer a `metric`
- if a metric is not the best fit, use a verifiable artifact like the Kubernetes PR or IEEE papers
- make the proof easy to remember and easy to verify

### 0.9. Research matrix before writing any copy

Before drafting, decide both:

1. `who this person is` (title/function)
2. `what situation this outreach is in` (already applied, pre-apply, warm/alumni, referral ask)

Do not draft until both are explicit in the brief.

#### Title-to-angle map (required)

- `recruiter / sourcer`: routing, eligibility, and process clarity
  - CTA shape: `Should I stay with this req or target a nearby team?`
- `hiring manager / engineering manager`: team-fit and ownership match
  - CTA shape: `Does this align with what your team is looking for right now?`
- `engineer / peer`: practical path and role reality
  - CTA shape: `If you were in my shoes, would you target this role directly?`
- `director / exec`: org direction and placement
  - CTA shape: `Is this the right team to watch, or another nearby group?`

#### Situation-to-copy map (required)

- `already_applied`:
  - include exact role name + req id in line 1-2
  - ask routing / fit confirmation, not a broad advice ask
- `pre_apply`:
  - ask fit first, then apply quickly if signal is positive
- `warm_or_alumni`:
  - lead with shared context
  - ask for short directional guidance (15-20 min optional), not immediate referral
- `referral_ready`:
  - only after fit context is established
  - include job link + 2-3 bullets + resume/LinkedIn to reduce forwarding friction

### 1. Email 1 must be short

Target:

- `50-90 words`
- `2-3 short paragraphs`
- readable on one phone screen

Do not send the long 180-250 word emails we used before.

### 2. Lead with a relevant trigger, not generic praise

Use one concrete reason for reaching out:

- they lead the exact team tied to the JD
- they recently joined the company
- they came from a company or stack that matches the JD
- they posted about hiring, product direction, or engineering work
- they are on the exact office/team for the role

Avoid empty openers like:

- “Your background stood out to me”
- “I was impressed by your experience”

unless followed immediately by something specific.

Prefer person-specific triggers over role-only triggers whenever possible.

Trigger quality, from best to weakest:

1. they recruit for the exact org or team
2. they manage or work on the exact team tied to the JD
3. they recently posted about hiring, product direction, or engineering work
4. they share a real path signal with me: school, office, career path, tech stack
5. they are broadly in the right org, but there is no strong person-specific signal

Use level 5 only when stronger evidence is unavailable.

### 3. Use one proof line only

Do not summarize the whole resume.

Use one role-relevant proof line, for example:

- backend scale: Django/PostgreSQL/AWS, throughput `+42%`, p95 latency `-35%`
- distributed systems: GFS-inspired file system, Raft, `47K+ ops/sec`, p99 `2.3 ms`
- OSS/platform: merged Kubernetes `v1.36` PR reviewed by `@liggitt`
- AI/LLM workflows: `50K+` multilingual records and `1.5M+` tokens into pgvector, failures `<2%`

One sharp proof beats four medium ones.

### 3.5. Prefer evidence over stack lists

Bad middle paragraph:

- `My background is strongest in backend APIs, SQL-backed systems, testing, and cloud-backed engineering.`

Better:

- `At USC Annenberg, I optimized a Django + PostgreSQL backend on AWS, improving API throughput 42% and reducing p95 latency 35% under peak load.`

Rules:

- lead with the accomplishment, not the tool list
- use `1-2` technologies only when they help explain the proof
- if the same middle paragraph could fit ten companies, rewrite it

### 3.6. Use proof types intentionally

Preferred order:

1. `metric`
2. `verifiable artifact`
3. `named project or customer context`

Examples of good proof anchors:

- `42% throughput improvement`
- `47K+ ops/sec`
- `merged Kubernetes v1.36 PR`
- `World Bank + Gates Foundation research engineering`
- `2 IEEE papers`

### 4. Ask a tiny question

Use one low-friction CTA that can be answered quickly.

#### 4.0. HARD RULE: state candidacy explicitly (the Sankhesh rule)

Every first-touch email must let the reader answer "what is this person
asking of me?" in one read. That requires at least ONE of:

1. **An explicit candidacy anchor** — say you are a candidate for a named
   opening: `before I apply`, `made you the right first ask for the
   [role] opening`, `req 30998`, `I'm applying to ...`
2. **A decision-shaped CTA** — routing / fit / scheduling asks carry the
   candidacy implicitly (see shapes below).

A curiosity question alone (`How much of week one is CMake hygiene versus
feature coding?`) with no candidacy anchor is the proven confusion-generator:
it produced "I'm not sure what you're asking here or how I can help" replies.
The linter (`review-cold-email-spec.mjs`) now fails specs on this
(`missing_explicit_ask`).

#### 4.1. CTA shapes (rotate at least 2 per campaign)

- **routing** — `Who owns engineering screens for this hire?` /
  `If there's a better person or team to target first, I'd appreciate the pointer.`
- **fit** — `Does this align with what your team is looking for right now?` /
  `Is this the right team to target, or should I look at a nearby group?` /
  `Would it make sense for me to route my application here?`
- **scheduling (soft)** — `Would a 15-minute chat on fit make sense?` —
  allowed, see 4.2.
- **curiosity** — `How much of your week is X versus Y?` — ONLY for peer
  engineers, ONLY paired with an explicit candidacy anchor in the same email,
  and never for managers/principals/directors.

Avoid:

- multiple questions
- hard scheduling asks in email 1 (see 4.2)
- asking for “any advice” with no specific direction
- asking for a referral immediately
- repeated hedge phrases like `directionally relevant`

#### 4.2. Calls: soft chat-ask allowed, hard scheduling banned

This resolves an old contradiction in this playbook. The rule is about
friction, not the word "call":

- **Allowed in email 1:** a soft, declinable fit-framed ask —
  `Would a 15-minute chat about the [role] opening make sense?`
- **Banned in email 1:** hard scheduling — calendar links, `Can we book 30
  minutes this week?`, proposing specific times, or anything that demands
  calendar work before they've decided you're worth a reply.

### 4.5. Use a stronger ask, not a softer ask

We are not asking people to decide whether we are plausible from scratch.

Bad:

- `Would my background be directionally relevant?`
- `Would my background be relevant?`

Better:

- `Does this align with what your team is looking for right now?`
- `Is this the right entry point, or should I look at a nearby group?`
- `Would it make sense for me to route my application to this team?`

The difference is small, but it signals that we have already assessed the fit.

### 4.6. Add a light pull line when useful

Optional, not mandatory:

- `Happy to share GitHub, the PR, or a short project summary if useful.`
- `Happy to send the repo or a tighter write-up if helpful.`

Use this when:

- the proof is especially strong
- the person is technical enough to care
- the email still stays short

### 5. Do not attach the resume in email 1 by default

First-touch emails should be plain, light, and easy to trust.

Default rule:

- `No attachment in first email`
- `No links in first email unless absolutely necessary`

Resume can be sent:

- after they reply
- or in a follow-up when relevant

### 6. Keep subject lines simple

Three variants, A/B/C tested via `subjectVariant` in the spec (analytics
rolls up reply rate per variant):

- **role-anchored** (`subjectVariant: "role"`): `Question about the New Grad
  role`, `Nue full stack new grad`
- **team-anchored** (`subjectVariant: "team"`): `Quick question about Core
  Technology`, `IXL Raleigh new grad question`
- **plain-language** (`subjectVariant: "plain"`): a natural sentence a human
  would type, e.g. `Quick question about your Software Engineer opening`,
  `Candidate question - AI Engineer role`. Use this on at least ~1/3 of a
  campaign; fragment-style subjects (`TA mgr - AI dev associate`) read as
  mail-merge and are being phased down.

Avoid:

- clever hooks
- long subjects
- hype-y wording
- title-fragment constructions (`HR Albany - Clifton Park SWE`) that only
  make sense to the sender

Evidence-informed subject rules:

- keep to about `3-7` words when possible
- be specific over clever
- include one concrete anchor: company, team, or req id
- do not use clickbait or vague phrases

### 7. Targeting matters more than copy

Per company, use the tier-based `core contact` count, but prioritize:

1. recruiter or university recruiter
2. hiring manager or engineering manager
3. second manager/director if the team is clearly relevant
4. peer engineer with close background
5. alum or close-path person when available

If a contact is not clearly relevant to the specific role, skip them even if the email is verified.

## Human voice (all outbound copy)

Write like you're emailing one person at work, not publishing a blog post.

- **No em dashes (—).** Use a comma, a period, or two short sentences instead.
  Em dashes are an AI tell in 50-word cold notes.
- Prefer **short sentences.** One idea per sentence when you can.
- **Contractions are fine** (`I'm`, `you're`, `that's`). Stiff formal copy reads templated.
- **Read it aloud.** If you wouldn't say it in a Slack DM to a recruiter, rewrite.
- Applies to **spec drafts, follow-ups, and manual replies** (referral thank-yous,
  confused-reply recovery, positive-reply responses).

The reviewer errors on `—` / `&mdash;` in `html`, `followUp1Html`, and `followUp2Html`.

## Phrases To Avoid

Avoid these unless there is a very strong reason:

- `directionally relevant`
- `my background is strongest in`
- `my closest match is`
- `the kind of work I want to keep doing`
- `your background stood out to me`

These phrases tend to sound hedged or templated.

Replace them with:

- a concrete proof line
- a role-specific statement
- a clearer ask

## Research Brief Standard

Before drafting, every contact should have a mini-brief with these fields:

- `name`
- `title`
- `email`
- `email_source`
- `email_status`
- `location`
- `contact_type`
- `source_links`
- `why_relevant`
- `trigger`
- `proof_id`
- `best_proof`
- `proof_type`
- `pull_line`
- `cta`
- `confidence`
- `notes`

### Confidence grading

Use this grading when deciding how aggressively to personalize:

- `A`: direct evidence from company site, LinkedIn post, team page, or a clearly role-relevant public source
- `B`: strong inference from title, org chart, location, and job scope
- `C`: weak inference only

Rules:

- every email should have at least `A` or `B` confidence
- do not use fluffy personalization for `C`
- if most contacts are `C`, improve the contact list before drafting
- if the email is not an exact Apollo work email, do not queue that contact for email

## Company Tiering And Contact Count

There is no clean public dataset that says "contact exactly N people by company size."

So our operating rule is:

- informed by hiring-source and referral data
- adjusted to practical org-structure reality
- ultimately tuned to our own workflow preferences

Default rule going forward (see `AGENTS.md` for full table):

- `Tier 1` (mega-cap): **15–30** hiring-influence contacts
- `Tier 2–3` (large / mid): **15–20**
- `Tier 4` (small startup): **6–10**; tiny / pre-seed: **4–7**
- `Tier 5` (staffing): **2–5** recruiters

Important:

- `core contacts` = recruiter, hiring manager, engineering manager, founder
  — **not** generic peer SWEs (those are **0–3 max** via peer exception bar)
- queue **all** verified recruiters and HMs who own or route the req within
  the tier ceiling — do not stop at 1–2 rec / 4 HM
- peer SWE exception checklist before queueing any `software_engineer`:
  - [ ] verified **USC alumni**, **or**
  - [ ] same-team match + referral/hiring headline + campaign note for
    near-certain help
  - [ ] count ≤ **3** peers for this company
- these research targets are not permission to guess emails; only Apollo
  exact emails can enter the email lane

### Tier 1: Large, high-volume, brand-name companies

Examples:

- Big Tech
- large public tech companies
- top unicorns
- companies where the role likely has very high inbound volume

Typical profile:

- many parallel teams
- many stakeholders
- recruiter queue is crowded
- more value in alumni, internal flags, and second-wave contacts

Contact plan:

- **15–30** contacts, hiring-influence first
- core mix: **all relevant recruiters + all relevant HMs/eng leaders** on or
  adjacent to the req team (university/technical TA for new-grad reqs)
- peer engineers: **0–3 max** — USC alumni or near-certain referral only
- optional product lead or PM only when tightly coupled to the role

### Tier 2: Mid-large growth companies

Examples:

- established SaaS companies
- strong Series C+ or post-product-market-fit companies
- companies with a clear org chart but less brand saturation than Tier 1

Contact plan:

- **15–20** contacts
- **all relevant rec + HM** within tier ceiling; peers **0–3** max (USC
  alumni or near-certain referral only)

### Tier 3: Mid-size companies

Examples:

- roughly `100-1000 employees`
- fewer hiring layers
- smaller engineering orgs

Contact plan:

- **15–20** contacts; rec + HM heavy; peers **0–3** max

### Tier 4: Small startups, boutique firms, or tightly networked teams

Examples:

- small startups
- founder-led teams
- boutique consultancies
- lean internal teams where everyone likely knows the role

Contact plan:

- **6–10** (small startup) or **4–7** (tiny / pre-seed)
- founders + eng leaders + any TA; peers **0–3** max
- stop below ceiling when Apollo pool is thin — never pad with generic peers

### Tier 5: Staffing firms / agencies / consulting vendors with generic postings

Examples:

- staffing-led firms
- consulting vendors posting multiple role families in one listing

Contact plan:

- **2–5** recruiters
- keep the list recruiter-heavy
- use alumni/warm support only if there is a very believable connection to the firm

## Optional Alumni / Warm Support

Use alumni or warm contacts only when the match is strong:

- same school is real
- same office or nearby office is real
- same team or function is plausible
- the person is close enough to the role that a flag or referral would make sense
- the shared context would make a reply more likely than a random cold message

Warm contacts can include:

- USC alumni
- same technical community: Kubernetes, OSS, AWS, ML infra, etc.
- same office
- recent grads or early-career engineers on the team
- mutual-connection-style weak ties
- active public posters with a believable reason to engage

USC alumni can still be checked first, but they are now a support lane, not the default batch shape.

Apollo note:

- when using Apollo's education filter programmatically, mirror the web UI payload
- use `person_education_school_ids`, not a guessed field like `education_schools`
- keep a note of the exact school id captured from Apollo UI breadcrumbs/network requests

### Apollo warm-filter stack

Use Apollo as the structured shortlist layer for warm contacts.

Primary filter stack:

1. `person_education_school_ids` + `person_locations` + `person_titles`
2. if no results, drop location and use `person_education_school_ids` + `person_titles`
3. if no results, drop education and use `person_locations` + `person_titles`
4. if no results, use `person_titles` only

Optional support filter:

- `organization_locations` + `person_titles`
- use this when person-location coverage looks sparse but the office footprint is still useful

### Apollo warm-filter title sets

Do not rely on ultra-specific early-career titles. Use broad title buckets that Apollo consistently returns.

Engineer title set:

- `Software Engineer`
- `Software Engineer II`
- `Senior Software Engineer`

Recruiter title set:

- `Recruiter`
- `Technical Recruiter`
- `University Recruiter`
- `Talent Acquisition Partner`

Manager title set:

- `Engineering Manager`
- `Software Engineering Manager`

Search these title sets separately. Do not mix every title into one query.

### Apollo warm filters we trust

Reliable enough for this workflow:

- `person_education_school_ids`
- `person_locations`
- `person_titles`
- `organization_locations`

Not reliable enough right now:

- `person_seniorities`
- exact early-career title strings like `New Grad Software Engineer`
- keyword-style technical matching as the main warm filter

### Alumni / warm support sequence

#### Step 1: before applying or same day

- ask a fit question, not for a referral
- example: `Would you target this team if you were in my shoes?`

#### Step 2: after applying

- mention you already applied
- ask whether they would be open to flagging the application or referring you if the fit looks real

Do not lead with:

- `Can you refer me?`

Lead with:

- fit
- team relevance
- path relevance

Then ask for:

- `flagging internally`
- `referral`

only after the context is established

### Alumni / warm support scheduling rule

- use this only when you explicitly decide to include warm support contacts
- support contacts get:
  - `main email`
  - `follow-up 1 after 3 business days`
- support contacts do **not** get a second follow-up by default
- if a support contact replies, all remaining follow-ups stop
- if a support contact bounces, all remaining follow-ups stop

## LinkedIn Active Lane

Only suggest LinkedIn outreach when there is a real signal that the person is active and likely to reply there.

Strong signals:

- they posted or reposted in the last `60-90 days`
- they posted about hiring, the team, or the company recently
- they actively comment on hiring or engineering posts
- they are a recruiter or sourcer who visibly uses LinkedIn for candidate outreach

Weak signals:

- they simply have a profile
- their profile exists but shows no recent activity
- they are senior but inactive

Rule:

- only include LinkedIn outreach when the signal is strong
- when included, provide:
  - `LinkedIn profile link`
  - `one note under 300 characters`
- do not generate LinkedIn notes for every contact by default
- reserve this for the people most likely to actually see and answer a LinkedIn note

## Exact Operating Plan

### Tier 1

1. find `7-10 core contacts`
2. make sure recruiter and hiring-manager coverage are included
3. add alumni / warm support only if it is unusually strong
4. identify which contacts look `LinkedIn-active`
5. apply
6. queue the core contact lane
7. queue optional warm support only if chosen explicitly
8. use LinkedIn notes only for the people with strong activity signals

### Tier 2

1. find `5 core contacts`
2. make sure recruiter and hiring-manager coverage are included where possible
3. add alumni / warm support only if it is stronger than a weak core contact
4. identify which contacts look `LinkedIn-active`
5. apply
6. queue the core contact lane
7. use LinkedIn only where the activity signal is real

### Tier 3

1. find `5 core contacts`
2. identify any truly active LinkedIn targets
3. apply
4. queue the core contact lane

### Tier 4

1. find up to `5 core contacts`, but stop early if the company is too small for that to stay relevant
2. apply or direct-reach depending on the posting
3. use LinkedIn only where the person is clearly active

### Tier 5

1. identify up to `5 core contacts`
2. bias the list toward recruiter / TA coverage
3. treat outreach as application support and routing help
4. use LinkedIn only for active recruiter-type profiles

## Channel Mix Rule

For strong opportunities, especially Tier 1 and Tier 2:

- core contact email lane
- direct application
- optional alumni / warm support lane

These should work together, not compete.

## Email Sourcing Rule

The contact brief can use mixed sources for `person selection`, but the actual `email lane` is stricter:

- `Apollo exact email`: allowed for email outreach
- `Publicly shown exact work email`: hold unless Apollo also confirms it
- `Published email pattern`: not allowed
- `Masked email + pattern inference`: not allowed

Operational rule:

- email outreach queue = `Apollo exact email only`
- LinkedIn lane = allowed when the person has a real public activity signal
- alumni / warm support lane = email only when Apollo gives an exact email; otherwise LinkedIn-only

## Volume Guardrails

Do not contact everyone at once just because a company is large.

Rules:

- `Tier 1`: research `7-10 core contacts`, but stage sends instead of blasting the full set instantly
- `Tier 2`: research `5 core contacts`
- `Tier 3`: research `5 core contacts`
- `Tier 4`: research `up to 5 core contacts`, but stop below that if quality drops
- `Tier 5`: research `up to 5 core contacts`

### High-conviction over padding

The AGENTS.md sizing table gives target counts, but those are CEILINGS, not
quotas. When the Apollo pool is thin or marginal:

- **6-10 strong contacts beat 15-20 padded ones.** A "strong" contact is
  same-team, role-adjacent, or on the recruiting ladder for this req. If you
  are queueing someone because the count looks low, stop — that contact
  drags domain reputation and produces confused/annoyed replies.
- **Spread one company across 2-3 business days** when queueing more than
  ~10 contacts there: pass `--per-day 8` to the exporter. Fifteen near-
  identical emails landing at one company in one day is the most reportable
  pattern we generate.

### Pacing + deliverability (anti-spam spacing)

Hitting the daily mailbox ceiling is not the goal — **even spacing into the
recipient's primary inbox is.** Sends are paced so they read as human, not as a
scheduled blast. The mechanics live in `Code.gs` + the exporter (see AGENTS.md
"Scheduling + pacing" for the operational detail); the principles:

- **Spread, don't burst.** A minimum gap between any two sends
  (`min_seconds_between_sends`, default 90s) is the binding throttle. Uniform
  bursts are the single biggest spam signal we control.
- **Send in the recipient's local business hours.** Each row carries a
  `recipient_timezone` (resolved from their state); the runtime only sends a row
  inside that recipient's local 9-5. Across a multi-timezone batch this widens
  the absolute window to ~10-12h *and* lands every email mid-workday for the
  reader.
- **Per-domain spacing** (default 12 min) keeps multiple contacts at the same
  company from arriving back-to-back.
- **Daily governor** (`max_send_per_day`, default 400) and an hourly cap
  (`max_send_per_hour`, default 45) are ceilings/safety, not targets. Realistic
  throughput with the defaults is ~300-400/day.
- **Reputation hygiene still dominates.** No purchased lists, drop unverified
  emails, honor the Blacklist, keep bounce/complaint rates low. Pacing buys
  nothing if the underlying list or content is junk.
- **Ramp, don't jump.** If raising daily volume, step it up gradually
  (e.g. +20-25%/week) rather than doubling overnight; sudden spikes look like
  spam runs to the receiving side.

> `usc.edu` caveat: this is a Google Workspace EDU mailbox (~2,000 sends/day
> technical ceiling via the Gmail Advanced Service), but the *reputational* and
> institutional-policy limits are far lower. Treat the conservative defaults as
> the real ceiling and prioritize landing in Primary over raw volume — a
> suspended `usc.edu` account ends the campaign entirely.

## Contact-Type Angles

Use different angles across the batch instead of rewriting the same note over and over.

### Recruiter

- focus on fit, eligibility, role alignment, or nearby team placement
- CTA: `Would it make sense for me to route my application to this role or a nearby team?`

### Hiring manager / engineering manager

- focus on team fit, systems fit, or product ownership
- CTA: `Does this align with what your team is looking for right now?`

### Engineer

- focus on peer relevance, technical overlap, or path into the team
- CTA: `If you were in my shoes, would you target this role directly?`

### Director / exec

- focus on org direction, product area, or whether the role sits near their org
- CTA: `Is this the right team to look at, or should I be watching another nearby group?`

## Personalization Rules

For each batch:

1. At least `3` emails should use a person-specific trigger, not just a JD trigger.
2. At least `3` emails should use a different proof line from the others.
3. At least `2` emails should use different CTA shapes.
4. No more than `2` emails should open with nearly the same sentence structure.
5. At least `4` queued emails should contain a concrete metric or verifiable artifact.

### Structure rotation (break the fingerprint)

Same-company recipients compare notes; structurally identical emails get
collectively dismissed (or reported) even when each one passes review alone.
Per campaign:

- **Rotate 3-4 scaffolds**, not one. Examples: trigger→proof→ask;
  candidacy→question→proof; proof→trigger→ask; two-sentence minimal. Tag each
  draft with `copyStructure: "<name>"` in the spec so analytics can compare.
- **Cap any single proof token** (e.g. `42%`, `250+ CI tests`) to ~half the
  campaign's drafts. The linter warns at >50% reuse (`proof_token_overused`).
- **Max 2 `<strong>` spans per email** — one bolded metric is plenty. Heavy
  bolding is a visual spam cue (`excessive_bolding` lint).
- **No mail-merge trigger constructions.** `Your [title] seat aligned with
  [X] in the [Y] JD` is grammatically off and reads templated
  (`templated_title_trigger` lint). Write the opener as a natural sentence
  about something the person actually did, owns, or shipped.

## Default Email Shapes

### Recruiter

Subject:

`Question about the [Company] new grad role`

Body:

Hi [Name],

I’m finishing my MS in CS at USC in May 2026 and am very interested in the [role]. The part that stood out to me is [specific role/team angle].

My most relevant experience is [one proof line]. Would it make sense for me to route my application to this role or a nearby team?


Thanks,
Dhruv

### Manager

Subject:

`Quick question about [team/role]`

Body:

Hi [Name],

I’m reaching out because [specific trigger tied to their team].

I’m finishing my MS in CS at USC in May 2026. My most relevant work is [one proof line]. Does this align with what your team is looking for right now?

Thanks,
Dhruv

### Engineer / Alum

Subject:

`Your path into [Company] caught my attention`

Body:

Hi [Name],

I’m reaching out because [specific shared context or path trigger].

I’m finishing my MS in CS at USC in May 2026 and exploring the [role]. My most relevant work is [one proof line]. If you were in my shoes, would you aim for this team directly or another group first?

Thanks,
Dhruv

## Follow-Up Cadence

If we add follow-ups later, use:

1. Email 1: short trigger + proof + micro-ask
2. Follow-up 1 after `2-5 business days`: short bump with a new angle from the research brief
3. Follow-up 2 after `4-7 business days` after follow-up 1: one final note, then stop

Do not resend the same email.

Follow-up rules:

- **authored follow-ups are mandatory.** The exporter no longer ships a
  generic fallback — every enabled follow-up must have `followUp1Html` /
  `followUp2Html` written in the spec, or the step explicitly disabled.
  The linter errors on unauthored follow-ups (`followupN_not_authored`).
- each follow-up must add new value (new proof angle, clearer role mapping, or specific next-step ask)
- never send a "just checking in" style follow-up (`followupN_generic_bump`
  is a lint error)
- follow-up 1: NEW proof angle + restate the candidacy anchor
- follow-up 2: referral/routing ask + restate the candidacy anchor

## Reply Handling

Classifications come from `scripts/classify-replies.mjs` (categories:
`positive`, `referral`, `confused`, `not_interested`, `auto_reply`,
`unclear`). Action targets:

- `positive` — respond same day with availability + resume.
- `referral` — thank them, contact the referred person within 24h, name the
  referrer in sentence 1.
- `confused` — RECOVERABLE. They engaged but could not decode the ask.
  Send the recovery template below within 24h.
- `not_interested` — one-line thank-you, mark actioned, add to no-recontact
  notes. Never argue.
- `unclear` — read manually, reclassify.

### Confused-reply recovery template

Keep it three sentences: own the lack of clarity, state candidacy plainly,
one yes/no ask. No new proof lines, no links.

> Hi [Name], sorry — that's on me for not being clear. I'm a candidate for
> the [role title] opening ([req # if known]) and reached out because
> [one-clause reason this person]. Could you point me to whoever owns
> hiring for that role, or let me know if it's worth applying directly?

Worked example (Sankhesh Jhaveri, Kitware — the reply that created this
category):

> Hi Sankhesh, sorry — that's on me for not being clear. I'm a new-grad
> candidate for Kitware's Software Engineer opening in Clifton Park
> (M.S. CS, USC, May 2026) and reached out because the role lists the
> CMake-based workflow you work in. Could you point me to whoever owns
> hiring for that role, or let me know if applying through the portal is
> the right move?

## Things To Avoid

- resume dump in paragraph 2
- generic admiration
- “I attached my resume in case it is helpful” in every first touch
- long mission paragraphs
- more than one CTA
- over-personalized LinkedIn fluff
- hard scheduling asks (calendar links, proposed times) before earning a
  reply — a soft `would a 15-min chat make sense?` is fine (see 4.2)

## Practical Rule

Before sending or drafting a first-touch email, check:

1. Does this contact have an `A` or `B` confidence brief?
2. Is the opener tied to a real trigger?
3. Is the body under 90 words?
4. Is there one concrete proof line with a metric or verifiable artifact?
5. Is there only one easy-to-answer ask?
6. Can the reader tell, in one read, that you are a candidate for a named opening and what you want from THEM? (Section 4.0 — the Sankhesh rule)
7. Does email 1 avoid attachments and links?
8. Is the queued email address an exact Apollo email, not a guessed pattern?
9. Does the copy avoid hedge phrases like `directionally relevant` and `my background is strongest in`?
10. Is it free of em dashes (—) and does it sound like a human wrote it in one pass?

If not, rewrite.

## Operational Default

For cold-outreach batches, the default workflow is:

1. build a contact research brief for the selected core contacts
2. choose proof lines from `master_data.md` and `COLD_EMAIL_PROOF_BANK.md`
3. draft emails from the brief, not directly from the JD
4. make sure recruiter and hiring-manager coverage are included when possible
5. run the cold-email review script on the spec before queueing
6. queue the batch directly in the Google Sheets hosted sequencer
7. use threaded follow-ups unless explicitly told not to
8. use Apollo exact emails only for the queued email lane

Default queue behavior:

- main email goes out in the next valid business-hour slots
- core contact lane: follow-up 1 after `4 business days`
- core contact lane: follow-up 2 after `8 business days`
- optional alumni / warm support lane: follow-up 1 after `3 business days`
- queue in the `Cold Outreach Sequencer` sheet unless a different sheet is specified
