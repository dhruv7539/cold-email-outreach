"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { addToBlacklist } from "@/lib/repo";
import { query } from "@/lib/db";

export async function addSuppressionAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  await addToBlacklist(user.id, email, "added manually", "manual");
  revalidatePath("/settings");
  return { ok: true, error: null };
}

export async function removeSuppressionAction(email: string) {
  const user = await requireUser();
  // Only manual entries can be removed; bounces and opt-outs stay suppressed,
  // because re-emailing a bounced or opted-out address is exactly what damages
  // deliverability and trust.
  await query("DELETE FROM blacklist WHERE user_id = $1 AND email = $2 AND source = 'manual'", [user.id, email]);
  revalidatePath("/settings");
  return { ok: true };
}
