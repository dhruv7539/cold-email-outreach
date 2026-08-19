import { getCredentials } from "@/lib/repo";
import type { LlmConfig, Provider } from "./provider";

/** Resolves the signed-in user's own model credentials into an LlmConfig. */
export async function getLlmConfigForUser(userId: string): Promise<LlmConfig | null> {
  const creds = await getCredentials(userId);
  if (!creds.llmApiKey || !creds.llmProvider) return null;
  return { provider: creds.llmProvider as Provider, apiKey: creds.llmApiKey };
}

export class MissingCredentialError extends Error {
  constructor(readonly what: "llm" | "apollo") {
    super(what === "llm" ? "No AI key is configured." : "No Apollo key is configured.");
    this.name = "MissingCredentialError";
  }
}
