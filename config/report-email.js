// The email drafted to the client when their report is released (pipeline/report-email.js).
//
// It is a reply in the client's existing onboarding email chain, in the mailbox of the
// PM who sent it, so it has no subject of its own ("Re: <the chain's subject>") and no
// greeting by name: it goes to everyone on the chain. Edit the wording here; the draft is
// plain text plus an HTML copy built from the same paragraphs (links in it become
// clickable). The PM's own Gmail signature is added below the last paragraph — the one
// for the address the reply is from (Gmail → Settings → Signature).

const list = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// The mailboxes searched are the PMs who have connected their Gmail in the SFE portal
// (lib/gmail-connections.js) — not configured here.
module.exports = {
  // Addresses on these domains are Cognisys people: kept on the reply (in Cc), but
  // never counted as the client.
  internalDomains: () => list(process.env.REPORT_EMAIL_INTERNAL_DOMAINS || 'cognisys.group,cognisys.co.uk'),

  // The body, one string per paragraph. A "\n" inside a paragraph is a line break.
  paragraphs: () => [
    'Hi team,',
    'Great news, your report is now ready!',
    'You can view this by logging into our reporting platform PlexTrac. This gives you a live, centralised '
      + 'view of findings, remediation progress, and your overall security posture, making it easier to track '
      + 'and manage security risks over time.',
    'You should have just received an email from PlexTrac asking you to create an account. Please follow '
      + 'the instructions on this link to set this up.',
    'Please click into your report, then head to the artefacts section, where you will find your full report, '
      + 'summary report and letter of attestation to share with your clients.',
    'We would also like to schedule a wash-up call to walk through the findings in more detail, answer any '
      + 'questions, and discuss the recommended remediation steps. Let me know when works for you.',
    'Best wishes,',
  ],
};
