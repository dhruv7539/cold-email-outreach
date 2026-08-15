"use client";

import { useActionState } from "react";
import { saveKeysAction } from "@/app/actions/onboarding";

const initial = { ok: false, errors: [] as string[] };

export function KeysStep({
  keyStatus,
  onDone,
}: {
  keyStatus: { llmProvider: string | null; llmKey: string; apolloKey: string; verifierKey: string };
  onDone?: () => void;
}) {
  const [state, action, pending] = useActionState(async (prev: typeof initial, formData: FormData) => {
    const result = await saveKeysAction(prev, formData);
    if (result.ok) onDone?.();
    return result;
  }, initial);

  return (
    <form action={action} className="card space-y-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">Your API keys</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          These stay yours. They are encrypted before we store them, used only to run your own campaigns, and
          never shared. You can change or remove them anytime in Settings.
        </p>
      </div>

      <label className="block">
        <span className="text-sm font-medium">AI provider</span>
        <select name="llmProvider" defaultValue={keyStatus.llmProvider ?? "gemini"} className="input mt-1">
          <option value="gemini">Google Gemini (has a free tier)</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium">AI key</span>
        <input
          name="llmApiKey"
          type="password"
          className="input mt-1"
          placeholder={keyStatus.llmKey || "Paste your model provider key"}
          autoComplete="off"
        />
        <span className="mt-1 block text-xs text-[var(--color-muted)]">
          Gemini keys are free at aistudio.google.com. This is what writes and researches your emails.
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Apollo key</span>
        <input
          name="apolloApiKey"
          type="password"
          className="input mt-1"
          placeholder={keyStatus.apolloKey || "Paste your Apollo API key"}
          autoComplete="off"
        />
        <span className="mt-1 block text-xs text-[var(--color-muted)]">
          Apollo finds the right people at each company. A free account works; we spend at most one credit per
          new company.
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          MillionVerifier key <span className="text-[var(--color-muted)]">(optional)</span>
        </span>
        <input
          name="millionVerifierApiKey"
          type="password"
          className="input mt-1"
          placeholder={keyStatus.verifierKey || "Optional, improves address accuracy"}
          autoComplete="off"
        />
        <span className="mt-1 block text-xs text-[var(--color-muted)]">
          Without this we still verify addresses by mail server, just less precisely.
        </span>
      </label>

      {state.errors.length > 0 && (
        <ul className="rounded-lg bg-red-50 p-3 text-sm text-[var(--color-bad)]">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Checking keys..." : "Save and continue"}
        </button>
      </div>
    </form>
  );
}
