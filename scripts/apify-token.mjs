// Shared Apify token loader with backup fallback on usage-limit exhaustion.
// Reads repo-root .env first so a stale shell export cannot mask an updated key.
// Mirrors scripts/apollo-api-key.mjs: primary token is used until it hits a
// usage/quota/rate limit, then requests transparently continue on the backup so
// the job-finding pipeline never stalls.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const APIFY_TOKEN_ENV = "APIFY_TOKEN";
export const APIFY_BACKUP_ENV = "APIFY_API_KEY_BACKUP";
export const API_BASE = "https://api.apify.com/v2";

function readRepoDotEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {
    // no .env
  }
  return env;
}

/**
 * True when an Apify HTTP error means "this token is out of budget/quota" (as
 * opposed to a bad request or a transient actor failure). On these we rotate to
 * the backup token. Covered cases:
 *   - 402 Payment Required, 429 Too Many Requests.
 *   - Usage/limit messages Apify returns with a 403 (monthly platform usage,
 *     prepaid usage exhausted).
 *   - HTTP 400 `max-items-must-be-greater-than-zero` ("Maximum charged results
 *     must be greater than zero"): a pay-per-result actor emits this when the
 *     token's remaining usage can't fund even one charged result. Observed in
 *     production (job-radar 2026-08-21), so it MUST trigger fallback even though
 *     it is a 400, not a 402/403.
 */
export function isApifyLimitError(status, text) {
  if (status === 402 || status === 429) return true;
  const lower = String(text).toLowerCase();
  return (
    lower.includes("usage limit") ||
    lower.includes("usage-limit") ||
    lower.includes("limit exceeded") ||
    lower.includes("hard limit") ||
    lower.includes("monthly usage") ||
    lower.includes("quota") ||
    lower.includes("payment required") ||
    lower.includes("insufficient") ||
    lower.includes("max-items-must-be-greater-than-zero") ||
    lower.includes("maximum charged results must be greater than")
  );
}

export function loadApifyTokens() {
  const fileEnv = readRepoDotEnv();
  const primary = (fileEnv[APIFY_TOKEN_ENV] || process.env[APIFY_TOKEN_ENV])?.trim();
  const backup = (fileEnv[APIFY_BACKUP_ENV] || process.env[APIFY_BACKUP_ENV])?.trim();
  if (!primary && !backup) {
    throw new Error("APIFY_TOKEN missing (add to .env — Apify Integrations page)");
  }
  return { primary, backup };
}

/**
 * Mutable session shared across all Apify requests in one run. It starts on the
 * primary token and, the first time a request hits a usage limit, permanently
 * switches to the backup for the rest of the run so the job never stops.
 *
 * The core primitive is `request(buildUrl, fetchOptions)`:
 *   - buildUrl: (token) => string — build the full Apify URL for a given token.
 *   - returns { res, text, tier } for a successful (res.ok) response.
 *   - throws `Error("Apify <status>: <body>")` on a real, non-recoverable error.
 */
export function createApifyTokenSession(tokens = loadApifyTokens()) {
  let activeTier = tokens.primary ? "primary" : "backup";
  let switchedToBackup = false;
  const tokenFor = (tier) => (tier === "backup" ? tokens.backup : tokens.primary);

  async function request(buildUrl, fetchOptions = {}) {
    // Only the primary can fall back; once on backup we stay there.
    const tiers = activeTier === "primary" && tokens.backup ? ["primary", "backup"] : [activeTier];
    let lastStatus = 0;
    let lastText = "";
    for (const tier of tiers) {
      const token = tokenFor(tier);
      if (!token) continue;
      const res = await fetch(buildUrl(token), fetchOptions);
      const text = await res.text();
      if (res.ok) {
        if (tier === "backup" && activeTier === "primary") {
          activeTier = "backup";
          switchedToBackup = true;
          console.warn("Apify: using backup token for the remainder of this run");
        }
        return { res, text, tier };
      }
      lastStatus = res.status;
      lastText = text;
      if (tier === "primary" && tokens.backup && isApifyLimitError(res.status, text)) {
        console.warn(
          `Apify primary token hit a limit (${res.status}); switching to backup token`
        );
        continue;
      }
      break;
    }
    throw new Error(`Apify ${lastStatus}: ${String(lastText).slice(0, 500)}`);
  }

  return {
    get activeTier() {
      return activeTier;
    },
    get switchedToBackup() {
      return switchedToBackup;
    },
    request,
  };
}
