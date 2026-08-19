# Deploying Outreach Hub

This gets the app live on **Vercel** with a **Neon** Postgres database. Both have
free tiers that comfortably cover a personal / friends-and-family deployment.
Supabase works too; the only difference is where you copy the connection string
from (see the note at the end).

Total time is short: the two things that take longest are waiting for the first
Vercel build and copying/pasting env vars.

---

## 1. Create the database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a project (any region).
2. In the project dashboard, open **Connection Details**. You will see two
   connection strings. You need both:
   - **Pooled** connection string (host contains `-pooler`). This is what the
     running app uses. It ends in `?sslmode=require`.
   - **Direct** connection string (no `-pooler`). This is what you run the
     migration with once.
3. Keep both handy for the steps below.

Why two: the app runs on serverless functions that each open their own
connections, so it must go through Neon's connection pooler. The migration runs
one multi-statement transaction, which wants a single direct connection.

---

## 2. Generate the app secrets

Run these locally and save the output:

```bash
# 32-byte key that encrypts users' API keys at rest
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# secret that protects the daily cleanup cron
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## 3. Run the migration (once)

From the `product/` directory, against the **direct** connection string:

```bash
cd product
npm install
DATABASE_URL="<NEON_DIRECT_CONNECTION_STRING>" npm run migrate
```

You should see `applied 001_initial.sql` then `migrations complete`. Re-running
is safe; it skips files already applied.

---

## 4. Deploy to Vercel

1. Push this repo to GitHub (already done if you're reading this in a PR).
2. At [vercel.com](https://vercel.com) → **Add New Project** → import the repo.
3. **Important:** set **Root Directory** to `product`. Vercel then auto-detects
   Next.js; leave the build and install commands at their defaults.
4. Add these **Environment Variables** (Production, and Preview if you want
   previews to work):

   | Name | Value |
   |------|-------|
   | `DATABASE_URL` | Neon **pooled** connection string |
   | `APP_ENCRYPTION_KEY` | the 32-byte base64 key from step 2 |
   | `APP_URL` | your deployment URL, e.g. `https://your-app.vercel.app` |
   | `CRON_SECRET` | the hex secret from step 2 |
   | `RESEND_API_KEY` | a [Resend](https://resend.com) API key (for sign-in emails) |
   | `MAGIC_LINK_FROM` | e.g. `Outreach Hub <login@yourdomain.com>` |
   | `TEMPLATE_SHEET_URL` | set after step 5 below |

5. Deploy. Once it's live, set `APP_URL` to the real URL if it changed and
   redeploy so magic links point at the right host.

Notes:
- The daily cleanup cron (`vercel.json`) runs `/api/cron/cleanup` and needs
  `CRON_SECRET` set; Vercel sends it automatically.
- Without `RESEND_API_KEY` the app still works locally (the sign-in link prints
  to the server logs), but for a real deployment you want email delivery. Resend's
  free tier is enough; verify a sending domain or use their test sender.

---

## 5. Publish the template Google Sheet

Users copy one sheet that already contains the sending logic.

1. Create a new Google Sheet in a Google account you control.
2. Extensions → Apps Script. Add the files from
   `apps-script/threaded-sequencer/`: at minimum **`Code.gs`** and
   **`Bridge.gs`** (paste each into a file of the same name). Save.
3. Back in the sheet, reload. You'll get an **Outreach Sequencer** menu. Run
   **Setup Sheet** once to create the tabs.
4. File → Share → General access → **Anyone with the link can view**.
5. Copy the sheet URL and set it as `TEMPLATE_SHEET_URL` in Vercel, then
   redeploy. The onboarding flow links users to it; each user does
   File → Make a copy to get their own private, editable version.

When a user opens their copy's Apps Script menu the first time, Google shows an
"app isn't verified" warning because it is *their own* private script. That's
expected; they choose Advanced → continue.

---

## 6. Smoke test end to end

1. Visit `APP_URL`, sign in with a magic link (check email, or server logs if no
   Resend key).
2. Onboarding: add an AI key + Apollo key, upload a resume, generate a pairing
   token.
3. Copy the template sheet, paste `api_base_url` (your `APP_URL`) and
   `pairing_token` into its Settings tab, then run **Install Trigger** and
   **Install Hub Sync Trigger**, and **Connect to Hub (test)**.
4. Back in the app, the onboarding "Check connection" step should flip to
   connected after the sheet's first sync.
5. Start a campaign, approve one email, queue it, and confirm it appears in the
   sheet's Queue tab on the next sync and then sends from your Gmail.

---

## Using Supabase instead of Neon

Everything is identical except the connection strings:
- App (`DATABASE_URL`): Supabase → Project Settings → Database → **Connection
  pooling** (Transaction mode) string.
- Migration: the **direct** (session) connection string from the same page.

The code auto-enables TLS for both providers; no other changes are needed.
