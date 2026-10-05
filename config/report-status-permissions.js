// Who may move a Plextrac report into which status (pipeline/status-guard.js).
//
// The pentest release process has three rounds of QA:
//   Draft → Ready For Review (1st round) → In Review (2nd round) → Approved (ready for
//   release) → Published (released)
//
// Anyone may set Draft, Ready For Review and In Review. Approved and Published are
// restricted to the people below, matched on the email of their Plextrac account (one
// main account each — a second or service account of theirs does not count). A change
// by anyone else is put back and reported in the ready-for-release channel, and none of
// its automations run.
//
// Override a list with a comma-separated env var of emails:
//   PLEXTRAC_APPROVER_EMAILS   may set Approved
//   PLEXTRAC_PUBLISHER_EMAILS  may set Published

const QA_FIRST_STATUS = process.env.PLEXTRAC_QA_FIRST_STATUS || process.env.PLEXTRAC_QA_STATUS || 'Ready For Review';
const QA_SECOND_STATUS = process.env.PLEXTRAC_QA_SECOND_STATUS || 'In Review';
const APPROVED_STATUS = process.env.PLEXTRAC_APPROVED_STATUS || 'Approved';
const RELEASED_STATUS = process.env.PLEXTRAC_RELEASED_STATUS || 'Published';

const emails = (envValue, fallback) => {
  const list = String(envValue || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : fallback;
};

const PUBLISHERS = emails(process.env.PLEXTRAC_PUBLISHER_EMAILS, [
  'alice.elvin@cognisys.group',   // Alice Elvin
  'ben.reilly@cognisys.group',    // Ben Reilly
]);

const APPROVERS = emails(process.env.PLEXTRAC_APPROVER_EMAILS, [
  'alice.elvin@cognisys.group',   // Alice Elvin
  'ben.reilly@cognisys.group',    // Ben Reilly
  'soham.bakore@cognisys.group',  // Soham Bakore
  'punit.sharma@cognisys.co.uk',  // Punit Sharma
  'karan.luniyal@cognisys.co.uk', // Karan Luniyal
  'rajveer.parmar@cognisys.group', // Rajveer Parmar
]);

module.exports = {
  // The statuses in order. Used to choose where to put a report back to when its
  // previous status isn't known.
  ORDER: ['Draft', QA_FIRST_STATUS, QA_SECOND_STATUS, APPROVED_STATUS, RELEASED_STATUS],
  QA_FIRST_STATUS,
  QA_SECOND_STATUS,
  APPROVED_STATUS,
  RELEASED_STATUS,
  // Restricted statuses → the emails allowed to set them. Any status not listed here
  // is open to everyone.
  RESTRICTED: {
    [APPROVED_STATUS]: APPROVERS,
    [RELEASED_STATUS]: PUBLISHERS,
  },
  APPROVERS,
  PUBLISHERS,
};
