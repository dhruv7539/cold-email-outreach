import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/campaigns/new", label: "New campaign" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--color-accent)] text-white">O</span>
            Outreach Hub
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]"
              >
                {item.label}
              </Link>
            ))}
            <span className="mx-2 hidden text-xs text-[var(--color-muted)] sm:inline">{email}</span>
            <form action={signOutAction}>
              <button className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
