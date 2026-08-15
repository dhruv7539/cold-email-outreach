"use client";

import { useState } from "react";
import { createPairingTokenAction, checkConnectionAction } from "@/app/actions/onboarding";

export function ConnectSheetStep({
  templateSheetUrl,
  alreadyConnected,
  onBack,
  onDone,
}: {
  templateSheetUrl: string;
  alreadyConnected: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(alreadyConnected);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    const result = await createPairingTokenAction();
    setToken(result.token);
  }

  async function check() {
    setChecking(true);
    const result = await checkConnectionAction();
    setChecking(false);
    setConnected(result.connected);
  }

  return (
    <div className="card space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">Connect your sending sheet</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Emails send from your own Gmail through a Google Sheet you copy into your Drive. We never see your
          Google password and never send on your behalf. This is a one-time setup.
        </p>
      </div>

      <ol className="space-y-5">
        <Step n={1} title="Make your own copy of the sheet">
          {templateSheetUrl ? (
            <a href={templateSheetUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">
              Open the template, then File to Make a copy
            </a>
          ) : (
            <p className="text-sm text-[var(--color-warn)]">
              The template link is not configured yet. Ask the person who deployed this app for the template
              sheet URL.
            </p>
          )}
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            The first time you open the Apps Script menu, Google shows an &quot;app isn&apos;t verified&quot;
            warning because it is your own private script. Choose Advanced, then continue.
          </p>
        </Step>

        <Step n={2} title="Get your pairing token">
          {token ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-[var(--color-canvas)] p-2 text-xs">{token}</code>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(token);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-[var(--color-muted)]">
                Shown once. Paste it into the Settings tab of your copied sheet, in the <code>pairing_token</code>{" "}
                row. Put your app URL in the <code>api_base_url</code> row.
              </p>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" onClick={generate}>
              Generate my token
            </button>
          )}
        </Step>

        <Step n={3} title="Turn on syncing in the sheet">
          <p className="text-sm text-[var(--color-muted)]">
            In the sheet menu, open Outreach Sequencer, then Setup Sheet, then Install Trigger, then Install
            Hub Sync Trigger. Use Connect to Hub (test) to confirm it works.
          </p>
        </Step>

        <Step n={4} title="Confirm the connection">
          {connected ? (
            <div className="badge bg-green-50 text-[var(--color-good)]">Connected and syncing</div>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={check} disabled={checking}>
              {checking ? "Checking..." : "Check connection"}
            </button>
          )}
        </Step>
      </ol>

      <div className="flex justify-between border-t border-[var(--color-line)] pt-4">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone} disabled={!connected}>
          {connected ? "Finish setup" : "Connect your sheet to finish"}
        </button>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-xs font-semibold text-[var(--color-accent)]">
        {n}
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium">{title}</p>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}
