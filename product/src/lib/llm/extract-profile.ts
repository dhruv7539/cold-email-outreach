import { complete, type LlmConfig } from "./provider";

// Turns a resume into the structured profile the drafting pipeline needs. This
// replaces the manual interview the CLI ran to produce master_data.md and
// COLD_EMAIL_PROOF_BANK.md by hand.
//
// The user always edits the result before it is used, so the goal is a good
// first draft, not perfection. The one hard rule is honesty: extract only what
// the resume actually says, because an invented proof becomes a false claim in a
// real email.

const EXTRACT_SYSTEM = `You convert a resume into structured data for a job-search tool. Extract only
what the document states. Never invent an achievement, a metric, a technology, or
a date. If a field is not present, leave it empty.

For the proof bank, prefer concrete, checkable accomplishments: a shipped
project, a measurable result, a contribution someone could verify. Mark each as
either a metric (a number the person reports) or an artifact (something external
that can be checked, like a published paper or a public repository).`;

const SCHEMA = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    fullName: { type: "string" },
    email: { type: "string" },
    university: { type: "string" },
    degree: { type: "string" },
    gradDate: { type: "string" },
    isRecentGraduate: { type: "boolean" },
    github: { type: "string" },
    linkedin: { type: "string" },
    portfolio: { type: "string" },
    locationCity: { type: "string" },
    locationState: { type: "string" },
    primaryStack: { type: "array", items: { type: "string" } },
    secondaryStack: { type: "array", items: { type: "string" } },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          stack: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title"],
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          url: { type: "string" },
          stack: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    },
    proofs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["metric", "artifact"] },
          text: { type: "string" },
          roleTypes: { type: "array", items: { type: "string" } },
          url: { type: "string" },
        },
        required: ["id", "kind", "text"],
      },
    },
  },
  required: ["firstName", "fullName", "primaryStack", "experience", "proofs"],
} as const;

export type ExtractedProfile = {
  firstName: string;
  fullName: string;
  email: string;
  university: string;
  degree: string;
  gradDate: string;
  isRecentGraduate: boolean;
  github: string;
  linkedin: string;
  portfolio: string;
  locationCity: string;
  locationState: string;
  primaryStack: string[];
  secondaryStack: string[];
  experience: { company: string; title: string; start?: string; end?: string; bullets: string[]; stack: string[] }[];
  projects: { name: string; description: string; url?: string; stack: string[] }[];
  proofs: { id: string; kind: "metric" | "artifact"; text: string; roleTypes: string[]; url?: string }[];
};

export async function extractProfileFromResume(llm: LlmConfig, resumeText: string): Promise<ExtractedProfile> {
  const result = await complete<Partial<ExtractedProfile>>(llm, {
    system: EXTRACT_SYSTEM,
    prompt: `Extract the structured profile from this resume.\n\n---\n${resumeText.slice(0, 30_000)}\n---`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    tier: "cheap",
    temperature: 0,
    maxTokens: 4000,
  });

  return {
    firstName: result.firstName ?? "",
    fullName: result.fullName ?? "",
    email: result.email ?? "",
    university: result.university ?? "",
    degree: result.degree ?? "",
    gradDate: result.gradDate ?? "",
    isRecentGraduate: result.isRecentGraduate === true,
    github: result.github ?? "",
    linkedin: result.linkedin ?? "",
    portfolio: result.portfolio ?? "",
    locationCity: result.locationCity ?? "",
    locationState: result.locationState ?? "",
    primaryStack: result.primaryStack ?? [],
    secondaryStack: result.secondaryStack ?? [],
    experience: (result.experience ?? []).map((e) => ({
      company: e.company ?? "",
      title: e.title ?? "",
      start: e.start,
      end: e.end,
      bullets: e.bullets ?? [],
      stack: e.stack ?? [],
    })),
    projects: (result.projects ?? []).map((p) => ({
      name: p.name ?? "",
      description: p.description ?? "",
      url: p.url,
      stack: p.stack ?? [],
    })),
    proofs: (result.proofs ?? []).map((p, i) => ({
      id: p.id ?? `proof-${i + 1}`,
      kind: p.kind === "artifact" ? "artifact" : "metric",
      text: p.text ?? "",
      roleTypes: p.roleTypes ?? [],
      url: p.url,
    })),
  };
}
