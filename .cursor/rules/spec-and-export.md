---
description: Spec file format, exporter flags, and import verification for the outreach queue
globs:
  - "runs/*.spec.mjs"
  - "scripts/export-spec-to-apps-script-queue.mjs"
  - "scripts/import-queue-csv-to-sheet.mjs"
alwaysApply: false
---

# Spec File Format + Export/Import

## JD eligibility gate (before any work)

**Stop immediately** — tell the user **no**, do not discover/enrich/spec/export/import —
if the JD requires **U.S. citizenship** and/or **security clearance** (or
equivalent export-control / clearance-eligible language) and the candidate is
not a U.S. citizen. Do not proceed hoping to "mention clearance willingness."

## File naming

`runs/<company>-<role>-<YYYY-MM-DD>.spec.mjs`

Examples:
- `runs/cotiviti-aswe-2026-04-20.spec.mjs`
- `runs/gmf-swe-2026-04-20.spec.mjs`

## Canonical spec structure

Always split drafts into named arrays by contact type, then concat them with
`.map()` to attach the `contactType` field. This ensures every draft has a
correct `contactType` without manual duplication.

```js
// Use candidate.first_name from outreach.config.json
const signature = `
<p>Thanks,<br>
YOUR_FIRST_NAME</p>
`;

// <Company> (<domain>) — <Role> — <YYYY-MM-DD>
//
// Context: ... why this spec exists, any discovery quirks, any domain
// migration notes, the deviation from default sizing if any.
//
// Candidate positioning: ... which parts of the JD are in-lane, which are
// a ramp. This is the framing that shapes every email.

const recruiters = [
  {
    key: "firstname-lastname",
    to: "firstname.lastname@company.com",
    subject: "...",
    html: `
<p>Hi Firstname,</p>
<p>... 50–90 word body ...</p>
${signature}
`,
    // Authored follow-ups (threaded, no subject). Each adds a NEW angle —
    // never a "just checking in" bump. REQUIRED: the exporter refuses to
    // export enabled-but-unauthored follow-ups (no generic fallback exists).
    followUp1Html: `
<p>Hi Firstname,</p>
<p>... new proof angle / role mapping, ~50-70 words ...</p>
${signature}
`,
    followUp2Html: `
<p>Hi Firstname,</p>
<p>... short final note with a referral ask ...</p>
${signature}
`,
  },
  // ... more
];

const hiringManagers = [ /* ... */ ];
const softwareEngineers = [ /* ... */ ];

export default {
  drafts: [
    ...recruiters.map((d) => ({ ...d, contactType: "recruiter" })),
    ...hiringManagers.map((d) => ({ ...d, contactType: "hiring_manager" })),
    ...softwareEngineers.map((d) => ({ ...d, contactType: "software_engineer" })),
  ],
};
```

## Required draft fields

| Field         | Notes                                                                 |
|---------------|-----------------------------------------------------------------------|
| `key`         | Unique within spec. `firstname-lastname` (lowercase, hyphenated).     |
| `to`          | Apollo-verified email only. Keep old domains when Apollo verified them. |
| `subject`     | 3–7 words. No emojis / clickbait. Include one concrete anchor.        |
| `html`        | Body wrapped in `<p>` tags. Must end with `${signature}`.             |
| `contactType` | Added via `.map()`. Enum below.                                       |
| `followUp1Html` | **Required** (unless step disabled). New-angle follow-up (threaded, no subject). Reviewer errors and exporter refuses if missing. |
| `followUp2Html` | **Required** (unless step disabled). Short final note + referral ask. Reviewer errors and exporter refuses if missing. |
| `subjectVariant` | Optional A/B/C tag (`role` / `team` / `plain`). Carried into the `notes` column; analytics rolls up reply rate by variant. |
| `copyStructure` | Optional scaffold tag (e.g. `trigger-proof-ask`, `candidacy-first`, `minimal`). Carried into `notes` as `copy_structure=`; analytics compares reply rate per scaffold. |
| `ctaType` | Optional override for the auto-detected CTA shape (`routing` / `fit` / `scheduling` / `curiosity`). The exporter auto-classifies from the body and writes `cta_type=` into `notes`. |

### `contactType` enum

- `recruiter`
- `hiring_manager`
- `software_engineer`
- `founder` (startup founders / co-founders)
- `hr` (HR-adjacent when no pure TA exists at very small companies)

