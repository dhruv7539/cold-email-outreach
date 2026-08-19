// Email verification. Two tiers:
//   1. MillionVerifier (BYOK, paid, precise) when the user supplied a key.
//   2. DNS MX lookup (free, coarse) as the always-available fallback: it proves
//      the domain can receive mail, which filters out typo/dead domains even if
//      it cannot confirm a specific mailbox.
//
// The point is bounce protection: an address we cannot make at least MX-valid is
// never queued, so a guessed local-part that lands on a dead domain never sends.

import { promises as dns } from "node:dns";

const MV_ENDPOINT = "https://api.millionverifier.com/api/v3/";

async function verifyOneMillionVerifier(email, apiKey) {
  const url = `${MV_ENDPOINT}?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MillionVerifier ${res.status}`);
  const json = await res.json();
  // result: "ok" | "catch_all" | "unknown" | "invalid" | "disposable"
  const result = String(json.result ?? "unknown");
  return {
    email,
    provider: "millionverifier",
    result,
    sendable: result === "ok" || result === "catch_all",
    raw: { result, quality: json.quality, subresult: json.subresult },
  };
}

const mxCache = new Map();

async function domainHasMx(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const records = await dns.resolveMx(domain);
    ok = Array.isArray(records) && records.length > 0;
  } catch {
    ok = false;
  }
  mxCache.set(domain, ok);
  return ok;
}

async function verifyOneMx(email) {
  const domain = String(email).split("@")[1]?.toLowerCase();
  if (!domain) return { email, provider: "mx", result: "invalid", sendable: false };
  const hasMx = await domainHasMx(domain);
  return {
    email,
    provider: "mx",
    result: hasMx ? "mx_ok" : "no_mx",
    // MX-valid is "plausible", not "confirmed". Callers treat mx_ok as a weak
    // pass to be used only when no precise verifier is available.
    sendable: hasMx,
    raw: { hasMx },
  };
}

/**
 * @param {string[]} emails
 * @param {{ millionVerifierKey?: string }} options
 * @returns {Promise<Array<{ email: string, provider: string, result: string, sendable: boolean }>>}
 */
export async function verifyEmails(emails, options = {}) {
  const list = [...new Set((emails ?? []).map((e) => String(e).toLowerCase().trim()).filter(Boolean))];
  const key = options.millionVerifierKey;
  const results = [];

  for (const email of list) {
    try {
      results.push(key ? await verifyOneMillionVerifier(email, key) : await verifyOneMx(email));
    } catch {
      // A verifier hiccup falls back to MX so one flaky call does not abort the
      // whole batch.
      results.push(await verifyOneMx(email));
    }
  }

  return results;
}

export function isSendable(result) {
  return Boolean(result && result.sendable);
}

/** A confident "ok" (precise verifier said the mailbox exists). */
export function isConfirmed(result) {
  return Boolean(result && result.provider === "millionverifier" && result.result === "ok");
}
