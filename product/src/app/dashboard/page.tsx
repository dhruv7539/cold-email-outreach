import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getSheetConnection } from "@/lib/repo";
import { listCampaigns } from "@/lib/campaign/repo";
import { getDashboardStats, getRecentReplies } from "@/lib/campaign/stats";
import { Shell } from "@/components/Shell";
import { HealthBanner } from "@/components/dashboard/HealthBanner";
import { StatCard } from "@/components/dashboard/StatCard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  if (!user.onboarded_at) redirect("/onboarding");

  const [stats, campaigns, replies, connection] = await Promise.all([
    getDashboardStats(user.id),
    listCampaigns(user.id),
    getRecentReplies(user.id),
    getSheetConnection(user.id),
  ]);

  const staleSync =
    connection?.last_synced_at && Date.now() - new Date(connection.last_synced_at).getTime() > 30 * 60 * 1000;

  return (
    <Shell email={user.email}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link href="/campaigns/new" className="btn btn-primary">
          New campaign
        </Link>
      </div>

      <div className="mt-6">
        <HealthBanner health={stats.health} />
      </div>

      {staleSync && (
        <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-[var(--color-warn)]">
          Your sheet last synced more than 30 minutes ago. Open it and check the Hub sync trigger is installed.
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Sent" value={stats.sent} />
        <StatCard label="Replies" value={stats.replies} sub={`${stats.replyRatePct}% reply rate`} tone="good" />
        <StatCard
          label="Bounces"
          value={stats.bounces}
          sub={`${stats.bounceRatePct}% bounce rate`}
          tone={stats.health.trailing_bounce_pct > 2 ? "bad" : "muted"}
        />
        <StatCard label="Waiting to send" value={stats.pending} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <section className="card p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold">Campaigns</h2>
          {campaigns.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              No campaigns yet. Paste a job description to start your first one.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--color-line)]">
              {campaigns.map((c) => (
                <li key={c.id}>
                  <Link href={`/campaigns/${c.id}`} className="flex items-center justify-between py-3 hover:opacity-80">
                    <div>
                      <p className="font-medium">
                        {c.company || "Untitled"}
                        {c.role_title && <span className="text-[var(--color-muted)]"> · {c.role_title}</span>}
                      </p>
                      <p className="text-xs text-[var(--color-muted)]">
                        {c.intake_score !== null ? `Score ${c.intake_score}` : "Not scored"} · {c.status}
                        {c.status_detail ? ` · ${c.status_detail}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-muted)]">{new Date(c.created_at).toLocaleDateString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">Recent replies</h2>
          {replies.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">Replies will show up here as they come in.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {replies.map((r, i) => (
                <li key={i} className="text-sm">
                  <p className="font-medium">{r.company}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {r.recipient_email} · {new Date(r.reply_detected_at).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
