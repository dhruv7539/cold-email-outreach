import Link from "next/link";

export const metadata = { title: "Terms and privacy · Outreach Hub" };

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm text-[var(--color-accent)] underline">
        Back
      </Link>
      <h1 className="mt-4 text-2xl font-bold">How your keys and data are handled</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">Plain language, because this matters.</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed">
        <Section title="Your email is never touched by us">
          Outreach is sent from your own Gmail, through a Google Sheet you copy into your own Drive. We never
          receive your Google password, never hold a Google access token, and never send email on your behalf.
          The connection is one-way: your sheet asks us for approved drafts and tells us what happened. We
          cannot read your inbox.
        </Section>

        <Section title="Your API keys are yours">
          The Apollo and AI keys you enter are encrypted with AES-256 before they are stored, and are only ever
          decrypted in memory to run your own campaigns. They are never shared with other users, never logged,
          and never used for anything except the work you start. You can change or delete them anytime in
          Settings; deleting a key removes it immediately.
        </Section>

        <Section title="Nothing sends without your approval">
          Every email is shown to you in full before it can be queued. You read it, edit it if you want, and
          approve it one at a time. An email you did not approve is never handed to your sheet. This is
          deliberate and permanent: an AI drafting on your behalf is only acceptable if you are the one who
          decides what actually goes out under your name.
        </Section>

        <Section title="We honor opt-outs automatically">
          If someone replies asking not to be contacted, their address is suppressed immediately and no further
          email is sent to them, on this campaign or any future one. You can also add addresses to your
          do-not-contact list by hand. Bounced addresses are suppressed the same way, which protects both the
          recipients and your own ability to reach real inboxes.
        </Section>

        <Section title="What we store">
          Your profile (from your resume), your campaigns, the contacts we find, the drafts we write, and the
          send and reply events your sheet reports. This is what powers your dashboard. You can request
          deletion of your account and all associated data at any time.
        </Section>

        <Section title="Use it responsibly">
          This tool is for a genuine job search: real applications you have submitted, to real people who could
          help. It is not for bulk marketing or spam. Sending volume is paced and bounce rate is capped
          precisely so this stays legitimate outreach. Use it the way you would want to be contacted.
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-[var(--color-muted)]">{children}</p>
    </section>
  );
}
