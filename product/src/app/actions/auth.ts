"use server";

import { redirect } from "next/navigation";
import { createLoginToken, signOut } from "@/lib/auth";
import { sendMagicLink } from "@/lib/email";

type MagicLinkState = { ok: boolean; error: string | null; devLink: string | null };

export async function requestMagicLinkAction(_prev: MagicLinkState, formData: FormData): Promise<MagicLinkState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address.", devLink: null };
  }

  const { token } = await createLoginToken(email);
  const link = `${appUrl()}/auth/verify?token=${encodeURIComponent(token)}`;
  const delivery = await sendMagicLink(email, link);

  // In local development with no mail provider configured, the link is returned
  // so the developer can click through without an inbox.
  return { ok: true, error: null, devLink: delivery.delivered ? null : link };
}

export async function signOutAction() {
  await signOut();
  redirect("/");
}

function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}
