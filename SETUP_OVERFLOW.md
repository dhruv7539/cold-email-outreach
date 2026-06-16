# Overflow Mailbox (Optional Phase 2)

Use this **after** single-mailbox setup is complete and validated (`setup_complete: true`).

When one Gmail account hits daily volume limits, add a second account on its **own**
Google Sheet (separate-sheet model — not a shared queue).

## Overview

- **Primary sheet:** `outreach.config.json` → `google.primary_spreadsheet_id`
- **Overflow sheet:** `google.overflow_spreadsheet_id` (add to config)
- **Overflow sender:** `google.overflow_sender_email`
- Each sheet runs its own Apps Script copy of [`Code.gs`](apps-script/threaded-sequencer/Code.gs)

## Setup steps

1. Create a second Google account (or use an existing secondary Gmail).
2. Create a new Google Sheet (e.g. "Outreach Overflow").
3. Share the overflow sheet with your **primary OAuth account** (the one Node uses) as **Editor** so import scripts can write it.
4. Deploy Apps Script on the overflow sheet (same as SETUP.md Phase C).
5. Complete GCP OAuth test-user flow for the **overflow** Gmail.
6. Set overflow `Settings.sender_email` to the overflow Gmail.
7. Optional warm-up ramp for new accounts in Settings:
   - `warmup_start_date` (YYYY-MM-DD)
   - `warmup_base_per_day` (e.g. 40)
   - `warmup_factor` (e.g. 2)
8. Add to `outreach.config.json`:

```json
"google": {
  "overflow_spreadsheet_id": "YOUR_OVERFLOW_SHEET_ID",
  "overflow_sender_email": "overflow@gmail.com"
}
```

## Moving rows from primary → overflow

Preview (dry run):

```bash
node scripts/move-rows-to-overflow.mjs --overdue
```

Apply (cancels source rows to prevent double-send):

```bash
node scripts/move-rows-to-overflow.mjs --overdue --contact-types software_engineer,hr --max 8 --apply
```

Requires `--dest-id` or `google.overflow_spreadsheet_id` in config.

**Deliverability:** route lower-priority contacts to overflow during the first warm-up week; keep recruiters and hiring managers on the established primary account.

## Advanced: clasp deployment

If the Apps Script browser editor is unavailable (multi-account routing bug), use `clasp`:

1. Enable [Apps Script API](https://script.google.com/home/usersettings) on the overflow account.
2. `clasp login` with the overflow profile.
3. `clasp create-script --type sheets --parentId <OVERFLOW_SHEET_ID>`
4. Copy `Code.gs` + `appsscript.json` from this repo; `clasp push --force`.

Link a dedicated GCP project with the overflow Gmail as test user (same as SETUP.md Phase C3).
