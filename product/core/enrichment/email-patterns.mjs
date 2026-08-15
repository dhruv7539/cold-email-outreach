// Email pattern inference for the candidate-and-verify address strategy.
//
// Apollo's free tier gives names + company but not addresses. Rather than spend
// an enrichment credit per person, we generate the handful of address formats
// companies actually use, plus common nickname variants, and let verification
// (verify.mjs) decide which one is real. One credit is spent per company at most
// (to learn/confirm a format); the rest are inferred for free.

const NICKNAMES = {
  alexander: ["alex"], alexandra: ["alex"], andrew: ["andy", "drew"],
  anthony: ["tony"], benjamin: ["ben"], catherine: ["cathy", "kate"],
  charles: ["charlie", "chuck"], christopher: ["chris"], daniel: ["dan", "danny"],
  david: ["dave"], edward: ["ed", "eddie"], elizabeth: ["liz", "beth"],
  gregory: ["greg"], jacob: ["jake"], james: ["jim", "jimmy"],
  jennifer: ["jen", "jenny"], jonathan: ["jon", "john"], joseph: ["joe"],
  joshua: ["josh"], katherine: ["kate", "katie"], kenneth: ["ken"],
  matthew: ["matt"], michael: ["mike"], nicholas: ["nick"], patricia: ["pat"],
  rebecca: ["becky"], richard: ["rich", "rick", "dick"], robert: ["rob", "bob"],
  samuel: ["sam"], stephen: ["steve"], steven: ["steve"], theodore: ["ted", "theo"],
  thomas: ["tom", "tommy"], timothy: ["tim"], william: ["will", "bill", "billy"],
  zachary: ["zach"],
};

export function normalizeNamePart(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

export function splitName(input) {
  if (input.firstName || input.lastName) {
    return {
      first: normalizeNamePart(input.firstName),
      last: normalizeNamePart(input.lastName),
    };
  }
  const parts = String(input.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: normalizeNamePart(parts[0] ?? ""), last: "" };
  return { first: normalizeNamePart(parts[0]), last: normalizeNamePart(parts[parts.length - 1]) };
}

/** First-name variants: the formal name plus known familiar forms. */
export function nameVariants(first) {
  const set = new Set([first]);
  if (NICKNAMES[first]) NICKNAMES[first].forEach((n) => set.add(n));
  // Reverse: if given a nickname, the formal name is also worth trying.
  for (const [formal, nicks] of Object.entries(NICKNAMES)) {
    if (nicks.includes(first)) set.add(formal);
  }
  return [...set].filter(Boolean);
}

// The address formats companies actually use, in rough order of prevalence,
// including a few fixed-width corporate truncations.
export const PATTERNS = [
  "first.last", "firstlast", "flast", "first", "first_last",
  "f.last", "firstl", "lastf", "last.first", "last",
  "f2last6", "flast7", "last8", "first4last4", "last6f2",
];

export function applyPattern({ first, last }, pattern) {
  const f = first;
  const l = last;
  if (!f) return "";
  switch (pattern) {
    case "first.last": return l ? `${f}.${l}` : f;
    case "firstlast": return `${f}${l}`;
    case "flast": return l ? `${f[0]}${l}` : f;
    case "first": return f;
    case "first_last": return l ? `${f}_${l}` : f;
    case "f.last": return l ? `${f[0]}.${l}` : f;
    case "firstl": return l ? `${f}${l[0]}` : f;
    case "lastf": return l ? `${l}${f[0]}` : f;
    case "last.first": return l ? `${l}.${f}` : f;
    case "last": return l || f;
    case "f2last6": return l ? `${f.slice(0, 2)}${l.slice(0, 6)}` : f;
    case "flast7": return l ? `${f[0]}${l.slice(0, 7)}` : f;
    case "last8": return (l || f).slice(0, 8);
    case "first4last4": return l ? `${f.slice(0, 4)}${l.slice(0, 4)}` : f;
    case "last6f2": return l ? `${l.slice(0, 6)}${f.slice(0, 2)}` : f;
    default: return "";
  }
}

/** Which pattern (+ variant) produces `localPart` for this name, if any. */
export function inferPattern({ first, last }, localPart) {
  // Keep separators (. _ -) so dotted formats like "jane.doe" are matched
  // against "first.last" rather than being stripped to "janedoe" (which would
  // spuriously match "firstlast"). Everything else is lowercased/removed.
  const target = String(localPart ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z._-]/g, "");
  if (!target) return null;
  for (const variant of nameVariants(first)) {
    for (const pattern of PATTERNS) {
      if (applyPattern({ first: variant, last }, pattern) === target) {
        return { pattern, variant: variant === first ? undefined : variant };
      }
    }
  }
  return null;
}

/**
 * All candidate addresses for a person at a domain, most-likely first, deduped.
 * @returns {string[]}
 */
export function candidateEmails(input) {
  const { first, last } = splitName(input);
  const domain = String(input.domain ?? "").toLowerCase().replace(/^@/, "").trim();
  if (!first || !domain) return [];

  const seen = new Set();
  const out = [];
  const preferred = input.pattern ? [input.pattern, ...PATTERNS] : PATTERNS;

  for (const variant of nameVariants(first)) {
    for (const pattern of preferred) {
      const local = applyPattern({ first: variant, last }, pattern);
      if (!local) continue;
      const email = `${local}@${domain}`;
      if (!seen.has(email)) {
        seen.add(email);
        out.push(email);
      }
    }
  }
  return out;
}

/**
 * Learn a domain's dominant format from known verified addresses.
 * @param {{ email: string, name?: string, firstName?: string, lastName?: string }[]} known
 * @returns {{ pattern: string, variant?: string, confidence: number, samples: number } | null}
 */
export function learnDomainPattern(known) {
  const counts = new Map();
  let samples = 0;

  for (const entry of known ?? []) {
    const local = String(entry.email ?? "").split("@")[0];
    if (!local) continue;
    const { first, last } = splitName(entry);
    const inferred = inferPattern({ first, last }, local);
    if (!inferred) continue;
    samples += 1;
    const key = inferred.variant ? `${inferred.pattern}|${inferred.variant}` : inferred.pattern;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  if (!samples) return null;
  const [topKey, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [pattern, variant] = topKey.split("|");
  return { pattern, variant: variant || undefined, confidence: topCount / samples, samples };
}
