export function StatCard({
  label,
  value,
  sub,
  tone = "muted",
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "good" | "bad" | "muted";
}) {
  const toneClass =
    tone === "good" ? "text-[var(--color-good)]" : tone === "bad" ? "text-[var(--color-bad)]" : "text-[var(--color-muted)]";

  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value.toLocaleString()}</p>
      {sub && <p className={`mt-0.5 text-xs ${toneClass}`}>{sub}</p>}
    </div>
  );
}
