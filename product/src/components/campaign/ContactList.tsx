"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeContactAction } from "@/app/actions/campaign";
import type { ContactInfo } from "./CampaignView";

const SOURCE_LABEL: Record<string, string> = {
  known: "known address",
  learned_pattern: "company format",
  candidate_sweep: "verified guess",
  enriched: "Apollo lookup",
};

export function ContactList({ contacts, campaignId }: { contacts: ContactInfo[]; campaignId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {contacts.map((contact) => (
        <li key={contact.id} className="flex items-center justify-between py-3">
          <div>
            <p className="font-medium">
              {contact.name}
              <span className="ml-2 text-xs text-[var(--color-muted)]">{contact.contactType.replace(/_/g, " ")}</span>
            </p>
            <p className="text-sm text-[var(--color-muted)]">{contact.title}</p>
            <p className="text-xs text-[var(--color-muted)]">
              {contact.email}
              {contact.emailSource && (
                <span className="ml-2 rounded bg-[var(--color-canvas)] px-1.5 py-0.5">
                  {SOURCE_LABEL[contact.emailSource] ?? contact.emailSource}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {contact.linkedinUrl && (
              <a href={contact.linkedinUrl} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-accent)] underline">
                LinkedIn
              </a>
            )}
            <button
              className="text-xs text-[var(--color-muted)] hover:text-[var(--color-bad)]"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (contact.email) await removeContactAction(contact.email, campaignId);
                  router.refresh();
                })
              }
            >
              Remove
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
