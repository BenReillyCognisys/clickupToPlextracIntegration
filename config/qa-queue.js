// Who may claim a report in DeliveryFlow's QA queue (routes/deliveryflow-qa-queue.js).
//
// First-round QA: any consultant. Second-round QA: only the people below, matched on
// the email DeliveryFlow sends for the person claiming. cognisys.co.uk and
// cognisys.group are the same mailbox (people sign in to different systems with
// either), so either domain matches.
//
// Override with QA_SECOND_ROUND_CLAIMER_EMAILS (comma-separated emails).

const DOMAINS = ['cognisys.group', 'cognisys.co.uk'];

const list = (envValue, fallback) => {
  const out = String(envValue || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return out.length ? out : fallback;
};

const SECOND_ROUND_CLAIMERS = list(process.env.QA_SECOND_ROUND_CLAIMER_EMAILS, [
  'karan.luniyal@cognisys.group',  // Karan Luniyal
  'rajveer.parmar@cognisys.group', // Raj Parmar
  'punit.sharma@cognisys.group',   // Punit Sharma
  'ben.reilly@cognisys.group',     // Ben Reilly
  'soham.bakore@cognisys.group',   // Soham Bakore
]);

// One form for an address: lower case, with the Cognisys domains folded together.
function mailbox(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  const domain = e.slice(at + 1);
  return DOMAINS.includes(domain) ? `${e.slice(0, at)}@${DOMAINS[0]}` : e;
}

const sameMailbox = (a, b) => Boolean(a && b) && mailbox(a) === mailbox(b);

// May this person claim a report in this round?
function mayClaim(stage, email) {
  if (stage !== 'second') return true;
  return SECOND_ROUND_CLAIMERS.some((allowed) => sameMailbox(allowed, email));
}

module.exports = { SECOND_ROUND_CLAIMERS, mayClaim, sameMailbox, mailbox };
