"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discoverAction, draftAction, queueAction } from "@/app/actions/campaign";
import { IntakeCard } from "./IntakeCard";
import { ContactList } from "./ContactList";
import { DraftReview } from "./DraftReview";

type Finding = { severity: string; code: string; message: string };

export type CampaignInfo = {
  id: string;
  company: string;
  roleTitle: string;
  reqId: string;
  applyUrl: string;
  intakeScore: number | null;
  intakeVerdict: string | null;
  intakeRationale: string;
  status: string;
  statusDetail: string;
  parsedJob: Record<string, unknown>;
};

export type ContactInfo = {
  id: string;
  name: string;
  title: string;
  contactType: string;
  email: string | null;
  emailSource: string | null;
  linkedinUrl: string | null;
};

export type DraftInfo = {
  id: string;
  contactId: string;
  subject: string;
  mainHtml: string;
  followUp1Html: string;
  lintFindings: Finding[];
  lintErrors: number;
  repairAttempts: number;
  approved: boolean;
  editedByUser: boolean;
};

export function CampaignView({
  campaign,
  contacts,
  drafts,
}: {
  campaign: CampaignInfo;
  contacts: ContactInfo[];
  drafts: DraftInfo[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    setBusy(label);
    startTransition(async () => {
      const result = await fn();
      setBusy(null);
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      else router.refresh();
    });
  };

  const blocked = campaign.intakeVerdict === "skip" && campaign.status === "blocked";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {campaign.company || "New campaign"}
            {campaign.roleTitle && <span className="text-[var(--color-muted)]"> · {campaign.roleTitle}</span>}
          </h1>
          {campaign.reqId && <p className="text-sm text-[var(--color-muted)]">Requisition {campaign.reqId}</p>}
        </div>
        <StatusBadge status={campaign.status} detail={campaign.statusDetail} />
      </div>

      {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-[var(--color-bad)]">{error}</div>}

      <IntakeCard campaign={campaign} />

      {blocked ? (
        <div className="card p-6">
          <p className="text-sm">
            This role is not a fit to pursue: {campaign.intakeRationale} You can start a different campaign
            anytime.
          </p>
        </div>
      ) : (
        <>
          <section className="card p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Contacts</h2>
                <p className="text-sm text-[var(--color-muted)]">
                  People we found at {campaign.company || "this company"}, with verified addresses.
                </p>
              </div>
              {contacts.length === 0 && (
                <button className="btn btn-primary" disabled={pending} onClick={() => run("discover", () => discoverAction(campaign.id))}>
                  {busy === "discover" ? "Finding people..." : "Find contacts"}
                </button>
              )}
            </div>

            {contacts.length > 0 && (
              <div className="mt-4">
                <ContactList contacts={contacts} campaignId={campaign.id} />
                {drafts.length === 0 && (
                  <div className="mt-4 flex items-center justify-between border-t border-[var(--color-line)] pt-4">
                    <p className="text-sm text-[var(--color-muted)]">
                      Ready to write. Each email is researched and drafted individually, then you review them.
                    </p>
                    <button className="btn btn-primary" disabled={pending} onClick={() => run("draft", () => draftAction(campaign.id))}>
                      {busy === "draft" ? "Writing emails..." : "Draft emails"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {drafts.length > 0 && (
            <DraftReview
              campaignId={campaign.id}
              contacts={contacts}
              drafts={drafts}
              onQueue={() => run("queue", () => queueAction(campaign.id))}
              queueing={busy === "queue"}
              alreadyQueued={campaign.status === "queued"}
            />
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status, detail }: { status: string; detail: string }) {
  const map: Record<string, string> = {
    queued: "bg-green-50 text-[var(--color-good)]",
    review: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
    blocked: "bg-red-50 text-[var(--color-bad)]",
  };
  return (
    <div className="text-right">
      <span className={`badge ${map[status] ?? "bg-[var(--color-canvas)] text-[var(--color-muted)]"}`}>{status}</span>
      {detail && <p className="mt-1 text-xs text-[var(--color-muted)]">{detail}</p>}
    </div>
  );
}
