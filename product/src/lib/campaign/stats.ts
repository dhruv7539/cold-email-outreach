import { query } from "@/lib/db";
import { getSendHistory } from "@/lib/repo";
import { computeHealth } from "@core/health/compute-health.mjs";

export type DashboardStats = {
  sent: number;
  replies: number;
  bounces: number;
  pending: number;
  replyRatePct: number;
  bounceRatePct: number;
  health: {
    status: "ok" | "warning" | "alert";
    alerts: string[];
    warnings: string[];
    trailing_bounce_pct: number;
    trailing_bounce_window: number;
    trailing_reply_pct: number;
    trailing_reply_window: number;
  };
};

export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const [totals, history] = await Promise.all([
    query<{ status: string; count: string }>(
      "SELECT status, count(*)::text AS count FROM queue_items WHERE user_id = $1 GROUP BY status",
      [userId]
    ),
    getSendHistory(userId),
  ]);

  const byStatus = new Map(totals.map((r) => [r.status, Number(r.count)]));
  const sent = history.length;
  const replies = history.filter((h) => h.status === "replied" || h.reply_detected_at).length;
  const bounces = history.filter((h) => h.status === "bounced").length;
  const pending = byStatus.get("queued") ?? 0;

  const health = computeHealth(
    history.map((h) => ({ status: h.status, main_sent_at: h.main_sent_at, reply_detected_at: h.reply_detected_at }))
  );

  return {
    sent,
    replies,
    bounces,
    pending,
    replyRatePct: sent ? Number(((replies / sent) * 100).toFixed(1)) : 0,
    bounceRatePct: sent ? Number(((bounces / sent) * 100).toFixed(1)) : 0,
    health,
  };
}

export async function getRecentReplies(userId: string, limit = 10) {
  return query<{ recipient_email: string; reply_detected_at: Date; campaign_id: string; company: string }>(
    `SELECT q.recipient_email, q.reply_detected_at, q.campaign_id, c.company
     FROM queue_items q JOIN campaigns c ON c.id = q.campaign_id
     WHERE q.user_id = $1 AND q.reply_detected_at IS NOT NULL
     ORDER BY q.reply_detected_at DESC LIMIT $2`,
    [userId, limit]
  );
}
