import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getProfile, getCredentials, getSheetConnection } from "@/lib/repo";
import { maskKey } from "@/lib/crypto";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const [profile, creds, connection] = await Promise.all([
    getProfile(user.id),
    getCredentials(user.id),
    getSheetConnection(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-bold">Set up your account</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Three steps. You will need an Apollo account and an AI provider key. Both have free tiers.
      </p>

      <div className="mt-8">
        <OnboardingWizard
          initialProfile={profile}
          keyStatus={{
            llmProvider: creds.llmProvider,
            llmKey: maskKey(creds.llmApiKey),
            apolloKey: maskKey(creds.apolloApiKey),
            verifierKey: maskKey(creds.millionVerifierApiKey),
          }}
          alreadyConnected={Boolean(connection?.last_synced_at)}
          templateSheetUrl={process.env.TEMPLATE_SHEET_URL ?? ""}
        />
      </div>
    </div>
  );
}
