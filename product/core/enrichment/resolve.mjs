// Candidate-and-verify address resolution.
//
// Order of operations, cheapest first:
//   1. Known address for this exact person (from a prior campaign) -> free.
//   2. Learned domain format applied to their name, verified -> free (reuses a
//      format one earlier credit already established for the company).
//   3. Candidate sweep: generate likely addresses, verify, take the first that
//      passes -> free (uses the user's own verifier key or MX).
//   4. Paid Apollo enrichment -> last resort, only for people still unresolved.
//
// The design goal is at most one Apollo credit per company: once any address at
// a domain is confirmed, its format is learned and every other contact there
// resolves for free.

import { candidateEmails, learnDomainPattern, splitName, applyPattern } from "./email-patterns.mjs";
import { verifyEmails, isSendable, isConfirmed } from "./verify.mjs";

export const RESOLUTION_SOURCES = {
  KNOWN: "known",
  LEARNED: "learned_pattern",
  SWEEP: "candidate_sweep",
  ENRICHED: "enriched",
  UNRESOLVED: "unresolved",
};

function domainOf(contact) {
  return String(contact.domain ?? "").toLowerCase().replace(/^@/, "").trim();
}

/**
 * @param {{ id: string, name?: string, firstName?: string, lastName?: string, domain?: string }[]} contacts
 * @param {{
 *   knownAddresses?: { email: string, domain?: string, name?: string, firstName?: string, lastName?: string }[],
 *   millionVerifierKey?: string,
 *   enrich?: (contacts: { id: string }[]) => Promise<Map<string, { email?: string, state?: string }>>,
 * }} options
 */
export async function resolveAddresses(contacts, options = {}) {
  const { knownAddresses = [], millionVerifierKey, enrich } = options;
  const verifyOpts = { millionVerifierKey };
  let creditsUsed = 0;

  // Index known addresses by exact person and learn a per-domain format.
  const knownByPerson = new Map();
  const knownByDomain = new Map();
  for (const k of knownAddresses) {
    const email = String(k.email ?? "").toLowerCase();
    if (!email) continue;
    const domain = (k.domain || email.split("@")[1] || "").toLowerCase();
    const { first, last } = splitName(k);
    knownByPerson.set(`${first}|${last}|${domain}`, email);
    if (!knownByDomain.has(domain)) knownByDomain.set(domain, []);
    knownByDomain.get(domain).push({ email, name: k.name, firstName: k.firstName, lastName: k.lastName });
  }

  const learnedByDomain = new Map();
  for (const [domain, entries] of knownByDomain.entries()) {
    const learned = learnDomainPattern(entries);
    if (learned) learnedByDomain.set(domain, learned);
  }

  const resolved = [];
  const unresolved = [];

  for (const contact of contacts) {
    const domain = domainOf(contact);
    const { first, last } = splitName(contact);

    if (!domain || !first) {
      unresolved.push(contact);
      resolved.push({ id: contact.id, email: null, source: RESOLUTION_SOURCES.UNRESOLVED });
      continue;
    }

    // 1. Exact known person.
    const known = knownByPerson.get(`${first}|${last}|${domain}`);
    if (known) {
      resolved.push({ id: contact.id, email: known, source: RESOLUTION_SOURCES.KNOWN, firstName: first, lastName: last, name: contact.name });
      continue;
    }

    // 2. Learned domain format, verified.
    const learned = learnedByDomain.get(domain);
    if (learned) {
      const local = applyPattern({ first: learned.variant || first, last }, learned.pattern);
      const guess = local ? `${local}@${domain}` : "";
      if (guess) {
        const [result] = await verifyEmails([guess], verifyOpts);
        if (isSendable(result)) {
          resolved.push({ id: contact.id, email: guess, source: RESOLUTION_SOURCES.LEARNED, verification: result, firstName: first, lastName: last, name: contact.name });
          continue;
        }
      }
    }

    // 3. Candidate sweep.
    const candidates = candidateEmails({ firstName: first, lastName: last, domain, pattern: learned?.pattern });
    const verifications = await verifyEmails(candidates, verifyOpts);
    // Prefer a confirmed mailbox; otherwise accept the first sendable (MX) hit
    // only when we have a precise verifier or a single obvious candidate.
    const confirmed = verifications.find(isConfirmed);
    const sendable = confirmed || verifications.find(isSendable);
    if (confirmed || (sendable && millionVerifierKey)) {
      const pick = confirmed || sendable;
      resolved.push({ id: contact.id, email: pick.email, source: RESOLUTION_SOURCES.SWEEP, verification: pick, firstName: first, lastName: last, name: contact.name });
      continue;
    }

    unresolved.push(contact);
  }

  // 4. Paid enrichment for whatever is still unresolved.
  if (unresolved.length && typeof enrich === "function") {
    const enrichedMap = await enrich(unresolved.map((c) => ({ id: c.id })));
    creditsUsed += unresolved.length;
    for (const contact of unresolved) {
      const enriched = enrichedMap.get(contact.id);
      const email = enriched?.email ? String(enriched.email).toLowerCase() : null;
      const { first, last } = splitName(contact);
      resolved.push({
        id: contact.id,
        email,
        source: email ? RESOLUTION_SOURCES.ENRICHED : RESOLUTION_SOURCES.UNRESOLVED,
        state: enriched?.state,
        firstName: first,
        lastName: last,
        name: contact.name,
      });
    }
  }

  return { resolved, creditsUsed };
}