Analytics downstream rely on these exact values.

**Peer SWE policy (2026-06):** max **3** `software_engineer` drafts per
campaign. Each must set `peerException: "usc_alumni"` or
`peerException: "near_certain_referral"` and document why in the spec
header comment. Default is **0** peer SWEs — prefer filling the tier total
with recruiters and HMs (`AGENTS.md` → "Sizing").

## Research brief before drafting (required for HM/SWE)

Before writing hiring-manager or software-engineer drafts, fill the per-contact
core fields from `CONTACT_RESEARCH_BRIEF_TEMPLATE.md`:

- `trigger` — a **person-specific** detail (their work, team, a GitHub signal
  from `output/signals/<slug>.json`), not a role/company restatement.
- `best_proof` — the concrete metric/artifact you'll lead the proof line with.
- `follow_up_plan` — the new angle each follow-up will carry (see below).
- `confidence` — `A`/`B`, or a stated reason if `C` (don't draft from `C`
  unless there's no better contact and the email stays very simple).

The reviewer's `generic_opener` check flags drafts whose sentence 1 leads on
you/the role instead of a person-specific trigger — fix those before export.
Recruiters can use a lighter brief (team/req alignment is the trigger).

## Copy rules (strategy owner: COLD_EMAIL_PLAYBOOK.md)

- 50–90 words per email, 2–3 `<p>` blocks
- One concrete trigger in sentence 1 (their work, history, team scope) — make
  it person-specific, not a role/company restatement. No mail-merge
  constructions like "Your [title] seat aligned with..." (lint:
  `templated_title_trigger`)
- One proof line in sentence 2 — use metrics where possible. Max 2 `<strong>`
  spans per email; don't reuse the same metric in more than ~half the
  campaign (lints: `excessive_bolding`, `proof_token_overused`)
- **Explicit ask (hard rule):** every email needs a candidacy anchor
  ("before I apply", "the right first ask for the X opening", req #) or a
  decision-shaped CTA (routing/fit/scheduling). A curiosity question alone is
  a lint ERROR (`missing_explicit_ask`) — it generates "what are you asking?"
  replies
- One short CTA — no multi-question asks. Soft chat-asks ("Would a 15-min
  chat on fit make sense?") are fine; hard scheduling (calendar links,
  proposed times) is not
- Rotate 3–4 copy scaffolds and ≥2 CTA shapes per campaign; tag drafts with
  `copyStructure` so analytics can compare
- No resume attachment, no links, no follow-ups in email 1
- Avoid "directionally relevant", "my background is strongest in", etc.
- **Human voice:** write like a person emailing a colleague, not a polished
  essay. Short sentences, contractions fine (`I'm`, `you're`), no stacked
  clauses. **Never use em dashes (—)** in email HTML; use a comma, period, or
  split into two sentences (lint: `em_dash`). Same rule for manual reply
  drafts and referral follow-ups.

When the JD's primary stack is a gap (e.g. TypeScript, .NET, Azure, Spring
Boot), **name the gap** rather than pretending — "X would be my ramp" is the
standard framing.

### Graduation status (post–May 2026)

Dhruv **graduated May 2026** (M.S. CS, USC). As of June 2026 onward, use the
**past tense** — the degree is complete, not pending:

- ✅ "USC M.S. completed May 2026", "M.S. in CS from USC (May 2026)",
  "completed my USC M.S. in May 2026"
- ❌ "USC M.S. completes May 2026", "wraps May 2026", "finishing my M.S.",
  "graduating in 2026" (these read as future/in-progress and are now stale)

Likewise, the **USC Annenberg Norman Lear Center** Software Engineer role
**ended May 2026** — frame it as prior experience ("At USC Annenberg I
built…"), not a current job. The `"May 2026 MS"` shorthand in `AGENTS.md`
remains accurate. Source of truth: `master_data.md`.

### Follow-ups (authored — mandatory)

Follow-ups are scheduled by the exporter (+4 / +8 business days) and the Apps
Script sequencer skips them if the contact already replied. **There is no
generic fallback anymore** — the exporter throws if an enabled follow-up is
unauthored, and the reviewer treats it as an error:

- `followUp1Html` — lead with a **new** proof angle or role mapping that
  wasn't in the first email (a different metric, a closer JD-requirement
  match) and restate the candidacy anchor. ~50–70 words, threaded (no subject).
- `followUp2Html` — short final note ending with a **referral ask** ("if
  someone else owns this, I'd appreciate the pointer").
- Run `review-cold-email-spec.mjs --strict` — unauthored follow-ups, generic
  "just checking in" phrasing, and follow-ups identical to the main email are
  errors; a follow-up 1 with no fresh concrete angle is a warning.
- Only skip authoring when a single touch is intended — then set
  `disableFollowUp1` / `followUpCount: 1` on the draft, or pass
  `--no-generate-followups` to the exporter.

## Subject-line A/B/C (recommended)

To learn which subject style converts, tag each draft with a `subjectVariant`
and rotate styles across the batch:

- `role` — role-anchored fragment ("Question about the New Grad role")
- `team` — names the team/product ("Quick question about Core Technology")
- `plain` — natural sentence a human would type ("Quick question about your
  Software Engineer opening"). Use on ~1/3 of the campaign.

```js
{ key: "...", to: "...", subject: "Quick question about your SWE opening",
  subjectVariant: "plain", copyStructure: "candidacy-first",
  html: `...`, /* follow-ups */ }
```

The exporter writes `subject_variant=<x>`, `cta_type=<x>`, and
`copy_structure=<x>` into the `notes` column, and `generate-analytics.mjs`
emits rollup scopes for each so reply rates by subject style, CTA shape, and
copy scaffold are directly comparable. Keep variant sets small (2–3 per
batch) so each accumulates enough sends to compare.

## Exporter — spec → CSV

```bash
node scripts/export-spec-to-apps-script-queue.mjs runs/SLUG.spec.mjs \
  --out output/apps-script/SLUG.queue.csv \
  --company "Pretty Company Name"
```

The `runs/SLUG.spec.mjs` argument is **positional**, not `--spec`.

**Always pass `--company`.** Otherwise the exporter derives it from the
filename, which yields ugly values like `"gmf swe 2026 04 20"`. The reports
array output will confirm the value it used.

The exporter applies randomized send spacing (5–35 min between rows) and
snaps the first send into business hours. Expected output:

```json
{
  "outputPath": "...queue.csv",
  "rowCount": 20,
  "company": "Cotiviti",
  "firstMainSendAt": "2026-04-22T16:00:00.000Z",
  "lastMainSendAt": "2026-04-22T23:07:42.464Z"
}
```

## Importer — CSV → Google Sheet

```bash
node scripts/import-queue-csv-to-sheet.mjs \
  --csv output/apps-script/SLUG.queue.csv
# Spreadsheet ID defaults to outreach.config.json (override with --spreadsheet-id)
```

Expected output:

```json
{
  "appendedRowCount": 20,
  "updatedRange": "Queue!A890:AB909"
}
```

## ⚠️ `updatedRange` is frequently misleading

The import script can report an `updatedRange` that doesn't match the actual
append location. Always verify by reading the sheet directly:

```bash
node -e "
import('./scripts/sheets-api.mjs').then(async m => {
  import('./scripts/config.mjs').then(async c => {
    const { accessToken } = await m.getSheetsAccessToken();
    const sid = c.getOutreachSpreadsheetId();
    const r = await m.getSheetValues(accessToken, sid, 'Queue!A880:I940');
    (r.values||[]).forEach((row, i) => {
      console.log(\`r\${880+i}: [\${row[3]||''}] \${row[2]||''} (\${row[1]||''}) send=\${row[7]||''}\`);
    });
  });
});"
```

Note the destructuring: `const { accessToken } = await m.getSheetsAccessToken()`.
The function returns an object, not the raw token.

Column index reference (0-based) for `Queue!A...`:

| idx | column            |
|-----|-------------------|
| 0   | job_id            |
| 1   | company           |
| 2   | contact_name      |
| 3   | contact_type      |
| 4   | recipient_email   |
| 5   | subject           |
| 6   | main_html         |
| 7   | main_send_at      |

## Verification checklist after import

- [ ] Row count matches expected draft count
- [ ] All rows contiguous (no gaps or overlaps with previous campaign)
- [ ] `contact_type` populated for every row
- [ ] `main_send_at` ISO timestamps fall on weekdays within business hours
- [ ] Append one entry to `CAMPAIGN_LOG.md` with the row range
