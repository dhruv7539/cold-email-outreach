import type { ParsedJob } from "./parse-job";

// Deterministic contact selection. Encodes the AGENTS.md sizing + priority rules:
// hiring-influence first (recruiters, hiring managers, eng leaders), same-team
// match is priority #1, peer SWEs capped hard. No LLM: the ordering must be
// explainable and stable.

export type Candidate = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  title: string;
  headline: string;
  organizationDomain?: string | null;
  linkedinUrl?: string | null;
  city?: string;
  state?: string;
  contactType?: string;
};

export type ScoredCandidate = Candidate & {
  contactType: string;
  score: number;
  teamMatch: boolean;
  reasons: string[];
};

const RECRUITER = /\b(recruit|talent|sourcer|talent acquisition|ta partner)\b/i;
const HIRING_MANAGER = /\b(manager|director|head of|vp|lead|principal)\b/i;
const ENGINEER = /\b(engineer|developer|swe|sde|programmer)\b/i;
const FOUNDER = /\b(founder|co-?founder|ceo|cto)\b/i;

function classifyType(title: string): string {
  if (FOUNDER.test(title)) return "founder";
  if (RECRUITER.test(title)) return "recruiter";
  if (HIRING_MANAGER.test(title) && ENGINEER.test(title)) return "hiring_manager";
  if (HIRING_MANAGER.test(title)) return "hiring_manager";
  if (ENGINEER.test(title)) return "software_engineer";
  return "hr";
}

function teamMatches(candidate: Candidate, job: ParsedJob): boolean {
  if (!job.teamTerms.length && !job.team) return false;
  const hay = `${candidate.title} ${candidate.headline}`.toLowerCase();
  const terms = [job.team, ...job.teamTerms].filter(Boolean).map((t) => t.toLowerCase());
  return terms.some((term) => term && hay.includes(term));
}

export function selectContacts(
  candidates: Candidate[],
  job: ParsedJob,
  options: { min: number; max: number; companyIsSmall?: boolean }
): { selected: ScoredCandidate[]; considered: number } {
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const contactType = c.contactType || classifyType(c.title);
    const teamMatch = teamMatches(c, job);
    const reasons: string[] = [];
    let score = 0;

    // Priority #1: same-team match.
    if (teamMatch) {
      score += 50;
      reasons.push("on-team");
    }

    // Hiring influence ranks above peers.
    if (contactType === "recruiter") { score += 30; reasons.push("recruiter"); }
    else if (contactType === "hiring_manager") { score += 28; reasons.push("hiring manager"); }
    else if (contactType === "founder") { score += 26; reasons.push("founder"); }
    else if (contactType === "software_engineer") { score += 8; reasons.push("peer engineer"); }
    else { score += 4; reasons.push("HR"); }

    // University/early-career recruiters help new grads specifically.
    if (contactType === "recruiter" && /\b(university|campus|early career|new grad)\b/i.test(c.title) && job.seniority === "new_grad") {
      score += 10;
      reasons.push("university recruiter");
    }

    return { ...c, contactType, teamMatch, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  // Enforce the peer-SWE hard cap (0-3) and prefer hiring-influence contacts.
  const peerCap = 3;
  const selected: ScoredCandidate[] = [];
  let peers = 0;

  for (const candidate of scored) {
    if (selected.length >= options.max) break;
    if (candidate.contactType === "software_engineer") {
      if (peers >= peerCap) continue;
      // Only keep a peer when they are on-team (the exception bar).
      if (!candidate.teamMatch) continue;
      peers += 1;
    }
    selected.push(candidate);
  }

  // If we could not reach the minimum with the strict rules, backfill with the
  // next best hiring-influence contacts (never generic peers).
  if (selected.length < options.min) {
    for (const candidate of scored) {
      if (selected.length >= options.min) break;
      if (selected.includes(candidate)) continue;
      if (candidate.contactType === "software_engineer") continue;
      selected.push(candidate);
    }
  }

  return { selected, considered: candidates.length };
}
