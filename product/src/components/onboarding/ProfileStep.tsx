"use client";

import { useState } from "react";
import { extractResumeAction, saveProfileAction } from "@/app/actions/onboarding";

type Proof = { id: string; kind: "metric" | "artifact"; text: string; roleTypes: string[] };

export function ProfileStep({
  initialProfile,
  onDone,
  onBack,
}: {
  initialProfile: Record<string, unknown> | null;
  onDone: () => void;
  onBack: () => void;
}) {
  const [profile, setProfile] = useState<Record<string, unknown>>(initialProfile ?? {});
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteMode, setPasteMode] = useState(false);

  const proofs = (profile.proofs as Proof[] | undefined) ?? [];

  async function handleExtract(formData: FormData) {
    setExtracting(true);
    setError(null);
    const result = await extractResumeAction(null, formData);
    setExtracting(false);
    if (!result.ok) {
      setError(result.error ?? "Could not read that resume.");
      if (result.error?.includes("paste")) setPasteMode(true);
      return;
    }
    const res = await fetch("/api/profile", { cache: "no-store" });
    if (res.ok) setProfile(await res.json());
  }

  async function handleSave(formData: FormData) {
    setSaving(true);
    setError(null);
    formData.set("proofsJson", JSON.stringify(proofs));
    const result = await saveProfileAction(null, formData);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "Please check the required fields.");
      return;
    }
    onDone();
  }

  const value = (key: string) => String(profile[key] ?? "");
  const checked = (key: string) => Boolean(profile[key]);
  const listValue = (key: string) => ((profile[key] as string[] | undefined) ?? []).join(", ");

  return (
    <div className="space-y-6">
      <form action={handleExtract} className="card space-y-4 p-6">
        <div>
          <h2 className="text-lg font-semibold">Start from your resume</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Upload it and we will fill in the form below. You review and fix everything before it is used, so a
            rough first pass is fine.
          </p>
        </div>

        {!pasteMode ? (
          <input type="file" name="resume" accept=".pdf,.txt,.md" className="input" />
        ) : (
          <textarea name="resumeText" rows={8} className="input font-mono text-xs" placeholder="Paste your resume text here" />
        )}

        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-ghost" disabled={extracting}>
            {extracting ? "Reading..." : "Read my resume"}
          </button>
          <button type="button" className="text-sm text-[var(--color-accent)] underline" onClick={() => setPasteMode((v) => !v)}>
            {pasteMode ? "Upload a file instead" : "Paste text instead"}
          </button>
        </div>
      </form>

      <form action={handleSave} className="card space-y-5 p-6">
        <h2 className="text-lg font-semibold">Confirm your details</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="firstName" label="First name" defaultValue={value("firstName")} required />
          <Field name="fullName" label="Full name" defaultValue={value("fullName")} required />
          <Field name="email" label="Contact email" defaultValue={value("email")} />
          <Field name="degree" label="Degree" defaultValue={value("degree")} />
          <Field name="university" label="University" defaultValue={value("university")} />
          <Field name="gradDate" label="Graduation" defaultValue={value("gradDate")} />
          <Field name="locationCity" label="City" defaultValue={value("locationCity")} />
          <Field name="locationState" label="State" defaultValue={value("locationState")} />
        </div>

        <Field name="primaryStack" label="Your strongest technologies (comma separated)" defaultValue={listValue("primaryStack")} />
        <Field name="secondaryStack" label="Also familiar with (comma separated)" defaultValue={listValue("secondaryStack")} />
        <Field
          name="stackPositioning"
          label="How you describe your overlap in one line"
          defaultValue={value("stackPositioning")}
          placeholder="My strongest overlap is REST, SQL, and production web work."
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle name="isRecentGraduate" label="Recent graduate" defaultChecked={checked("isRecentGraduate")} />
          <Toggle name="openToRelocation" label="Open to relocation" defaultChecked={checked("openToRelocation")} />
          <Toggle name="openToRemote" label="Open to remote" defaultChecked={checked("openToRemote")} />
          <Toggle name="requiresSponsorship" label="I need visa sponsorship" defaultChecked={checked("requiresSponsorship")} />
        </div>

        <label className="block">
          <span className="text-sm font-medium">Work authorization</span>
          <select name="workAuthorization" defaultValue={value("workAuthorization") || "needs_sponsorship"} className="input mt-1">
            <option value="citizen">U.S. citizen</option>
            <option value="permanent_resident">Permanent resident</option>
            <option value="visa_holder">Visa holder</option>
            <option value="needs_sponsorship">Need sponsorship</option>
          </select>
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            Used to skip roles that require citizenship or a clearance you cannot hold.
          </span>
        </label>

        <input type="hidden" name="timezone" defaultValue={value("timezone") || "America/New_York"} />

        <ProofEditor proofs={proofs} onChange={(next) => setProfile((p) => ({ ...p, proofs: next }))} />

        {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

        <div className="flex justify-between">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save and continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  name,
  label,
  defaultValue,
  required,
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input name={name} defaultValue={defaultValue} required={required} placeholder={placeholder} className="input mt-1" />
    </label>
  );
}

function Toggle({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-4 w-4" />
      {label}
    </label>
  );
}

function ProofEditor({ proofs, onChange }: { proofs: Proof[]; onChange: (next: Proof[]) => void }) {
  function update(index: number, patch: Partial<Proof>) {
    onChange(proofs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Proof bank</span>
        <button
          type="button"
          className="text-sm text-[var(--color-accent)] underline"
          onClick={() => onChange([...proofs, { id: `proof-${proofs.length + 1}`, kind: "metric", text: "", roleTypes: [] }])}
        >
          Add a proof
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Each email leads with one of these. Concrete, checkable achievements work best.
      </p>

      <div className="mt-3 space-y-3">
        {proofs.map((proof, i) => (
          <div key={i} className="rounded-lg border border-[var(--color-line)] p-3">
            <div className="flex gap-2">
              <select value={proof.kind} onChange={(e) => update(i, { kind: e.target.value as Proof["kind"] })} className="input max-w-[9rem]">
                <option value="metric">Metric</option>
                <option value="artifact">Artifact</option>
              </select>
              <input
                value={proof.roleTypes.join(", ")}
                onChange={(e) => update(i, { roleTypes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder="fits: backend, data"
                className="input"
              />
              <button type="button" className="btn btn-ghost px-3" onClick={() => onChange(proofs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <textarea
              value={proof.text}
              onChange={(e) => update(i, { text: e.target.value })}
              rows={2}
              placeholder="Cut p95 latency on the billing API from 840ms to 310ms."
              className="input mt-2"
            />
          </div>
        ))}
        {proofs.length === 0 && (
          <p className="rounded-lg bg-[var(--color-canvas)] p-3 text-sm text-[var(--color-muted)]">
            No proofs yet. Add at least one so your emails have something concrete to lead with.
          </p>
        )}
      </div>
    </div>
  );
}
