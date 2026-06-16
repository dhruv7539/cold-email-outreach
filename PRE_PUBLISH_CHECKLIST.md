# Pre-Publish Checklist (Public GitHub)

Run before making this repository public or sharing widely.

## Secrets and personal data (must NOT be in git)

- [ ] `.env` is gitignored and never committed
- [ ] `outreach.config.json` is gitignored (only `outreach.config.example.json` is tracked)
- [ ] `master_data.md`, `COLD_EMAIL_PROOF_BANK.md`, `CAMPAIGN_LOG.md` are gitignored
- [ ] `client_secret*.json` are gitignored
- [ ] `output/`, `runs/*` (except `runs/example-*.spec.mjs`), `applications/` are gitignored
- [ ] `apps-script/**/.clasp*/` and `.clasp.json` are gitignored

## Scan tracked files for leaks

```bash
rg -i "dbhander@|dhruvbhanderi|1Z02p34|1YNfiNW|APOLLO_API_KEY=sk|client_secret" \
  --glob '!outreach.config.json' --glob '!.env' --glob '!CAMPAIGN_LOG.md' \
  --glob '!master_data.md' --glob '!output/**' --glob '!runs/**' --glob '!.git/**'
```

Expect **zero matches** in files you intend to publish. Known exceptions:

- `PRE_PUBLISH_CHECKLIST.md` (this file — contains example search patterns)
- Local-only paths inside gitignored files

## Git history

If `.env`, OAuth JSON, or personal campaign data were ever committed:

```bash
git log --all --full-history -- .env outreach.config.json
```

If found, use [git filter-repo](https://github.com/newren/git-filter-repo) or start a fresh public repo with a clean initial commit.

## Templates committed

- [ ] `outreach.config.example.json`
- [ ] `master_data.template.md`
- [ ] `COLD_EMAIL_PROOF_BANK.template.md`
- [ ] `CAMPAIGN_LOG.template.md`
- [ ] `.env.example`
- [ ] `client_secret.example.json`
- [ ] `runs/example-company-role-2026-04-06.spec.mjs`

## Docs for new users

- [ ] `README.md` — quick start
- [ ] `SETUP.md` — Cursor-executable setup
- [ ] `AGENTS.md` — generic (no personal Sheet IDs or names)
- [ ] `.cursor/rules/setup-outreach.mdc` — setup gate

## Optional: remove stale personal paths

Search for absolute paths containing your username:

```bash
rg "Documents/Personal Projects" --glob '!.git/**'
```

Replace with relative links (`master_data.md`) in tracked markdown.
