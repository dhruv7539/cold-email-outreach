import { complete, type LlmConfig } from "./provider";
import { BRIEF_SYSTEM_PROMPT } from "./prompts";
import type { ScoredCandidate } from "./select-contacts";
import type { ParsedJob } from "./parse-job";

// A tight, factual brief per contact using the cheap tier. This is the research
// step that gives the drafter a concrete hook, or honestly reports there isn't
// one so the draft falls back to role/team relevance instead of a fake specific.

export type ContactBrief = {
  contactId: string;
  hook: string;
  hookConfidence: "high" | "medium" | "none";
  teamRelevance: string;
  suggestedAngle: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "A specific, true fact about this person to open on. Empty if none is known." },
    hookConfidence: { type: "string", enum: ["high", "medium", "none"] },
    teamRelevance: { type: "string", description: "How this person relates to the target team/req." },
    suggestedAngle: { type: "string", description: "One sentence: the angle the email should take." },
  },
  required: ["hook", "hookConfidence", "teamRelevance", "suggestedAngle"],
} as const;

async function writeOne(llm: LlmConfig, contact: ScoredCandidate, job: ParsedJob): Promise<ContactBrief> {
  const facts = [
    `Name: ${contact.name}`,
    `Title: ${contact.title}`,
    contact.headline ? `Headline: ${contact.headline}` : "",
    `Contact type: ${contact.contactType}`,
    contact.teamMatch ? "Appears to be on the target team." : "",
    `Target role: ${job.roleTitle} at ${job.company}${job.team ? ` (${job.team})` : ""}`,
  ].filter(Boolean).join("\n");

  try {
    const raw = await complete<Partial<ContactBrief>>(llm, {
      system: BRIEF_SYSTEM_PROMPT,
      prompt: `Write a brief for this contact. Only use the facts given.\n\n${facts}`,
      schema: SCHEMA as unknown as Record<string, unknown>,
      tier: "cheap",
      temperature: 0.2,
      maxTokens: 500,
    });
    return {
      contactId: contact.id,
      hook: raw.hook ?? "",
      hookConfidence: raw.hookConfidence ?? "none",
      teamRelevance: raw.teamRelevance ?? "",
      suggestedAngle: raw.suggestedAngle ?? "",
    };
  } catch {
    // A brief failure should not sink the whole campaign; fall back to a
    // role/team brief the drafter can still use.
    return {
      contactId: contact.id,
      hook: "",
      hookConfidence: "none",
      teamRelevance: contact.teamMatch ? "On or near the target team." : `${contact.contactType} at ${job.company}.`,
      suggestedAngle: "Lead with honest role/team relevance and one concrete proof.",
    };
  }
}

/** Briefs for all contacts, run with bounded concurrency. */
export async function writeBriefs(
  llm: LlmConfig,
  contacts: ScoredCandidate[],
  job: ParsedJob
): Promise<Map<string, ContactBrief>> {
  const out = new Map<string, ContactBrief>();
  const CONCURRENCY = 4;

  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    const batch = contacts.slice(i, i + CONCURRENCY);
    const briefs = await Promise.all(batch.map((c) => writeOne(llm, c, job)));
    for (const brief of briefs) out.set(brief.contactId, brief);
  }

  return out;
}
