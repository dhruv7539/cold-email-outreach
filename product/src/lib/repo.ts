import { query, queryOne, transaction } from "./db";
import { encrypt, decrypt, hashToken } from "./crypto";
import { classifyReply } from "@core/replies/classify.mjs";

// Account-level persistence: users, profiles, credentials, agent tokens, and the
// suppression / known-address tables. Campaign-specific access lives in
// src/lib/campaign/repo.ts.

export type User = {
  id: string;
  email: string;
  created_at: Date;
  last_login_at: Date | null;
  onboarded_at: Date | null;
};

export async function findOrCreateUser(email: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  return (await queryOne<User>(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [normalized]
  ))!;
}

export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function markOnboarded(userId: string): Promise<void> {
  await query("UPDATE users SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $1", [userId]);
}

// --- Profile ---------------------------------------------------------------

export async function getProfile(userId: string): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ data: Record<string, unknown> }>(
    "SELECT data FROM profiles WHERE user_id = $1",
    [userId]
  );
  return row?.data ?? null;
}

export async function saveProfile(userId: string, data: unknown): Promise<void> {
  await query(
    `INSERT INTO profiles (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(data)]
  );
}

// --- Credentials (encrypted at rest) ---------------------------------------

export type Credentials = {
  apolloApiKey: string | null;
  llmProvider: string | null;
  llmApiKey: string | null;
  millionVerifierApiKey: string | null;
};

export async function getCredentials(userId: string): Promise<Credentials> {
  const row = await queryOne<{
    apollo_api_key_enc: string | null;
    llm_provider: string | null;
    llm_api_key_enc: string | null;
    millionverifier_api_key_enc: string | null;
  }>("SELECT * FROM credentials WHERE user_id = $1", [userId]);

  if (!row) return { apolloApiKey: null, llmProvider: null, llmApiKey: null, millionVerifierApiKey: null };
  const safeDecrypt = (v: string | null) => (v ? decrypt(v) : null);
  return {
    apolloApiKey: safeDecrypt(row.apollo_api_key_enc),
    llmProvider: row.llm_provider,
    llmApiKey: safeDecrypt(row.llm_api_key_enc),
    millionVerifierApiKey: safeDecrypt(row.millionverifier_api_key_enc),
  };
}

export async function saveCredentials(
  userId: string,
  patch: { llmProvider?: string; llmApiKey?: string; apolloApiKey?: string; millionVerifierApiKey?: string }
): Promise<void> {
  // COALESCE keeps an existing key when the field is omitted (blank input means
  // "leave as-is"), so a user updating one key does not wipe the others.
  await query(
    `INSERT INTO credentials (user_id, llm_provider, llm_api_key_enc, apollo_api_key_enc, millionverifier_api_key_enc, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       llm_provider = COALESCE($2, credentials.llm_provider),
       llm_api_key_enc = COALESCE($3, credentials.llm_api_key_enc),
       apollo_api_key_enc = COALESCE($4, credentials.apollo_api_key_enc),
       millionverifier_api_key_enc = COALESCE($5, credentials.millionverifier_api_key_enc),
       updated_at = now()`,
    [
      userId,
      patch.llmProvider ?? null,
      patch.llmApiKey ? encrypt(patch.llmApiKey) : null,
      patch.apolloApiKey ? encrypt(patch.apolloApiKey) : null,
      patch.millionVerifierApiKey ? encrypt(patch.millionVerifierApiKey) : null,
    ]
  );
}

// --- Agent (sheet) tokens --------------------------------------------------

export async function createAgentToken(userId: string, token: string, label = "sheet"): Promise<void> {
  await query(
    "INSERT INTO agent_tokens (token_hash, user_id, label) VALUES ($1, $2, $3)",
    [hashToken(token), userId, label]
  );
}

export async function revokeAgentTokens(userId: string): Promise<void> {
  await query("UPDATE agent_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export async function getSheetConnection(userId: string) {
  return queryOne<{ last_synced_at: Date | null; sender_email: string | null }>(
    `SELECT last_synced_at, sender_email FROM agent_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY last_synced_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [userId]
  );
}

/** Resolves a plaintext pairing token to its owning user, or null. */
export async function resolveAgentToken(token: string): Promise<{ userId: string } | null> {
  const row = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)]
  );
  return row ? { userId: row.user_id } : null;
}

export async function recordSync(token: string, senderEmail: string): Promise<void> {
  await query(
    "UPDATE agent_tokens SET last_synced_at = now(), sender_email = COALESCE(NULLIF($2, ''), sender_email) WHERE token_hash = $1",
    [hashToken(token), senderEmail]
  );
}

// --- Queue hand-off (blacklist enforced here) ------------------------------

export type QueueRow = { job_id: string; recipient_email: string; row: Record<string, unknown> };

/**
 * Pending rows to hand to the sheet, with suppressed addresses filtered out at
 * the last possible moment so nothing on the blacklist can ship even if it
 * slipped through earlier.
 */
export async function claimPendingRows(userId: string, limit = 50): Promise<QueueRow[]> {
  return query<QueueRow>(
    `SELECT q.job_id, q.recipient_email, q.row
     FROM queue_items q
     WHERE q.user_id = $1 AND q.delivery_state = 'pending'
       AND lower(q.recipient_email) NOT IN (SELECT email FROM blacklist WHERE user_id = $1)
     ORDER BY q.created_at
     LIMIT $2`,
    [userId, limit]
  );
}

