"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { startCampaignAction } from "@/app/actions/campaign";

const initial = { ok: false, error: null as string | null, campaignId: undefined as string | undefined };

export function NewCampaignForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState(startCampaignAction, initial);

  useEffect(() => {
    if (state.ok && state.campaignId) router.push(`/campaigns/${state.campaignId}`);
  }, [state, router]);

  return (
    <form action={action} className="card space-y-4 p-6">
      <textarea
        name="jobText"
        rows={16}
        required
        className="input font-mono text-xs"
        placeholder="Paste the entire job posting here, including the requirements and any note about visa sponsorship or citizenship."
      />
      {state.error && <p className="text-sm text-[var(--color-bad)]">{state.error}</p>}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-muted)]">
          We read the paste as-is. Roles requiring citizenship or a clearance are refused automatically.
        </p>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Scoring..." : "Score this job"}
        </button>
      </div>
    </form>
  );
}
