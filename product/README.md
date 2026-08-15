# Outreach Hub

A hosted version of the cold-email outreach system. It turns a pasted job
description into a set of personalized emails that the user reviews and approves,
then sends from their own Gmail through a copied Google Sheet. Users bring their
own Apollo and AI keys; the product itself is free to run.

## Why the architecture looks like this

The single hardest constraint is Google OAuth: sending mail on a user's behalf
from a server requires restricted scopes and a security review that a free
side-project cannot pass. So the product never touches Gmail. Instead:

- **The brain is here** (this app): finding contacts, resolving addresses,
  scoring fit, drafting and linting emails, and holding the approved queue.
- **The arm is the user's own Google Sheet** (`apps-script/`): a copy of the
  existing threaded-sequencer plus a small `Bridge.gs` that pulls approved rows
  from this app and reports send/reply/bounce events back. It runs under the
  user's own authorization, in their account.

The two talk over a simple token-authenticated HTTP protocol. No Google
credential for the user ever exists on this server.

## Layout

- `core/` — plain ESM library ported verbatim from the CLI `scripts/`: the
  linter, CTA classifier, Apollo client, address resolution, health thresholds,
  timezone map, and the spec-to-queue-rows builder. Shared, not reimplemented,
  so the quality gate stays identical to the battle-tested original.
- `src/lib/llm/` — the discrete LLM pipeline (parse JD, score intake, select
  contacts, write brief, draft, repair loop) with a BYOK adapter for Anthropic,
  OpenAI, and Gemini.
- `src/lib/` — crypto, database, auth, and the repository layer.
- `src/app/` — the Next.js app: onboarding, campaign flow, dashboard, settings.
- `db/` — the multi-tenant Postgres schema.
- `apps-script/` — `Bridge.gs`, copied alongside the existing `Code.gs`.

## Local setup

```bash
cd product
npm install
cp .env.example .env.local   # fill in DATABASE_URL and APP_ENCRYPTION_KEY
npm run migrate              # apply db/001_initial.sql
npm run dev
```

See the repo root `AGENTS.md` for the original CLI system this is built on.