export type AgentEvent = {
  job_id: string;
  status?: string;
  active_step?: string;
  gmail_thread_id?: string;
  main_sent_at?: string;
  follow_up_1_sent_at?: string;
  reply_detected_at?: string;
  error?: string;
  reply_snippet?: string;
};

/**
 * Applies a batch of reported events: marks rows delivered, mirrors send/reply
 * state, blacklists bounces, and honors opt-outs (suppress + cancel).
 */
export async function applyEvents(userId: string, events: AgentEvent[]): Promise<number> {
  if (!events.length) return 0;

  return transaction(async (client) => {
    let applied = 0;

    for (const event of events) {
      await client.query(
        `INSERT INTO events (user_id, job_id, status, active_step, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, event.job_id, event.status ?? "", event.active_step ?? "", JSON.stringify(event)]
      );

      const result = await client.query<{ recipient_email: string }>(
        `UPDATE queue_items SET
           delivery_state = 'delivered',
           delivered_at = COALESCE(delivered_at, now()),
           status = COALESCE(NULLIF($3, ''), status),
           active_step = COALESCE(NULLIF($4, ''), active_step),
           gmail_thread_id = COALESCE(NULLIF($5, ''), gmail_thread_id),
           main_sent_at = COALESCE($6, main_sent_at),
           follow_up_1_sent_at = COALESCE($7, follow_up_1_sent_at),
           reply_detected_at = COALESCE($8, reply_detected_at),
           error = COALESCE(NULLIF($9, ''), error),
           updated_at = now()
         WHERE user_id = $1 AND job_id = $2
         RETURNING recipient_email`,
        [
          userId,
          event.job_id,
          event.status ?? "",
          event.active_step ?? "",
          event.gmail_thread_id ?? "",
          event.main_sent_at ? new Date(event.main_sent_at) : null,
          event.follow_up_1_sent_at ? new Date(event.follow_up_1_sent_at) : null,
          event.reply_detected_at ? new Date(event.reply_detected_at) : null,
          event.error ?? "",
        ]
      );

      if (result.rowCount) {
        applied += 1;
        const email = String(result.rows[0].recipient_email).toLowerCase();

        if (event.status === "bounced") {
          await client.query(
            `INSERT INTO blacklist (user_id, email, reason, source) VALUES ($1, $2, $3, 'bounce')
             ON CONFLICT (user_id, email) DO NOTHING`,
            [userId, email, event.error || "bounced"]
          );
        }

        // Honor opt-outs. When a reply says "remove me" / "do not contact",
        // suppress the address (so no future campaign emails it) and mark this
        // row unsubscribed. The sheet already stops follow-ups on any reply, so
        // this primarily protects future campaigns.
        if (event.reply_snippet) {
          const verdict = classifyReply(event.reply_snippet) as { actsAsUnsubscribe: boolean };
          if (verdict.actsAsUnsubscribe) {
            await client.query(
              `INSERT INTO blacklist (user_id, email, reason, source) VALUES ($1, $2, 'requested opt-out', 'unsubscribe')
               ON CONFLICT (user_id, email) DO UPDATE SET reason = 'requested opt-out', source = 'unsubscribe'`,
              [userId, email]
            );
            await client.query(
              `UPDATE queue_items SET status = 'unsubscribed', active_step = 'done', updated_at = now()
               WHERE user_id = $1 AND job_id = $2`,
              [userId, event.job_id]
            );
          }
        }
      }
    }

    return applied;
  });
}

export async function getSendHistory(userId: string) {
  return query<{ status: string; main_sent_at: Date | null; reply_detected_at: Date | null }>(
    `SELECT status, main_sent_at, reply_detected_at FROM queue_items
     WHERE user_id = $1 AND main_sent_at IS NOT NULL
     ORDER BY main_sent_at`,
    [userId]
  );
}

// --- Suppression + learned addresses ---------------------------------------

export async function addToBlacklist(userId: string, email: string, reason: string, source: string) {
  await query(
    `INSERT INTO blacklist (user_id, email, reason, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source`,
    [userId, email.toLowerCase(), reason, source]
  );
}

export async function getBlacklist(userId: string) {
  return query<{ email: string; reason: string; source: string }>(
    "SELECT email, reason, source FROM blacklist WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
}

/** All emails to skip for this user: everything queued plus everything suppressed. */
export async function getSkipEmails(userId: string): Promise<Set<string>> {
  const rows = await query<{ email: string }>(
    `SELECT lower(recipient_email) AS email FROM queue_items WHERE user_id = $1
     UNION
     SELECT email FROM blacklist WHERE user_id = $1`,
    [userId]
  );
  return new Set(rows.map((r) => r.email));
}

export async function recordKnownAddresses(
  userId: string,
  addresses: { email: string; firstName?: string; lastName?: string; fullName?: string }[]
): Promise<void> {
  if (!addresses.length) return;
  await transaction(async (client) => {
    for (const a of addresses) {
      const email = a.email.toLowerCase();
      const domain = email.split("@")[1] ?? "";
      await client.query(
        `INSERT INTO known_addresses (user_id, email, domain, first_name, last_name, full_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, email) DO NOTHING`,
        [userId, email, domain, a.firstName ?? "", a.lastName ?? "", a.fullName ?? ""]
      );
    }
  });
}

export async function getKnownAddressesForDomains(userId: string, domains: string[]) {
  if (!domains.length) return [];
  return query<{ email: string; domain: string; first_name: string; last_name: string; full_name: string }>(
    `SELECT email, domain, first_name, last_name, full_name FROM known_addresses
     WHERE user_id = $1 AND domain = ANY($2)`,
    [userId, domains.map((d) => d.toLowerCase())]
  );
}
