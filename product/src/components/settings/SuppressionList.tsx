"use client";

import { useActionState, useTransition } from "react";
import { addSuppressionAction, removeSuppressionAction } from "@/app/actions/settings";

const initial = { ok: false, error: null as string | null };

const SOURCE_LABEL: Record<string, string> = {
  bounce: "bounced",
  unsubscribe: "opted out",
  manual: "added by you",
};

export function SuppressionList({ entries }: { entries: { email: string; reason: string; source: string }[] }) {
  const [state, action, pending] = useActionState(addSuppressionAction, initial);
  const [removing, startRemove] = useTransition();

  return (
    <div>
      <form action={action} className="flex gap-2">
        <input name="email" type="email" placeholder="name@company.com" className="input" />
        <button type="submit" className="btn btn-ghost" disabled={pending}>
          Add
        </button>
      </form>
      {state.error && <p className="mt-1 text-sm text-[var(--color-bad)]">{state.error}</p>}

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">No suppressed addresses yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-line)]">
          {entries.map((entry) => (
            <li key={entry.email} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium">{entry.email}</span>
                <span className="ml-2 rounded bg-[var(--color-canvas)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">
                  {SOURCE_LABEL[entry.source] ?? entry.source}
                </span>
              </div>
              {entry.source === "manual" && (
                <button
                  className="text-xs text-[var(--color-muted)] hover:text-[var(--color-bad)]"
                  disabled={removing}
                  onClick={() => startRemove(() => void removeSuppressionAction(entry.email))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
