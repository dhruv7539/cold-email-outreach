# First-Time Setup (Cursor-Executable)

This playbook is for **Cursor / the AI agent** to run when a new user clones the repo.
The user should say: **"Set up outreach"** or **"Run first-time setup"**.

Do not start JD discovery, Apollo searches, or campaign imports until every phase
below passes and `node scripts/validate-setup.mjs` exits 0.

---

## Prerequisites (tell the user)

- Node.js 18+ (uses native `fetch`; no `npm install` required)
- A Gmail / Google Workspace account to send from
- An [Apollo.io](https://app.apollo.io/) API key (contact discovery)
- Cursor IDE (recommended)

Optional later: GitHub token (faster GitHub-signal batches), Anthropic key (reply classification).

---

## Phase A — Collect profile and write local files

Interview the user and write gitignored local files. Copy templates first:

```bash
cp outreach.config.example.json outreach.config.json
cp master_data.template.md master_data.md
cp COLD_EMAIL_PROOF_BANK.template.md COLD_EMAIL_PROOF_BANK.md
cp CAMPAIGN_LOG.template.md CAMPAIGN_LOG.md
cp .env.example .env
```

### A1. `outreach.config.json`

Fill at minimum:

| Field | Example |
|-------|---------|
| `candidate.first_name` | Alex |
| `candidate.full_name` | Alex Chen |
| `candidate.email` | alex@university.edu |
| `candidate.university` | Stanford University |
| `candidate.degree` | MS Computer Science |
| `candidate.grad_date` | May 2026 |
| `candidate.github` | github.com/alexchen |
| `candidate.linkedin` | linkedin.com/in/alexchen |
| `candidate.us_citizen` | true/false |
| `google.sender_email` | same Gmail used for sending |
| `google.timezone` | America/Los_Angeles |
| `apollo.alumni_school_id` | Apollo school ID for alumni peer searches (optional) |

Leave `google.primary_spreadsheet_id` blank until Phase C.
Leave `setup_complete` as `false`.

### A2. `.env`

```bash
APOLLO_API_KEY=<user's Apollo key>
# Optional:
GITHUB_TOKEN=
ANTHROPIC_API_KEY=
```

### A3. `master_data.md`

Walk the user through each section of `master_data.template.md`:
contact info, education, work experience (with metric bullets), projects, skills,
stack positioning, citizenship/work authorization.

### A4. `COLD_EMAIL_PROOF_BANK.md`

Help the user add 5–10 proof IDs with metrics or verifiable artifacts.
Map proofs to role types (backend, full-stack, cloud, AI, etc.).

---

## Phase B — Google OAuth for Node.js tooling

The Node scripts need Sheets API access to import CSVs and verify the queue.

### B1. Google Cloud Console (user in browser)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/)
2. Enable **Google Sheets API** (and **Gmail API** if using reconcile/classify locally)
3. **APIs & Services → Credentials → Create OAuth client ID → Desktop app**
4. Download JSON → save as `client_secret_<client-id>.apps.googleusercontent.com.json` in repo root (gitignored)

Or copy `client_secret.example.json` structure if renaming manually.

### B2. Authorize (agent runs)

```bash
node scripts/authorize-google-sheets.mjs
```

User completes browser consent. Credentials save to `~/.gmail-mcp/sheets.credentials.json`.

### B3. Verify (after Phase C sheet ID is set)

```bash
node scripts/sheets-values.mjs get \
  --spreadsheet-id "$SHEET_ID" \
  --range "Settings!A1:B5"
```

---

## Phase C — Google Sheet + Apps Script (user in browser; agent coaches)

### C1. Create the sheet

1. New Google Sheet named **Cold Outreach Sequencer**
2. Copy the Sheet ID from the URL (`/d/<ID>/edit`)
3. Paste into `outreach.config.json` → `google.primary_spreadsheet_id`

### C2. Deploy Apps Script (menu path — recommended)

1. In the sheet: **Extensions → Apps Script**
2. Delete default files; paste from this repo:
   - [`apps-script/threaded-sequencer/Code.gs`](apps-script/threaded-sequencer/Code.gs)
   - [`apps-script/threaded-sequencer/appsscript.json`](apps-script/threaded-sequencer/appsscript.json)
3. **Services (+)** → add **Gmail API** (v1, identifier `Gmail`)
4. Save the project

### C3. GCP OAuth for Apps Script (prevents "This app is blocked")

Restricted scopes (`gmail.modify`) require a linked GCP project:

1. [console.cloud.google.com](https://console.cloud.google.com/) → new or existing project
2. **OAuth consent screen** → External → **Testing** status
3. Add the sender Gmail as a **Test user**
4. Enable Gmail API, Google Sheets API, Apps Script API on this project
5. In Apps Script editor: **Project Settings → Google Cloud Platform (GCP) Project** → link the project number

### C4. Initialize sheet and trigger

1. Reload the Google Sheet
2. Menu: **Outreach Sequencer → Setup Sheet**
3. Complete OAuth consent if prompted (Advanced → Go to … if unverified)
4. In **Settings** tab, set `sender_email` to the sending Gmail (must match `outreach.config.json`)
5. Menu: **Outreach Sequencer → Install Trigger** (1-minute `processQueue` + 15-minute reply check)

Default pacing (safe for new accounts): `min_seconds_between_sends=90`, `max_send_per_day=400`.

---

## Phase D — Self-test and mark complete

### D1. Queue self-test (agent runs)

If testing outside Mon–Fri 9–5 in the sheet timezone, the script temporarily relaxes weekend/per-domain gates.

```bash
node scripts/seed-self-test.mjs --apply --follow-up-minutes 2
```

This queues a main + follow-up to `candidate.email` from Phase A.

### D2. Wait and verify (2–4 minutes)

Check the Queue row:

```bash
node scripts/list-queued-emails.mjs --limit 5
```

Expect: `status=sent_main` → then follow-up sent in the **same Gmail thread**.

User should see two emails from their sender address in their inbox.

### D3. Revert temp settings (if off-hours test)

In Sheet **Settings**:

- `allow_weekends` → `FALSE`
- `min_seconds_between_sends` → `90`
- `per_domain_min_minutes` → `12`

Cancel or archive the self-test row.

### D4. Mark setup complete

In `outreach.config.json`, set `"setup_complete": true`.

### D5. Final validation

```bash
node scripts/validate-setup.mjs
```

Must exit 0 before any campaign work.

---

## After setup

Read [`AGENTS.md`](AGENTS.md) for the end-to-end JD workflow.

Example first campaign:

> "Start outreach for this JD" (paste job description)

---

## Optional Phase 2 — Overflow mailbox

When daily volume exceeds one Gmail account's comfort zone, see [`SETUP_OVERFLOW.md`](SETUP_OVERFLOW.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "This app is blocked" on Apps Script | GCP test user + link GCP project (Phase C3) |
| Follow-ups never send, mains work | Re-run **Install Trigger**; check Apps Script execution log for errors |
| `APOLLO_API_KEY missing` | Add key to `.env` |
| `Missing outreach.config.json` | Phase A — copy example file |
| Import 403 on sheet | Share sheet with the OAuth account as Editor |
| Self-test follow-up delayed | Normal — 90s min spacing + 1-min trigger interval |
