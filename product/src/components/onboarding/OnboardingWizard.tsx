"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeysStep } from "./KeysStep";
import { ProfileStep } from "./ProfileStep";
import { ConnectSheetStep } from "./ConnectSheetStep";

type KeyStatus = {
  llmProvider: string | null;
  llmKey: string;
  apolloKey: string;
  verifierKey: string;
};

const STEPS = ["Keys", "Profile", "Connect your sheet"];

export function OnboardingWizard({
  initialProfile,
  keyStatus,
  alreadyConnected,
  templateSheetUrl,
}: {
  initialProfile: Record<string, unknown> | null;
  keyStatus: KeyStatus;
  alreadyConnected: boolean;
  templateSheetUrl: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(keyStatus.llmKey ? (initialProfile ? 2 : 1) : 0);

  return (
    <div>
      <ol className="mb-8 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`grid h-7 w-7 place-items-center rounded-full text-sm font-semibold ${
                i < step
                  ? "bg-[var(--color-good)] text-white"
                  : i === step
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-line)] text-[var(--color-muted)]"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span className={`text-sm ${i === step ? "font-semibold" : "text-[var(--color-muted)]"}`}>{label}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-[var(--color-line)]" />}
          </li>
        ))}
      </ol>

      {step === 0 && <KeysStep keyStatus={keyStatus} onDone={() => setStep(1)} />}
      {step === 1 && (
        <ProfileStep initialProfile={initialProfile} onDone={() => setStep(2)} onBack={() => setStep(0)} />
      )}
      {step === 2 && (
        <ConnectSheetStep
          templateSheetUrl={templateSheetUrl}
          alreadyConnected={alreadyConnected}
          onBack={() => setStep(1)}
          onDone={() => router.push("/dashboard")}
        />
      )}
    </div>
  );
}
