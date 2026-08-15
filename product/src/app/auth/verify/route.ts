import { NextRequest, NextResponse } from "next/server";
import { redeemLoginToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const base = process.env.APP_URL ?? request.nextUrl.origin;

  if (!token) {
    return NextResponse.redirect(new URL("/?error=missing_token", base));
  }

  const user = await redeemLoginToken(token);
  if (!user) {
    return NextResponse.redirect(new URL("/?error=expired", base));
  }

  // Onboarded users go to the dashboard; everyone else starts the setup flow.
  return NextResponse.redirect(new URL(user.onboarded_at ? "/dashboard" : "/onboarding", base));
}
