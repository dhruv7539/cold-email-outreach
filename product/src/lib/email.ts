// Transactional email for magic links.
//
// This is the ONE place the product sends mail itself, and it is only ever a
// sign-in link to the address that requested it, never outreach. Outreach is
// sent exclusively from the user's own Gmail via their copied sheet.
//
// Uses Resend if configured, otherwise no-ops and lets the caller surface the
// link directly (fine for local development, never for production).

export async function sendMagicLink(to: string, link: string): Promise<{ delivered: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAGIC_LINK_FROM ?? "Outreach Hub <login@outreach.example>";

  if (!apiKey) {
    console.log(`[email] No RESEND_API_KEY set. Magic link for ${to}: ${link}`);
    return { delivered: false };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to,
      subject: "Your Outreach Hub sign-in link",
      html:
        `<p>Click to sign in. This link works once and expires in 20 minutes.</p>` +
        `<p><a href="${link}">Sign in to Outreach Hub</a></p>` +
        `<p style="color:#5b6472;font-size:12px">If you did not request this, you can ignore it.</p>`,
    }),
  });

  if (!response.ok) {
    console.error(`[email] Resend returned ${response.status}`);
    return { delivered: false };
  }

  return { delivered: true };
}
