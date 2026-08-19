import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { SignInForm } from "@/components/SignInForm";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <div className="grid gap-12 md:grid-cols-2 md:items-center">
        <div>
          <span className="badge bg-[var(--color-accent-soft)] text-[var(--color-accent)]">For job seekers</span>
          <h1 className="mt-4 text-4xl font-bold leading-tight">
            Personal cold emails that go out from your own Gmail.
          </h1>
          <p className="mt-4 text-lg text-[var(--color-muted)]">
            Paste a job description. The app finds the right people, writes a genuinely personal email to each
            one, and shows you every draft to approve before anything sends. The sending happens from your
            account, on your terms, so you stay in control.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[var(--color-muted)]">
            <li>Free to run. You bring your own Apollo and AI keys.</li>
            <li>Nothing sends without you reading and approving it first.</li>
            <li>We never touch your inbox or store a Google password.</li>
          </ul>
        </div>

        <div className="card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Sign in</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">We will email you a link. No password to remember.</p>
          <div className="mt-4">
            <SignInForm />
          </div>
        </div>
      </div>
    </div>
  );
}
