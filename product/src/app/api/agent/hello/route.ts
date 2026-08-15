import { NextRequest, NextResponse } from "next/server";
import { resolveAgentToken } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Connectivity check for the sheet's "Connect to Hub (test)" menu item. Confirms
// the pairing token is valid without changing any state.
export async function POST(request: NextRequest) {
  const token = bearer(request);
  if (!token) return NextResponse.json({ ok: false, error: "missing token" }, { status: 401 });

  const owner = await resolveAgentToken(token);
  if (!owner) return NextResponse.json({ ok: false, error: "invalid token" }, { status: 401 });

  return NextResponse.json({ ok: true, protocol: 1 });
}

function bearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
