# Apps Script Threaded Sequencer

This Google Apps Script project runs your outreach queue from a Google Sheet so main emails and follow-ups can send while your laptop is off.

What it does:
- sends the main email at the scheduled time
- sends follow-ups in the same Gmail thread
- skips follow-ups if someone replies
- enforces weekday and business-hour sending
- keeps row-by-row status in the sheet

## Tabs

The script manages two tabs:
- `Queue`
- `Settings`

The `Queue` tab stores one contact per row.

The `Settings` tab controls:
- timezone
- allow_weekends
- send window
- send cap per trigger run
- sender email override

## Queue Columns

The script expects these columns:

`job_id, company, contact_name, contact_type, recipient_email, subject, main_html, main_send_at, follow_up_1_html, follow_up_1_send_at, follow_up_2_html, follow_up_2_send_at, attachment_file_id, status, active_step, gmail_thread_id, root_message_id, last_message_id, sender_email, main_sent_at, follow_up_1_sent_at, follow_up_2_sent_at, reply_detected_at, last_sent_at, created_at, updated_at, notes, error, recipient_timezone`

Important fields:
- `main_send_at`, `follow_up_1_send_at`, `follow_up_2_send_at`: use ISO timestamps like `2026-03-24T16:00:00.000Z`
- `main_html`, `follow_up_1_html`, `follow_up_2_html`: HTML email bodies
- `attachment_file_id`: optional Google Drive file id for an attachment on the main email
- `recipient_timezone`: optional IANA zone (e.g. `America/New_York`) used to gate sends to the recipient's local business hours; blank falls back to the global `timezone` setting

> Migration: this column was appended after `error`. On an existing sheet, add a `recipient_timezone` header in the next empty column (or re-run `setupOutreachSheet` on a fresh sheet). Existing rows with a blank value simply fall back to the global timezone.

## Setup

1. Create a Google Sheet for the queue.
2. Open `Extensions -> Apps Script`.
3. Replace the default files with the files in this folder.
4. In Apps Script, open `Services`, add `Gmail API`.
5. Save the project.
6. Run `setupOutreachSheet` once.
7. Fill `Settings`, especially `sender_email` if it is blank.
8. Run `installOutreachTrigger` once.

The time-driven trigger runs every minute.

## Using It

1. Load or paste rows into `Queue`.
2. Set `status` to `queued`.
3. Set the scheduled timestamps.
4. Let the trigger run.

Row lifecycle:
- `queued`
- `sent_main`
- `sent_follow_up_1`
- `completed`
- `replied`
- `cancelled`
- `failed`

## Importing Existing Run Specs

Use the local exporter from this repo:

```bash
node scripts/export-spec-to-apps-script-queue.mjs runs/nue-full-stack-software-engineer-new-grad-2026-03-21.spec.mjs --company Nue
```

That writes a CSV you can paste or import into the `Queue` tab.

By default the exporter:
- creates business-hour main send times
- spaces contacts a few minutes apart
- generates short follow-up 1 and follow-up 2 templates

## Notes

- This does not use Gmail's native `Scheduled` folder.
- It still sends follow-ups in the same recipient-visible thread.
- If you want attachments, upload the file to Google Drive and paste its file id into `attachment_file_id`.
