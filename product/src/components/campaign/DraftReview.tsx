"use client";

import { useState } from "react";
import { DraftCard } from "./DraftCard";
import type { ContactInfo, DraftInfo } from "./CampaignView";

export function DraftReview({
  campaignId,
  contacts,
  drafts,
  onQueue,
  queueing,
  alreadyQueued,
}: {
  campaignId: string;
  contacts: ContactInfo[];
  drafts: DraftInfo[];
  onQueue: () => void;
  queueing: boolean;
  alreadyQueued: boolean;
}) {
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const [localApproved, setLocalApproved] = useState<Record<string, boolean>>(
    Object.fromEntries(drafts.map((d) => [d.id, d.approved]))
  );

  const approvedCount = Object.values(localApproved).filter(Boolean).length;
  const anyErrors = drafts.some((d) => localApproved[d.id] && d.lintErrors > 0);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Review every email before it sends</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Nothing goes out until you approve it. Read each one, edit anything, then approve. These send from
            your own Gmail.
          </p>
        </div>
        <span className="text-sm text-[var(--color-muted)]">
          {approvedCount} of {drafts.length} approved
        </span>
      </div>

      <div className="space-y-4">
        {drafts.map((draft) => (
          <DraftCard
            key={draft.id}
            campaignId={campaignId}
            draft={draft}
            contact={contactById.get(draft.contactId)}
            approved={localApproved[draft.id] ?? false}
            onApprovedChange={(value) => setLocalApproved((prev) => ({ ...prev, [draft.id]: value }))}
          />
        ))}
      </div>

      <div className="card sticky bottom-4 flex items-center justify-between p-4 shadow-lg">
        <div className="text-sm">
          {alreadyQueued ? (
            <span className="text-[var(--color-good)]">Queued. Your sheet will send these on schedule.</span>
          ) : anyErrors ? (
            <span className="text-[var(--color-bad)]">
              Some approved drafts still have blocking issues. Fix or unapprove them first.
            </span>
          ) : approvedCount === 0 ? (
            <span className="text-[var(--color-muted)]">Approve at least one email to queue it.</span>
          ) : (
            <span>
              {approvedCount} email{approvedCount === 1 ? "" : "s"} ready to hand to your sheet.
            </span>
          )}
        </div>
        <button
          className="btn btn-primary"
          onClick={onQueue}
          disabled={queueing || approvedCount === 0 || anyErrors || alreadyQueued}
        >
          {queueing ? "Queueing..." : alreadyQueued ? "Queued" : `Queue ${approvedCount} email${approvedCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </section>
  );
}
