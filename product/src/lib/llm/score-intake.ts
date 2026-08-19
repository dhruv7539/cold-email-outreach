import type { ParsedJob } from "./parse-job";

// Deterministic fit scoring. No LLM: the rubric is transparent and stable so the
// same job always scores the same, and the user sees exactly why. Replaces the
// judgment the Cursor agent used to apply by eye.

export type ProfileForScoring = {
  primaryStack: string[];
  secondaryStack: string[];
  isRecentGraduate: boolean;
  openToRelocation: boolean;
  openToRemote: boolean;
  requiresSponsorship: boolean;
};

export type IntakeVerdict = "full" | "light" | "skip";

export type IntakeScore = {
  total: number;
  verdict: IntakeVerdict;
  rationale: string;
  breakdown: { label: string; points: number; max: number; note: string }[];
};

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b.map((s) => s.toLowerCase()));
  return a.filter((s) => set.has(s.toLowerCase()));
}

export function scoreIntake(job: ParsedJob, profile: ProfileForScoring): IntakeScore {
  const breakdown: IntakeScore["breakdown"] = [];

  // Stack overlap (40): primary matches count double.
  const primaryHits = overlap(job.stack, profile.primaryStack);
  const secondaryHits = overlap(job.stack, profile.secondaryStack);
  const stackRaw = primaryHits.length * 2 + secondaryHits.length;
  const stackPoints = Math.min(40, stackRaw * 8);
  breakdown.push({
    label: "Stack overlap",
    points: stackPoints,
    max: 40,
    note: primaryHits.length || secondaryHits.length
      ? `Matches: ${[...primaryHits, ...secondaryHits].join(", ")}`
      : "No overlap with the posted stack",
  });

  // Seniority fit (20): best for new grads / early roles given the candidate.
  const seniorityPoints = (() => {
    if (job.seniority === "new_grad" || job.seniority === "intern") return profile.isRecentGraduate ? 20 : 10;
    if (job.seniority === "mid") return 14;
    if (job.seniority === "senior") return profile.isRecentGraduate ? 6 : 12;
    if (job.seniority === "staff") return profile.isRecentGraduate ? 2 : 8;
    return 10;
  })();
  breakdown.push({ label: "Seniority fit", points: seniorityPoints, max: 20, note: `Role seniority: ${job.seniority}` });

  // Work arrangement / location (20).
  const locationPoints = (() => {
    if (job.workArrangement === "remote") return profile.openToRemote ? 20 : 8;
    if (job.workArrangement === "hybrid" || job.workArrangement === "onsite") return profile.openToRelocation ? 16 : 8;
    return 12;
  })();
  breakdown.push({ label: "Location / arrangement", points: locationPoints, max: 20, note: job.workArrangement });

  // Company signal (10): a named team is a stronger targeting surface.
  const companyPoints = job.team || job.teamTerms.length ? 10 : 5;
  breakdown.push({ label: "Targeting signal", points: companyPoints, max: 10, note: job.team ? `Team: ${job.team}` : "No distinctive team named" });

  // Sponsorship friction (10): a no-sponsorship job the candidate needs sponsored for is a hard problem.
  const sponsorshipPoints = job.noSponsorship && profile.requiresSponsorship ? 0 : 10;
  breakdown.push({
    label: "Sponsorship",
    points: sponsorshipPoints,
    max: 10,
    note: sponsorshipPoints === 0 ? "Employer states no sponsorship" : "No sponsorship blocker",
  });

  const total = breakdown.reduce((sum, b) => sum + b.points, 0);
  const verdict: IntakeVerdict = total >= 65 ? "full" : total >= 40 ? "light" : "skip";

  const rationale = (() => {
    if (verdict === "full") return `Strong fit (${total}/100). ${breakdown[0].note}.`;
    if (verdict === "light") return `Partial fit (${total}/100). Worth a lighter, honest touch. ${breakdown[0].note}.`;
    return `Weak fit (${total}/100). ${sponsorshipPoints === 0 ? "Sponsorship is a blocker. " : ""}${breakdown[0].note}.`;
  })();

  return { total, verdict, rationale, breakdown };
}
