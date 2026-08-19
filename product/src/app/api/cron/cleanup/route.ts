import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily housekeeping, invoked by the Vercel cron in vercel.json. Deletes expired
// magic-link tokens and sessions so those tables do not grow without bound.
//
// Vercel signs cron requests with a bearer token equal to CRON_SECRET; we reject
// anything that does not present it, so the endpoint is not publicly runnable.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization") ?? "";
    if (header !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const [tokens, sessions] = await Promise.all([
    query<{ count: string }>(
      "WITH d AS (DELETE FROM login_tokens WHERE expires_at < now() RETURNING 1) SELECT count(*)::text AS count FROM d"
    ),
    query<{ count: string }>(
      "WITH d AS (DELETE FROM sessions WHERE expires_at < now() RETURNING 1) SELECT count(*)::text AS count FROM d"
    ),
  ]);

  return NextResponse.json({
    ok: true,
    deletedLoginTokens: Number(tokens[0]?.count ?? 0),
    deletedSessions: Number(sessions[0]?.count ?? 0),
  });
}
