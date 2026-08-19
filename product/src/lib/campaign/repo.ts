import { query, queryOne, transaction } from "@/lib/db";

// Campaign-specific persistence, kept apart from the account-level repo so the
// two stay readable.

export type CampaignRow = {
  id: string;
  user_id: string;
  company: string;
  role_title: string;
  req_id: string;
  apply_url: string;
  job_text: string;
  parsed_job: Record<string, unknown>;
  intake_score: number | null;
  intake_verdict: string | null;
  intake_rationale: string;
  status: string;
  status_detail: string;
  created_at: Date;
  updated_at: Date;
};

export async function createCampaign(userId: string, jobText: string): Promise<CampaignRow> {
  return (await queryOne<CampaignRow>(
    `INSERT INTO campaigns (user_id, company, job_text, status) VALUES ($1, '', $2, 'draft') RETURNING *`,
    [userId, jobText]
  ))!;
}

export async function getCampaign(userId: string, campaignId: string): Promise<CampaignRow | null> {
  return queryOne<CampaignRow>("SELECT * FROM campaigns WHERE id = $1 AND user_id = $2", [campaignId, userId]);
}

export async function listCampaigns(userId: string): Promise<CampaignRow[]> {
  return query<CampaignRow>(
    "SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    [userId]
  );
}

export async function updateCampaign(
  userId: string,
  campaignId: string,
  patch: Partial<{
    company: string;
    role_title: string;
    req_id: string;
    apply_url: string;
    parsed_job: unknown;
    intake_score: number;
    intake_verdict: string;
    intake_rationale: string;
    status: string;
    status_detail: string;
  }>
): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;

  const sets = keys.map((key, i) => `${key} = $${i + 3}`).join(", ");
  const values = keys.map((key) => {
    const v = (patch as Record<string, unknown>)[key];
    return key === "parsed_job" ? JSON.stringify(v) : v;
  });

  await query(
    `UPDATE campaigns SET ${sets}, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [campaignId, userId, ...values]
  );
}

export type ContactRow = {
  id: string;
  campaign_id: string;
  apollo_id: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  title: string;
  headline: string;
  contact_type: string;
  email: string | null;
  email_source: string | null;
  email_verification: Record<string, unknown> | null;
  linkedin_url: string | null;
  city: string;
  state: string;
  selected: boolean;
  brief: string;
};

export async function replaceContacts(
  userId: string,
  campaignId: string,
  contacts: Omit<ContactRow, "id" | "campaign_id">[]
): Promise<ContactRow[]> {
  return transaction(async (client) => {
    await client.query("DELETE FROM contacts WHERE campaign_id = $1 AND user_id = $2", [campaignId, userId]);

    const inserted: ContactRow[] = [];
    for (const c of contacts) {
      const row = await client.query<ContactRow>(
        `INSERT INTO contacts
          (campaign_id, user_id, apollo_id, first_name, last_name, full_name, title, headline,
           contact_type, email, email_source, email_verification, linkedin_url, city, state, selected, brief)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          campaignId, userId, c.apollo_id, c.first_name, c.last_name, c.full_name, c.title, c.headline,
          c.contact_type, c.email, c.email_source, c.email_verification ? JSON.stringify(c.email_verification) : null,
          c.linkedin_url, c.city, c.state, c.selected, c.brief,
        ]
      );
      inserted.push(row.rows[0]);
    }
    return inserted;
  });
}

export async function getContacts(userId: string, campaignId: string): Promise<ContactRow[]> {
  return query<ContactRow>(
    "SELECT * FROM contacts WHERE campaign_id = $1 AND user_id = $2 ORDER BY created_at",
    [campaignId, userId]
  );
}

export type DraftRow = {
  id: string;
  campaign_id: string;
  contact_id: string;
  subject: string;
  main_html: string;
  follow_up_1_html: string;
  cta_type: string;
  lead_proof: string;
  copy_structure: string;
  subject_variant: string;
  lint_findings: { severity: string; code: string; message: string }[];
  lint_errors: number;
  repair_attempts: number;
  approved_at: Date | null;
  edited_by_user: boolean;
};

export async function upsertDraft(
  userId: string,
  campaignId: string,
  contactId: string,
  draft: {
    subject: string;
    main_html: string;
    follow_up_1_html: string;
    cta_type: string;
    lead_proof: string;
    copy_structure: string;
    subject_variant: string;
    lint_findings: unknown;
    lint_errors: number;
    repair_attempts: number;
  }
): Promise<void> {
  await query(
    `INSERT INTO drafts
      (campaign_id, contact_id, user_id, subject, main_html, follow_up_1_html, cta_type, lead_proof,
       copy_structure, subject_variant, lint_findings, lint_errors, repair_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (contact_id) DO UPDATE SET
       subject = EXCLUDED.subject, main_html = EXCLUDED.main_html,
       follow_up_1_html = EXCLUDED.follow_up_1_html, cta_type = EXCLUDED.cta_type,
       lead_proof = EXCLUDED.lead_proof, copy_structure = EXCLUDED.copy_structure,
       subject_variant = EXCLUDED.subject_variant, lint_findings = EXCLUDED.lint_findings,
       lint_errors = EXCLUDED.lint_errors, repair_attempts = EXCLUDED.repair_attempts,
       updated_at = now()`,
    [
      campaignId, contactId, userId, draft.subject, draft.main_html, draft.follow_up_1_html,
      draft.cta_type, draft.lead_proof, draft.copy_structure, draft.subject_variant,
      JSON.stringify(draft.lint_findings), draft.lint_errors, draft.repair_attempts,
    ]
  );
}

export async function getDrafts(userId: string, campaignId: string): Promise<DraftRow[]> {
  return query<DraftRow>(
    "SELECT * FROM drafts WHERE campaign_id = $1 AND user_id = $2 ORDER BY created_at",
    [campaignId, userId]
  );
}

export async function saveDraftEdit(
  userId: string,
  draftId: string,
  patch: { subject: string; main_html: string; follow_up_1_html: string; lint_findings: unknown; lint_errors: number }
): Promise<void> {
  await query(
    `UPDATE drafts SET subject = $3, main_html = $4, follow_up_1_html = $5,
       lint_findings = $6, lint_errors = $7, edited_by_user = true, updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [draftId, userId, patch.subject, patch.main_html, patch.follow_up_1_html, JSON.stringify(patch.lint_findings), patch.lint_errors]
  );
}

export async function approveDraft(userId: string, draftId: string, approved: boolean): Promise<void> {
  await query(
    `UPDATE drafts SET approved_at = ${approved ? "now()" : "NULL"}, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [draftId, userId]
  );
}
