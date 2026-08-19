-- Outreach hub schema.
--
-- Multi-tenant from the start: every table that holds user data carries a
-- user_id, and every query in src/lib filters on it. There is no shared state
-- between tenants except the schema itself.
--
-- Note what is NOT here: no Gmail tokens, no Google OAuth refresh tokens, no
-- message bodies of anyone's inbox. Sending happens inside each user's own
-- Google account, so the most sensitive credential in the system never exists on
-- this server.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  -- Set once the sheet has completed a successful sync.
  onboarded_at  TIMESTAMPTZ
);

-- Magic-link sign in. Tokens are stored hashed so a database leak cannot be
-- replayed into account access.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_user_idx ON login_tokens(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Resume-derived profile plus proof bank. JSONB because the shape is validated
-- in application code by core/profile/schema.mjs and evolves with the prompts.
CREATE TABLE profiles (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bring-your-own-key credentials, encrypted with AES-256-GCM before they ever
-- reach the database (see src/lib/crypto.ts). Columns hold ciphertext.
CREATE TABLE credentials (
  user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  apollo_api_key_enc          TEXT,
  llm_provider                TEXT,
  llm_api_key_enc             TEXT,
  millionverifier_api_key_enc TEXT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pairing token the user pastes into their sheet's Settings tab. Stored
-- hashed; the plaintext is shown once at creation and never again.
CREATE TABLE agent_tokens (
  token_hash     TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL DEFAULT 'sheet',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ,
  sender_email   TEXT,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX agent_tokens_user_idx ON agent_tokens(user_id);

CREATE TABLE campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company          TEXT NOT NULL,
  role_title       TEXT NOT NULL DEFAULT '',
  req_id           TEXT NOT NULL DEFAULT '',
  apply_url        TEXT NOT NULL DEFAULT '',
  job_text         TEXT NOT NULL DEFAULT '',
  parsed_job       JSONB NOT NULL DEFAULT '{}'::jsonb,
  intake_score     INTEGER,
  intake_verdict   TEXT,        -- skip | light | full
  intake_rationale TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'draft',
                                -- draft | scored | discovering | discovered
                                -- | drafting | review | queued | blocked
  status_detail    TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_user_idx ON campaigns(user_id, created_at DESC);

CREATE TABLE contacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  apollo_id          TEXT,
  first_name         TEXT NOT NULL DEFAULT '',
  last_name          TEXT NOT NULL DEFAULT '',
  full_name          TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  headline           TEXT NOT NULL DEFAULT '',
  contact_type       TEXT NOT NULL DEFAULT '',
  email              TEXT,
  -- known | learned_pattern | candidate_sweep | enriched | unresolved
  email_source       TEXT,
  email_verification JSONB,
  linkedin_url       TEXT,
  city               TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT '',
  selected           BOOLEAN NOT NULL DEFAULT false,
  brief              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contacts_campaign_idx ON contacts(campaign_id);
CREATE INDEX contacts_user_idx ON contacts(user_id);

-- A drafted email pair, before approval. Kept separate from queue_items so an
-- unapproved draft can never be picked up by the sheet.
CREATE TABLE drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- One draft per contact, so re-running drafting replaces rather than duplicates.
  contact_id      UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL DEFAULT '',
  main_html       TEXT NOT NULL DEFAULT '',
  follow_up_1_html TEXT NOT NULL DEFAULT '',
  cta_type        TEXT NOT NULL DEFAULT '',
  lead_proof      TEXT NOT NULL DEFAULT '',
  copy_structure  TEXT NOT NULL DEFAULT '',
  subject_variant TEXT NOT NULL DEFAULT '',
  lint_findings   JSONB NOT NULL DEFAULT '[]'::jsonb,
  lint_errors     INTEGER NOT NULL DEFAULT 0,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  -- Approval is a person clicking approve. Nothing reaches a queue without it.
  approved_at     TIMESTAMPTZ,
  edited_by_user  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drafts_campaign_idx ON drafts(campaign_id);

-- Approved rows waiting for, or already delivered to, the user's sheet. Mirrors
-- the Queue tab; delivery_state tracks the handoff itself.
CREATE TABLE queue_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          TEXT NOT NULL UNIQUE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  draft_id        UUID REFERENCES drafts(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  row             JSONB NOT NULL,

  -- pending -> the sheet has not confirmed receipt; keep re-delivering
  -- delivered -> a status event arrived for this job_id
  delivery_state  TEXT NOT NULL DEFAULT 'pending',
  delivered_at    TIMESTAMPTZ,

  -- Mirrors of the sheet's own state, updated from reported events.
  status              TEXT NOT NULL DEFAULT 'queued',
  active_step         TEXT NOT NULL DEFAULT 'main',
  gmail_thread_id     TEXT,
  main_sent_at        TIMESTAMPTZ,
  follow_up_1_sent_at TIMESTAMPTZ,
  reply_detected_at   TIMESTAMPTZ,
  error               TEXT NOT NULL DEFAULT '',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX queue_items_pending_idx ON queue_items(user_id, delivery_state) WHERE delivery_state = 'pending';
CREATE INDEX queue_items_user_sent_idx ON queue_items(user_id, main_sent_at DESC);
CREATE INDEX queue_items_campaign_idx ON queue_items(campaign_id);

-- Append-only audit of what the sheet reported, kept separate from the mutable
-- mirror above so a bad sync can be reconstructed.
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT '',
  active_step TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_user_idx ON events(user_id, reported_at DESC);
CREATE INDEX events_job_idx ON events(job_id);

-- Suppression list. The Apps Script writes bounces to its own Blacklist tab but
-- never reads it before sending; the hub filters against this table on the way
-- out, which closes that gap.
CREATE TABLE blacklist (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'bounced',
  source     TEXT NOT NULL DEFAULT 'bounce',  -- bounce | unsubscribe | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email)
);

-- Verified addresses seen at a domain, so a company's format can be learned once
-- and reused. Scoped per user: one tenant's Apollo credits must not silently
-- subsidise another's.
CREATE TABLE known_addresses (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  domain     TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name  TEXT NOT NULL DEFAULT '',
  full_name  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email)
);
CREATE INDEX known_addresses_domain_idx ON known_addresses(user_id, domain);
