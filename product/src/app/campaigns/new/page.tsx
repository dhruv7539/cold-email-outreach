import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCredentials, getProfile } from "@/lib/repo";
import { Shell } from "@/components/Shell";
import { NewCampaignForm } from "@/components/campaign/NewCampaignForm";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const [creds, profile] = await Promise.all([getCredentials(user.id), getProfile(user.id)]);
  const missing: string[] = [];
  if (!creds.llmApiKey) missing.push("an AI key");
  if (!creds.apolloApiKey) missing.push("an Apollo key");
  if (!profile) missing.push("your profile");

  return (
    <Shell email={user.email}>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold">New campaign</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Paste the full job description. We will score the fit, find the right people, and draft an email to
          each one for you to review.
        </p>

        {missing.length > 0 ? (
          <div className="card mt-6 p-6">
            <p className="text-sm">
              Before you start, you still need to add {missing.join(" and ")}.{" "}
              <a href="/settings" className="text-[var(--color-accent)] underline">
                Go to Settings
              </a>
              .
            </p>
          </div>
        ) : (
          <div className="mt-6">
            <NewCampaignForm />
          </div>
        )}
      </div>
    </Shell>
  );
}
