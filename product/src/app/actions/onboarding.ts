"use server";

import { requireUser } from "@/lib/auth";
import {
  getCredentials,
  saveCredentials,
  getProfile,
  saveProfile,
  createAgentToken,
  getSheetConnection,
  revokeAgentTokens,
} from "@/lib/repo";
import { generateToken, maskKey } from "@/lib/crypto";
import { resumeTextFromUpload } from "@/lib/pdf";
import { extractProfileFromResume } from "@/lib/llm/extract-profile";
import { validateLlmKey, type Provider } from "@/lib/llm/provider";
import { validateApiKey as validateApolloKey } from "@core/apollo/client.mjs";
import { EMPTY_PROFILE, ProfileSchema } from "@core/profile/schema.mjs";

// --- Step 1: keys ----------------------------------------------------------

export async function saveKeysAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();

  const provider = String(formData.get("llmProvider") ?? "") as Provider;
  const llmKey = String(formData.get("llmApiKey") ?? "").trim();
  const apolloKey = String(formData.get("apolloApiKey") ?? "").trim();
  const verifierKey = String(formData.get("millionVerifierApiKey") ?? "").trim();

  const errors: string[] = [];

  // Validate against the live APIs so a wrong key is caught here, not three steps
  // later in the middle of a campaign.
  if (llmKey) {
    const check = await validateLlmKey({ provider, apiKey: llmKey });
    if (!check.valid) errors.push(`AI key: ${check.error}`);
  }
  if (apolloKey) {
    const check = await validateApolloKey(apolloKey);
    if (!check.valid) errors.push(`Apollo key: ${check.error}`);
  }

  if (errors.length) return { ok: false, errors };

  await saveCredentials(user.id, {
    llmProvider: provider,
    llmApiKey: llmKey || undefined,
    apolloApiKey: apolloKey || undefined,
    millionVerifierApiKey: verifierKey || undefined,
  });

  return { ok: true, errors: [] };
}

// --- Step 2: resume -> profile draft ---------------------------------------

export async function extractResumeAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const creds = await getCredentials(user.id);

  if (!creds.llmApiKey || !creds.llmProvider) {
    return { ok: false, error: "Add your AI key first, then upload your resume." };
  }

  let resumeText = String(formData.get("resumeText") ?? "").trim();
  const file = formData.get("resume") as File | null;

  if (!resumeText && file && file.size > 0) {
    const extracted = await resumeTextFromUpload(file);
    if (extracted.needsPaste) {
      return { ok: false, error: "That looks like a scanned or image-only PDF. Paste your resume text into the box instead." };
    }
    resumeText = extracted.text;
  }

  if (!resumeText) {
    return { ok: false, error: "Upload a resume PDF or paste your resume text." };
  }

  try {
    const extracted = await extractProfileFromResume(
      { provider: creds.llmProvider as Provider, apiKey: creds.llmApiKey },
      resumeText
    );
    // Merge onto the current profile so a re-run does not wipe manual edits to
    // fields the resume does not mention.
    const current = (await getProfile(user.id)) ?? { ...EMPTY_PROFILE, email: user.email };
    await saveProfile(user.id, { ...current, ...extracted });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not read that resume." };
  }
}

export async function saveProfileAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const current = ((await getProfile(user.id)) ?? { ...EMPTY_PROFILE, email: user.email }) as Record<string, unknown>;

  const payload = {
    ...current,
    firstName: str(formData, "firstName"),
    fullName: str(formData, "fullName"),
    email: str(formData, "email") || user.email,
    university: str(formData, "university"),
    degree: str(formData, "degree"),
    gradDate: str(formData, "gradDate"),
    isRecentGraduate: formData.get("isRecentGraduate") === "on",
    locationCity: str(formData, "locationCity"),
    locationState: str(formData, "locationState"),
    timezone: str(formData, "timezone") || "America/New_York",
    openToRelocation: formData.get("openToRelocation") === "on",
    openToRemote: formData.get("openToRemote") === "on",
    workAuthorization: str(formData, "workAuthorization") || "needs_sponsorship",
    requiresSponsorship: formData.get("requiresSponsorship") === "on",
    primaryStack: list(formData, "primaryStack"),
    secondaryStack: list(formData, "secondaryStack"),
    stackPositioning: str(formData, "stackPositioning"),
    proofs: parseProofs(formData),
  };

  const parsed = ProfileSchema.safeParse(payload);
  if (!parsed.success) {
    const message = parsed.error?.issues.map((i) => i.message).join("; ") ?? "Please check the required fields.";
    return { ok: false, error: message };
  }

  await saveProfile(user.id, parsed.data);
  return { ok: true, error: null };
}

// --- Step 3: pairing token -------------------------------------------------

export async function createPairingTokenAction() {
  const user = await requireUser();
  // One live token per sheet; replacing it revokes the old one so a lost token
  // stops working.
  await revokeAgentTokens(user.id);
  const token = generateToken();
  await createAgentToken(user.id, token, "sheet");
  return { token };
}

export async function checkConnectionAction() {
  const user = await requireUser();
  const connection = await getSheetConnection(user.id);
  return {
    connected: Boolean(connection?.last_synced_at),
    lastSyncedAt: connection?.last_synced_at?.toISOString() ?? null,
    senderEmail: connection?.sender_email ?? null,
  };
}

export async function getKeyStatusAction() {
  const user = await requireUser();
  const creds = await getCredentials(user.id);
  return {
    llmProvider: creds.llmProvider,
    llmKey: maskKey(creds.llmApiKey),
    apolloKey: maskKey(creds.apolloApiKey),
    verifierKey: maskKey(creds.millionVerifierApiKey),
  };
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function list(formData: FormData, key: string): string[] {
  return str(formData, key).split(",").map((s) => s.trim()).filter(Boolean);
}

function parseProofs(formData: FormData) {
  const raw = str(formData, "proofsJson");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop placeholder rows the user added but never filled in, so an empty
    // proof does not trip the min-length validation.
    return parsed.filter((p) => p && typeof p.text === "string" && p.text.trim().length > 0);
  } catch {
    return [];
  }
}
