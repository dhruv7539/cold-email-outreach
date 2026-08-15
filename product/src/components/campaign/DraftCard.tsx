"use client";

import { useState } from "react";
import { saveDraftEditAction, approveDraftAction } from "@/app/actions/campaign";
import type { ContactInfo, DraftInfo } from "./CampaignView";

type Finding = { severity: string; code: string; message: string };

export function DraftCard({
  campaignId,
  draft,
  contact,
  approved,
  onApprovedChange,
}: {
  campaignId: string;
  draft: DraftInfo;
  contact: ContactInfo | undefined;
  approved: boolean;
  onApprovedChange: (value: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [mainHtml, setMainHtml] = useState(draft.mainHtml);
  const [followUpHtml, setFollowUpHtml] = useState(draft.followUp1Html);
  const [findings, setFindings] = useState<Finding[]>(draft.lintFindings ?? []);
  const [errors, setErrors] = useState(draft.lintErrors);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const errorFindings = findings.filter((f) => f.severity === "error");
  const warningFindings = findings.filter((f) => f.severity === "warning");

  async function save() {
    setSaving(true);
    const result = await saveDraftEditAction(draft.id, campaignId, {
      subject,
      main_html: mainHtml,
      follow_up_1_html: followUpHtml,
    });
    setSaving(false);
    if (result.ok) {
      setFindings(result.findings as Finding[]);
      setErrors(result.errors);
      setEditing(false);
      // Editing invalidates a prior approval; the user re-approves the new text.
      if (approved) {
        onApprovedChange(false);
        await approveDraftAction(draft.id, campaignId, false);
      }
    }
  }

  async function toggleApprove() {
    if (errors > 0) return;
    setBusy(true);
    const next = !approved;
    await approveDraftAction(draft.id, campaignId, next);
    onApprovedChange(next);
    setBusy(false);
  }

  return (
    <div className={`card overflow-hidden ${approved ? "ring-2 ring-[var(--color-good)]" : ""}`}>
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-5 py-3">
        <div>
          <p className="font-medium">
            {contact?.name}
            <span className="ml-2 text-xs text-[var(--color-muted)]">{contact?.email}</span>
          </p>
          <p className="text-xs text-[var(--color-muted)]">
            {contact?.contactType.replace(/_/g, " ")} · {draft.repairAttempts} draft attempt
            {draft.repairAttempts === 1 ? "" : "s"}
            {draft.editedByUser && " · edited by you"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {errors > 0 ? (
            <span className="badge bg-red-50 text-[var(--color-bad)]">{errors} to fix</span>
          ) : (
            <span className="badge bg-green-50 text-[var(--color-good)]">passes checks</span>
          )}
        </div>
      </div>

      <div className="p-5">
        {editing ? (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-muted)]">Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input mt-1" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-muted)]">Email (HTML)</span>
              <textarea value={mainHtml} onChange={(e) => setMainHtml(e.target.value)} rows={9} className="input mt-1 font-mono text-xs" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-[var(--color-muted)]">Follow-up (HTML)</span>
              <textarea value={followUpHtml} onChange={(e) => setFollowUpHtml(e.target.value)} rows={6} className="input mt-1 font-mono text-xs" />
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm font-semibold">{subject}</p>
            <div className="mt-2 text-sm text-[var(--color-ink)]" dangerouslySetInnerHTML={{ __html: mainHtml }} />
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Show follow-up</summary>
              <div className="mt-2 text-sm text-[var(--color-muted)]" dangerouslySetInnerHTML={{ __html: followUpHtml }} />
            </details>
          </div>
        )}

        {(errorFindings.length > 0 || warningFindings.length > 0) && !editing && (
          <div className="mt-4 space-y-1 rounded-lg bg-[var(--color-canvas)] p-3 text-xs">
            {errorFindings.map((f, i) => (
              <p key={`e${i}`} className="text-[var(--color-bad)]">
                {f.message}
              </p>
            ))}
            {warningFindings.map((f, i) => (
              <p key={`w${i}`} className="text-[var(--color-warn)]">
                {f.message}
              </p>
            ))}
          </div>
        )}

        {!editing && (
          <div className="mt-4 flex items-center justify-between border-t border-[var(--color-line)] pt-4">
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <label className={`flex items-center gap-2 text-sm ${errors > 0 ? "opacity-50" : "cursor-pointer"}`}>
              <input type="checkbox" checked={approved} onChange={toggleApprove} disabled={errors > 0 || busy} className="h-4 w-4" />
              {approved ? "Approved" : errors > 0 ? "Fix issues to approve" : "Approve this email"}
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
