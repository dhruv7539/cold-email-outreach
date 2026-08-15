import { transaction } from "@/lib/db";
import { getProfile, getSendHistory, getBlacklist } from "@/lib/repo";
import { getCampaign, getContacts, getDrafts, updateCampaign } from "./repo";
import { buildQueueRows } from "@core/queue/build-rows.mjs";
import { computeHealth, blocksSending } from "@core/health/compute-health.mjs";

// The last gate before rows become available to the user's sheet.
//
// Two hard checks, both server-side so neither can be skipped from the client:
//   1. Only approved drafts queue. Approval means the user read and accepted it.
//   2. The health gate blocks the whole batch if the trailing bounce rate is
//      above 2%.
// The blacklist is enforced again at hand-off in the sync route, so a suppressed
// address cannot slip through even if it survives to here.

export async function queueApprovedDrafts(userId: string, campaignId: string) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new Error("Campaign not found.");

  const history = await getSendHistory(userId);
  const health = computeHealth(
    history.map((h) => ({ status: h.status, main_sent_at: h.main_sent_at, reply_detected_at: h.reply_detected_at }))
  );

  if (blocksSending(health)) {
    await updateCampaign(userId, campaignId, { status: "blocked", status_detail: health.alerts.join(" ") });
    return { queued: 0, blocked: true, health };
  }

  const [profile, contacts, drafts, blacklist] = await Promise.all([
    getProfile(userId),
    getContacts(userId, campaignId),
    getDrafts(userId, campaignId),
    getBlacklist(userId),
  ]);

  const suppressed = new Set(blacklist.map((b) => b.email.toLowerCase()));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const approved = drafts.filter((d) => d.approved_at);

  if (!approved.length) {
    return { queued: 0, blocked: false, health, reason: "No drafts are approved yet." };
  }

  const specDrafts = [];
  const skipped: string[] = [];

  for (const draft of approved) {
    const contact = contactById.get(draft.contact_id);
    if (!contact?.email) continue;
    if (suppressed.has(contact.email.toLowerCase())) {
      skipped.push(contact.email);
      continue;
    }

    specDrafts.push({
      key: `${contact.first_name}-${contact.last_name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      to: contact.email,
      contactName: contact.full_name,
      contactType: contact.contact_type,
      subject: draft.subject,
      html: draft.main_html,
      followUp1Html: draft.follow_up_1_html,
      followUpCount: 1,
      subjectVariant: draft.subject_variant,
      ctaType: draft.cta_type,
      copyStructure: draft.copy_structure,
    });
  }

  const contactMeta = new Map(
    contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), { state: c.state }])
  );

  const { rows } = buildQueueRows(
    { drafts: specDrafts },
    {
      company: campaign.company,
      senderEmail: "",
      defaultTimezone: (profile as { timezone?: string })?.timezone ?? "America/New_York",
      contactMeta,
      perDay: 8,
    }
  );

  await transaction(async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO queue_items (job_id, user_id, campaign_id, recipient_email, row, delivery_state, status)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'queued')
         ON CONFLICT (job_id) DO NOTHING`,
        [row.job_id, userId, campaignId, row.recipient_email, JSON.stringify(row)]
      );
    }
  });

  await updateCampaign(userId, campaignId, {
    status: "queued",
    status_detail: `${rows.length} queued${skipped.length ? `, ${skipped.length} skipped (suppressed)` : ""}`,
  });

  return { queued: rows.length, blocked: false, health, skipped };
}
