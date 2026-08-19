// Apollo.io REST client, ported from scripts/apollo-rest-search-people.mjs and
// scripts/apollo-rest-enrich-person.mjs. Every function takes the API key as a
// parameter (BYOK) instead of reading process.env, and there is no disk cache
// (the product caches learned addresses in Postgres instead).
//
// Cost discipline is the whole point: searchPeople is FREE (masked results, no
// email addresses), and enrichPeople is the paid last resort used only when
// candidate-and-verify cannot resolve an address (see enrichment/resolve.mjs).

const SEARCH_ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/api_search";
const MATCH_ENDPOINT = "https://api.apollo.io/api/v1/people/match";
const BULK_ENDPOINT = "https://api.apollo.io/api/v1/people/bulk_match";
const MAX_PER_PAGE = 100;
const BULK_BATCH_SIZE = 10;

async function apolloFetch(endpoint, body, apiKey) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function normalizeSearchPerson(p) {
  return {
    id: p.id,
    firstName: p.first_name ?? "",
    lastNameObfuscated: p.last_name_obfuscated ?? "",
    lastName: p.last_name ?? "",
    name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
    title: p.title ?? "",
    headline: p.headline ?? "",
    hasEmail: p.has_email === true,
    organizationName: p.organization?.name ?? null,
    organizationDomain: p.organization?.primary_domain ?? p.organization?.website_url ?? null,
    city: p.city ?? "",
    state: p.state ?? "",
    linkedinUrl: p.linkedin_url ?? null,
  };
}

/**
 * Free people search. Returns masked candidates (no email addresses).
 * @param {string} apiKey
 * @param {{ domains?: string[], titles?: string[], locations?: string[], keywords?: string, seniorities?: string[] }} filters
 * @param {{ limit?: number, maxPages?: number, includeUnverified?: boolean }} options
 */
export async function searchPeople(apiKey, filters = {}, options = {}) {
  if (!apiKey) throw new Error("Apollo API key is required.");

  const baseBody = {};
  if (filters.domains?.length) baseBody.q_organization_domains_list = filters.domains;
  if (filters.titles?.length) baseBody.person_titles = filters.titles;
  if (filters.locations?.length) baseBody.person_locations = filters.locations;
  if (filters.seniorities?.length) baseBody.person_seniorities = filters.seniorities;
  if (filters.keywords) baseBody.q_keywords = filters.keywords;
  if (!options.includeUnverified) baseBody.contact_email_status = ["verified"];

  const target = Math.max(1, Math.floor(Number(options.limit ?? 25)));
  const perPage = Math.min(target, MAX_PER_PAGE);
  const maxPages = Number(options.maxPages ?? 4);

  const collected = [];
  let page = 1;
  while (true) {
    const json = await apolloFetch(SEARCH_ENDPOINT, { ...baseBody, per_page: perPage, page }, apiKey);
    const people = (json.people ?? []).map(normalizeSearchPerson);
    for (const p of people) {
      if (p.hasEmail) collected.push(p);
    }
    if (collected.length >= target) break;
    if (people.length < perPage) break;
    if (page >= maxPages) break;
    page += 1;
  }

  return collected.slice(0, target);
}

function normalizeEnrichPerson(person) {
  if (!person) return null;
  return {
    id: person.id,
    name: person.name ?? "",
    title: person.title ?? "",
    email: person.email ?? null,
    emailStatus: person.email_status ?? null,
    linkedinUrl: person.linkedin_url ?? null,
    city: person.city ?? "",
    state: person.state ?? "",
    country: person.country ?? "",
    organizationName: person.organization?.name ?? person.organization_name ?? null,
    headline: person.headline ?? "",
  };
}

/**
 * Paid enrichment. Unmasks verified email + details for the given people.
 * @param {string} apiKey
 * @param {{ id: string }[]} people
 * @returns {Promise<Map<string, object>>} apollo id -> enriched person
 */
export async function enrichPeople(apiKey, people) {
  if (!apiKey) throw new Error("Apollo API key is required.");
  const ids = (people ?? []).map((p) => p.id).filter(Boolean);
  const out = new Map();

  for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
    const batch = ids.slice(i, i + BULK_BATCH_SIZE);
    const json = await apolloFetch(BULK_ENDPOINT, { details: batch.map((id) => ({ id })) }, apiKey);
    for (const match of json.matches ?? []) {
      const normalized = normalizeEnrichPerson(match);
      if (normalized?.id) out.set(normalized.id, normalized);
    }
  }

  return out;
}

/** Cheap validity probe used at key-entry time. One tiny search. */
export async function validateApiKey(apiKey) {
  if (!apiKey) return { valid: false, error: "No key provided." };
  try {
    await apolloFetch(SEARCH_ENDPOINT, { per_page: 1, page: 1 }, apiKey);
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/40[13]/.test(message)) return { valid: false, error: "Apollo rejected this key." };
    return { valid: false, error: message };
  }
}
