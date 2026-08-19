import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCampaign, getContacts, getDrafts } from "@/lib/campaign/repo";
import { Shell } from "@/components/Shell";
import { CampaignView } from "@/components/campaign/CampaignView";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const { id } = await params;
  const campaign = await getCampaign(user.id, id);
  if (!campaign) notFound();

  const [contacts, drafts] = await Promise.all([getContacts(user.id, id), getDrafts(user.id, id)]);

  return (
    <Shell email={user.email}>
      <CampaignView
        campaign={{
          id: campaign.id,
          company: campaign.company,
          roleTitle: campaign.role_title,
          reqId: campaign.req_id,
          applyUrl: campaign.apply_url,
          intakeScore: campaign.intake_score,
          intakeVerdict: campaign.intake_verdict,
          intakeRationale: campaign.intake_rationale,
          status: campaign.status,
          statusDetail: campaign.status_detail,
          parsedJob: campaign.parsed_job,
        }}
        contacts={contacts.map((c) => ({
          id: c.id,
          name: c.full_name,
          title: c.title,
          contactType: c.contact_type,
          email: c.email,
          emailSource: c.email_source,
          linkedinUrl: c.linkedin_url,
        }))}
        drafts={drafts.map((d) => ({
          id: d.id,
          contactId: d.contact_id,
          subject: d.subject,
          mainHtml: d.main_html,
          followUp1Html: d.follow_up_1_html,
          lintFindings: d.lint_findings,
          lintErrors: d.lint_errors,
          repairAttempts: d.repair_attempts,
          approved: Boolean(d.approved_at),
          editedByUser: d.edited_by_user,
        }))}
      />
    </Shell>
  );
}
