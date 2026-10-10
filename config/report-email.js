// The email drafted to the client when their report is released (pipeline/report-email.js).
//
// It is a reply in the client's existing onboarding email chain, in the mailbox of the
// PM who sent it, so it has no subject of its own ("Re: <the chain's subject>") and no
// greeting by name: it goes to everyone on the chain. Edit the wording here; the draft is plain text plus an HTML copy built
// from the same paragraphs (links in it become clickable).
//
// `reportTitle` is the report's testing type ("External Infrastructure"), taken from
// its Plextrac name ("External Infrastructure | October 2026").

const PLEXTRAC_BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

const list = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// The mailboxes searched are the PMs who have connected their Gmail in the SFE portal
// (lib/gmail-connections.js) — not configured here.
module.exports = {
  // Addresses on these domains are Cognisys people: kept on the reply (in Cc), but
  // never counted as the client.
  internalDomains: () => list(process.env.REPORT_EMAIL_INTERNAL_DOMAINS || 'cognisys.group,cognisys.co.uk'),

  // Where the client reads the report.
  plextracUrl: () => (process.env.REPORT_EMAIL_PLEXTRAC_URL || PLEXTRAC_BASE).trim(),

  // The body, one string per paragraph. A "\n" inside a paragraph is a line break.
  paragraphs: ({ reportTitle, plextracUrl }) => [
    'Hi all,',
    `I'm pleased to let you know that your ${reportTitle} report has been completed and released. `
      + 'You can view and download it in Plextrac:',
    plextracUrl,
    'If you have any questions about the findings, or would like to arrange a debrief call '
      + 'to walk through them, just reply to this email.',
    'Kind regards,\nCognisys Penetration Testing Team',
  ],
};
