import { NextRequest, NextResponse } from "next/server";
import {
  resolveAgentToken,
  applyEvents,
  recordSync,
  claimPendingRows,
  markOnboarded,
  type AgentEvent,
} from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The heart of the pull-bridge. The user's sheet POSTs here every minute:
//   1. Authenticates with its pairing token.
//   2. Reports local events (sends, replies, bounces) since its last cursor.
//   3. Receives pending approved rows to append, plus any dynamic settings.
//
// No Google credential is involved on this side; the sheet does all Gmail work
// under the user's own authorization.

export async function POST(request: NextRequest) {
  const token = bearer(request);
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const owner = await resolveAgentToken(token);
  if (!owner) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  let body: { events?: AgentEvent[]; sender_email?: string; protocol?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  const applied = await applyEvents(owner.userId, events);
  await recordSync(token, body.sender_email ?? "");

  // The first successful sync completes onboarding.
  await markOnboarded(owner.userId);

  const rows = await claimPendingRows(owner.userId, 50);

  return NextResponse.json({
    protocol: 1,
    applied,
    rows: rows.map((r) => r.row),
    // Settings the hub can push down to keep pacing consistent. Blank values in
    // the sheet fall back to its own Settings tab.
    settings: {},
  });
}

function bearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
