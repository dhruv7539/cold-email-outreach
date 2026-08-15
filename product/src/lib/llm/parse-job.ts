import { complete, type LlmConfig } from "./provider";
import { JOB_PARSE_SYSTEM_PROMPT } from "./prompts";

export type ParsedJob = {
  company: string;
  companyDomain: string;
  roleTitle: string;
  reqId: string;
  applyUrl: string;
  team: string;
  teamTerms: string[];
  stack: string[];
  seniority: "intern" | "new_grad" | "mid" | "senior" | "staff" | "unknown";
  location: string;
  workArrangement: "remote" | "hybrid" | "onsite" | "unclear";
  companySizeGuess: "startup" | "small" | "mid" | "large" | "unknown";
  requiresCitizenship: boolean;
  requiresClearance: boolean;
  noSponsorship: boolean;
  summary: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    companyDomain: { type: "string", description: "Best-guess primary email domain, e.g. 'stripe.com'. Empty if unknown." },
    roleTitle: { type: "string" },
    reqId: { type: "string" },
    applyUrl: { type: "string" },
    team: { type: "string", description: "Named team/org-unit if stated, else empty." },
    teamTerms: { type: "array", items: { type: "string" }, description: "Distinctive team/tech terms for contact ranking." },
    stack: { type: "array", items: { type: "string" } },
    seniority: { type: "string", enum: ["intern", "new_grad", "mid", "senior", "staff", "unknown"] },
    location: { type: "string" },
    workArrangement: { type: "string", enum: ["remote", "hybrid", "onsite", "unclear"] },
    companySizeGuess: { type: "string", enum: ["startup", "small", "mid", "large", "unknown"] },
    requiresCitizenship: { type: "boolean" },
    requiresClearance: { type: "boolean" },
    noSponsorship: { type: "boolean" },
    summary: { type: "string", description: "One sentence: what the role is." },
  },
  required: ["company", "roleTitle", "stack", "seniority", "requiresCitizenship", "requiresClearance", "noSponsorship"],
} as const;

export async function parseJob(llm: LlmConfig, jobText: string): Promise<ParsedJob> {
  const raw = await complete<Partial<ParsedJob>>(llm, {
    system: JOB_PARSE_SYSTEM_PROMPT,
    prompt: `Extract structured facts from this job posting.\n\n---\n${jobText.slice(0, 20_000)}\n---`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    tier: "cheap",
    temperature: 0,
    maxTokens: 1500,
  });

  return {
    company: raw.company ?? "",
    companyDomain: (raw.companyDomain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    roleTitle: raw.roleTitle ?? "",
    reqId: raw.reqId ?? "",
    applyUrl: raw.applyUrl ?? "",
    team: raw.team ?? "",
    teamTerms: raw.teamTerms ?? [],
    stack: raw.stack ?? [],
    seniority: raw.seniority ?? "unknown",
    location: raw.location ?? "",
    workArrangement: raw.workArrangement ?? "unclear",
    companySizeGuess: raw.companySizeGuess ?? "unknown",
    requiresCitizenship: raw.requiresCitizenship === true,
    requiresClearance: raw.requiresClearance === true,
    noSponsorship: raw.noSponsorship === true,
    summary: raw.summary ?? "",
  };
}
