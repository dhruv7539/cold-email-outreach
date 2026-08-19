import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getProfile } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json((await getProfile(user.id)) ?? {});
}
