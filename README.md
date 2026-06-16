# Cold Email Outreach Pipeline

Automated job-search cold email system: Apollo contact discovery → personalized spec files → Google Sheet queue → Apps Script sends threaded follow-ups from Gmail.

Built for **Cursor**: clone, open in Cursor, say **"Set up outreach"**, and the agent walks through setup using [`SETUP.md`](SETUP.md).

## Quick start

1. **Clone** this repo and open it in Cursor.
2. Say: **"Set up outreach"** (or **"Run first-time setup"**).
3. Follow the agent's prompts (Apollo key, Google OAuth, Sheet + Apps Script).
4. When `node scripts/validate-setup.mjs` passes, paste a JD and say **"Start outreach for this role"**.

Campaign workflow details: [`AGENTS.md`](AGENTS.md) (Cursor auto-loads this file).

## Prerequisites

- Node.js 18+
- Gmail / Google Workspace account
- [Apollo.io](https://app.apollo.io/) API key
- [Cursor](https://cursor.com/) (recommended)

## What it does

1. You paste a job description into Cursor.
2. Apollo finds recruiters, hiring managers, and team-aligned contacts.
3. The agent drafts personalized emails from your resume data and proof bank.
4. A linter enforces copy quality (explicit asks, no em dashes, follow-up authorship).
5. CSV export → Google Sheet import.
6. Apps Script sends on schedule with threaded follow-ups; replies and bounces are detected.

## Key files

| File | Purpose |
|------|---------|
| [`SETUP.md`](SETUP.md) | First-time setup playbook (Cursor executes this) |
| [`AGENTS.md`](AGENTS.md) | Campaign workflow for the AI agent |
| [`COLD_EMAIL_PLAYBOOK.md`](COLD_EMAIL_PLAYBOOK.md) | Copy strategy and rules |
| `outreach.config.json` | Your IDs and profile (gitignored — copy from `outreach.config.example.json`) |
| `master_data.md` | Your resume source of truth (gitignored — copy from template) |
| `COLD_EMAIL_PROOF_BANK.md` | Metric/artifact proof lines (gitignored) |
| `.env` | API keys (gitignored — copy from `.env.example`) |

## Manual commands

```bash
# Validate setup
node scripts/validate-setup.mjs

# Lint a spec
node scripts/review-cold-email-spec.mjs runs/your-spec.spec.mjs --strict

# Export → import
node scripts/export-spec-to-apps-script-queue.mjs runs/your-spec.spec.mjs --company "Acme"
node scripts/import-queue-csv-to-sheet.mjs --csv output/apps-script/your-spec.queue.csv

# Dedup before a new campaign
node scripts/list-skip-emails.mjs --company "Acme"
```

## Security

**Never commit:** `.env`, `outreach.config.json`, `client_secret*.json`, `master_data.md`, campaign specs in `runs/`, or OAuth credentials.

See [`PRE_PUBLISH_CHECKLIST.md`](PRE_PUBLISH_CHECKLIST.md) before making a fork public.

## Optional: second mailbox

High volume? See [`SETUP_OVERFLOW.md`](SETUP_OVERFLOW.md) for a second Gmail + sheet.

## License

Use and adapt for personal job search outreach. No warranty.
