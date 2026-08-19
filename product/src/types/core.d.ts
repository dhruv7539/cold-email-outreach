// The core/ library is plain ESM JavaScript shared verbatim with the CLI, so it
// has no TypeScript types. These ambient declarations give the app loose but
// usable signatures without duplicating logic or coupling the build to the JS.
// The real contracts live in the .mjs modules and are exercised by the node
// validation scripts.

declare module "@core/apollo/client.mjs" {
  export function searchPeople(apiKey: string, filters: unknown, options?: unknown): Promise<any[]>;
  export function enrichPeople(apiKey: string, people: unknown[]): Promise<Map<string, any>>;
  export function validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;
}

declare module "@core/enrichment/resolve.mjs" {
  export const RESOLUTION_SOURCES: Record<string, string>;
  export function resolveAddresses(
    contacts: unknown[],
    options: unknown
  ): Promise<{ resolved: any[]; creditsUsed: number }>;
}

declare module "@core/enrichment/verify.mjs" {
  export function verifyEmails(emails: string[], options?: unknown): Promise<any[]>;
  export function isSendable(result: unknown): boolean;
  export function isConfirmed(result: unknown): boolean;
}

declare module "@core/enrichment/email-patterns.mjs" {
  export function candidateEmails(input: unknown): string[];
  export function inferPattern(name: unknown, localPart: string): { pattern: string; variant?: string } | null;
  export function applyPattern(name: unknown, pattern: string): string;
  export function learnDomainPattern(known: unknown[]): { pattern: string; variant?: string; confidence: number; samples: number } | null;
}

declare module "@core/linter/review-spec.mjs" {
  export type LintReview = {
    ok: boolean;
    results: { key?: string; findings: any[] }[];
    specFindings: any[];
    summary: { errors: number; warnings: number };
  };
  export function reviewSpec(spec: unknown): LintReview;
  export function reviewSingleDraft(draft: unknown): { findings: any[] };
  export function flattenFindings(review: unknown): any[];
  export function summarize(results: unknown[], specFindings?: unknown[]): { errors: number; warnings: number };
}

declare module "@core/linter/product-rules.mjs" {
  import type { LintReview } from "@core/linter/review-spec.mjs";
  export function reviewDraftProductRules(draft: unknown): any[];
  export function applyProductRules(review: unknown, drafts: unknown[]): LintReview;
}

declare module "@core/linter/cta-classifier.mjs" {
  export function stripHtmlToText(html: string): string;
  export function classifyCta(text: string): { type: string; question: string };
  export function evaluateExplicitAsk(text: string): { candidacyAnchor: boolean; ctaType: string; ctaQuestion: string; pass: boolean };
}

declare module "@core/health/compute-health.mjs" {
  export function computeHealth(events: unknown[]): {
    status: "ok" | "warning" | "alert";
    alerts: string[];
    warnings: string[];
    trailing_bounce_pct: number;
    trailing_bounce_window: number;
    trailing_reply_pct: number;
    trailing_reply_window: number;
  };
  export function blocksSending(health: unknown): boolean;
}

declare module "@core/queue/build-rows.mjs" {
  export const QUEUE_HEADERS: string[];
  export function buildQueueRows(
    spec: unknown,
    options: unknown
  ): { rows: { job_id: string; recipient_email: string; [key: string]: unknown }[]; headers: string[] };
}

declare module "@core/scheduling/timezone-map.mjs" {
  export const DEFAULT_TIMEZONE: string;
  export function resolveTimezoneFromState(state: unknown): string | null;
}

declare module "@core/replies/classify.mjs" {
  export function classifyReply(text: string): {
    classification: string;
    confidence: number;
    reasons: string[];
    actsAsUnsubscribe: boolean;
  };
  export function shouldStopSequence(classification: string): boolean;
}

declare module "@core/profile/schema.mjs" {
  export const ProfileSchema: {
    safeParse(input: unknown): { success: boolean; data?: any; error?: { issues: { message: string }[] } };
  };
  export const CredentialsSchema: unknown;
  export const EMPTY_PROFILE: Record<string, unknown>;
  export function checkEligibility(profile: unknown, job: unknown): { eligible: boolean; blockers: string[] };
  export function signatureHtml(profile: unknown): string;
  export function profileForPrompt(profile: unknown): Record<string, unknown>;
  export function escapeHtml(value: unknown): string;
}
