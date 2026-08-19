// The tenant profile: everything the drafting pipeline needs to know about a
// user. Replaces the three per-install files the CLI used (outreach.config.json,
// master_data.md, COLD_EMAIL_PROOF_BANK.md) with one validated object stored per
// user.
//
// Nothing here is defaulted to the original author's details. Values that used to
// be hardcoded (Los Angeles, USC, "recent M.S. CS graduate") are fields.

import { z } from "zod";

export const ProofSchema = z.object({
  id: z.string().min(1),
  // Verifiable artifacts (a merged PR, a published paper) outperform
  // self-reported metrics, which recruiters discount. The linter warns when a
  // campaign leads with none.
  kind: z.enum(["metric", "artifact"]),
  text: z.string().min(10).max(400),
  roleTypes: z.array(z.string()).default([]),
  url: z.string().url().optional().or(z.literal("")),
});

export const ExperienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  start: z.string().optional(),
  end: z.string().optional(),
  bullets: z.array(z.string()).default([]),
  stack: z.array(z.string()).default([]),
});

export const ProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  url: z.string().url().optional().or(z.literal("")),
  stack: z.array(z.string()).default([]),
});

export const ProfileSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  fullName: z.string().min(1, "Full name is required"),
  email: z.string().email("A valid email address is required"),

  university: z.string().default(""),
  degree: z.string().default(""),
  gradDate: z.string().default(""),
  isRecentGraduate: z.boolean().default(false),

  github: z.string().default(""),
  linkedin: z.string().default(""),
  portfolio: z.string().default(""),

  locationCity: z.string().default(""),
  locationState: z.string().default(""),
  timezone: z.string().default("America/New_York"),
  openToRelocation: z.boolean().default(true),
  openToRemote: z.boolean().default(true),

  // Drives the hard eligibility stop: a job requiring citizenship or a clearance
  // is refused outright rather than drafted for.
  workAuthorization: z
    .enum(["citizen", "permanent_resident", "visa_holder", "needs_sponsorship"])
    .default("needs_sponsorship"),
  requiresSponsorship: z.boolean().default(true),

  primaryStack: z.array(z.string()).default([]),
  secondaryStack: z.array(z.string()).default([]),
  stackPositioning: z.string().default(""),

  experience: z.array(ExperienceSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  proofs: z.array(ProofSchema).default([]),
});

export const CredentialsSchema = z.object({
  apolloApiKey: z.string().optional(),
  llmProvider: z.enum(["anthropic", "openai", "gemini"]).optional(),
  llmApiKey: z.string().optional(),
  millionVerifierApiKey: z.string().optional(),
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Hard stop before any drafting work. The candidate cannot legally hold these
 * roles, so scoring them wastes the user's tokens and their time.
 */
export function checkEligibility(profile, parsedJob) {
  const blockers = [];
  if (parsedJob.requiresCitizenship && profile.workAuthorization !== "citizen") {
    blockers.push("This role requires U.S. citizenship.");
  }
  if (parsedJob.requiresClearance && profile.workAuthorization !== "citizen") {
    blockers.push("This role requires an active security clearance, which requires citizenship.");
  }
  if (parsedJob.noSponsorship && profile.requiresSponsorship) {
    blockers.push("This employer states it does not sponsor visas, and you need sponsorship.");
  }
  return { eligible: blockers.length === 0, blockers };
}

/** Signature is the only string shared across a campaign's emails. */
export function signatureHtml(profile) {
  return `<p>Thanks,<br>\n${escapeHtml(profile.firstName)}</p>`;
}

/** Compact profile for prompts. Full objects would waste the user's tokens. */
export function profileForPrompt(profile) {
  return {
    name: profile.fullName,
    firstName: profile.firstName,
    education: [profile.degree, profile.university, profile.gradDate].filter(Boolean).join(", "),
    isRecentGraduate: profile.isRecentGraduate,
    location: [profile.locationCity, profile.locationState].filter(Boolean).join(", "),
    openToRelocation: profile.openToRelocation,
    openToRemote: profile.openToRemote,
    needsSponsorship: profile.requiresSponsorship,
    primaryStack: profile.primaryStack,
    secondaryStack: profile.secondaryStack,
    stackPositioning: profile.stackPositioning,
    experience: (profile.experience ?? []).map((e) => ({
      company: e.company,
      title: e.title,
      bullets: (e.bullets ?? []).slice(0, 4),
      stack: e.stack,
    })),
    projects: (profile.projects ?? []).map((p) => ({ name: p.name, description: p.description, stack: p.stack })),
    proofs: (profile.proofs ?? []).map((p) => ({ id: p.id, kind: p.kind, text: p.text, roleTypes: p.roleTypes })),
  };
}

export { escapeHtml };

export const EMPTY_PROFILE = {
  firstName: "", fullName: "", email: "", university: "", degree: "", gradDate: "",
  isRecentGraduate: false, github: "", linkedin: "", portfolio: "",
  locationCity: "", locationState: "", timezone: "America/New_York",
  openToRelocation: true, openToRemote: true, workAuthorization: "needs_sponsorship",
  requiresSponsorship: true, primaryStack: [], secondaryStack: [], stackPositioning: "",
  experience: [], projects: [], proofs: [],
};
