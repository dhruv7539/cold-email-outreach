import type { CampaignInfo } from "./CampaignView";

const VERDICT_LABEL: Record<string, { label: string; className: string }> = {
  full: { label: "Strong fit", className: "bg-green-50 text-[var(--color-good)]" },
  light: { label: "Worth a light touch", className: "bg-amber-50 text-[var(--color-warn)]" },
  skip: { label: "Probably skip", className: "bg-red-50 text-[var(--color-bad)]" },
};

export function IntakeCard({ campaign }: { campaign: CampaignInfo }) {
  if (campaign.intakeScore === null) return null;
  const verdict = VERDICT_LABEL[campaign.intakeVerdict ?? "skip"] ?? VERDICT_LABEL.skip;

  const job = campaign.parsedJob as {
    stack?: string[];
    seniority?: string;
    location?: string;
    workArrangement?: string;
  };

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Fit score</h2>
        <div className="flex items-center gap-3">
          <span className={`badge ${verdict.className}`}>{verdict.label}</span>
          <span className="text-2xl font-bold">
            {campaign.intakeScore}
            <span className="text-sm text-[var(--color-muted)]">/100</span>
          </span>
        </div>
      </div>

      <p className="mt-3 text-sm text-[var(--color-muted)]">{campaign.intakeRationale}</p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {job.seniority && <Tag>{job.seniority.replace("_", " ")}</Tag>}
        {job.location && <Tag>{job.location}</Tag>}
        {job.workArrangement && job.workArrangement !== "unclear" && <Tag>{job.workArrangement}</Tag>}
        {(job.stack ?? []).slice(0, 8).map((tech) => (
          <Tag key={tech}>{tech}</Tag>
        ))}
      </div>
    </section>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-[var(--color-canvas)] px-2.5 py-1 text-[var(--color-muted)]">{children}</span>;
}
