import type { DashboardStats } from "@/lib/campaign/stats";

export function HealthBanner({ health }: { health: DashboardStats["health"] }) {
  if (health.status === "ok") {
    return (
      <div className="rounded-lg border border-[var(--color-line)] bg-white p-4 text-sm">
        <span className="badge bg-green-50 text-[var(--color-good)]">Healthy</span>
        <span className="ml-3 text-[var(--color-muted)]">
          Your sending reputation looks good. Bounce rate {health.trailing_bounce_pct}% over the last{" "}
          {health.trailing_bounce_window} sends.
        </span>
      </div>
    );
  }

  const isAlert = health.status === "alert";

  return (
    <div className={`rounded-lg p-4 ${isAlert ? "bg-red-50" : "bg-amber-50"}`}>
      <div className="flex items-start gap-3">
        <span className={`badge ${isAlert ? "bg-red-100 text-[var(--color-bad)]" : "bg-amber-100 text-[var(--color-warn)]"}`}>
          {isAlert ? "Sending paused" : "Warning"}
        </span>
        <div className="text-sm">
          {[...health.alerts, ...health.warnings].map((message, i) => (
            <p key={i} className={isAlert ? "text-[var(--color-bad)]" : "text-[var(--color-warn)]"}>
              {message}
            </p>
          ))}
          {isAlert && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              New campaigns cannot be queued until the trailing bounce rate drops back under 2%. This protects
              your ability to reach inboxes at all.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
