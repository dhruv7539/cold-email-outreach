"use client";

import { useActionState } from "react";
import { requestMagicLinkAction } from "@/app/actions/auth";

const initial = { ok: false, error: null as string | null, devLink: null as string | null };

export function SignInForm() {
  const [state, action, pending] = useActionState(requestMagicLinkAction, initial);

  if (state.ok) {
    return (
      <div className="rounded-lg bg-[var(--color-accent-soft)] p-4 text-sm">
        <p className="font-medium">Check your email.</p>
        <p className="mt-1 text-[var(--color-muted)]">
          We sent a sign-in link. It works once and expires in 20 minutes.
        </p>
        {state.devLink && (
          <p className="mt-3 break-all rounded bg-white p-2 text-xs">
            Dev mode, no mail provider configured. Link:{" "}
            <a className="text-[var(--color-accent)] underline" href={state.devLink}>
              {state.devLink}
            </a>
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" required placeholder="you@example.com" className="input" autoComplete="email" />
      {state.error && <p className="text-sm text-[var(--color-bad)]">{state.error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Sending..." : "Email me a sign-in link"}
      </button>
    </form>
  );
}
