import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getCredentials, getSheetConnection, getBlacklist } from "@/lib/repo";
import { maskKey } from "@/lib/crypto";
import { Shell } from "@/components/Shell";
import { KeysStep } from "@/components/onboarding/KeysStep";
import { SuppressionList } from "@/components/settings/SuppressionList";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const [creds, connection, blacklist] = await Promise.all([
    getCredentials(user.id),
    getSheetConnection(user.id),
    getBlacklist(user.id),
  ]);

  return (
    <Shell email={user.email}>
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="mt-6 space-y-8">
        <section>
          <h2 className="mb-3 text-lg font-semibold">API keys</h2>
          <KeysStep
            keyStatus={{
              llmProvider: creds.llmProvider,
              llmKey: maskKey(creds.llmApiKey),
              apolloKey: maskKey(creds.apolloApiKey),
              verifierKey: maskKey(creds.millionVerifierApiKey),
            }}
          />
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">Sending sheet</h2>
          {connection?.last_synced_at ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Connected as {connection.sender_email ?? "your Gmail"}. Last synced{" "}
              {new Date(connection.last_synced_at).toLocaleString()}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-warn)]">
              Your sheet is not connected yet.{" "}
              <Link href="/onboarding" className="underline">
                Finish setup
              </Link>
              .
            </p>
          )}
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">Do-not-contact list</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Anyone here is never emailed again. Bounces and opt-out replies are added automatically. You can add
            addresses too.
          </p>
          <div className="mt-4">
            <SuppressionList entries={blacklist.map((b) => ({ email: b.email, reason: b.reason, source: b.source }))} />
          </div>
        </section>

        <section className="card p-6">
          <h2 className="text-lg font-semibold">Your data</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Read how your keys and data are handled on the{" "}
            <Link href="/terms" className="text-[var(--color-accent)] underline">
              terms and privacy page
            </Link>
            .
          </p>
        </section>
      </div>
    </Shell>
  );
}
