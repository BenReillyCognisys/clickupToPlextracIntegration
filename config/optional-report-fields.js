// Report custom fields that are ALLOWED to be empty at first-round QA.
//
// Every other custom field on the report (Team Name, Author 1, Author 1 Title,
// Author 1 Email, …) must be filled in before QA — an empty one is flagged in
// #pt-first-round-qa and @-mentions the person who submitted the report so they
// can fix it. The four below are populated elsewhere (or deliberately left blank),
// so they are exempt from the check.
//
// Matching is EXACT (case-insensitive, whitespace-normalised) against the field's
// label — unlike the section lists, which match on substring — so exempting
// "Version" never accidentally exempts a differently-named required field.
//
// Override / extend via env QA_OPTIONAL_REPORT_FIELDS (comma-separated).
const fromEnv = (process.env.QA_OPTIONAL_REPORT_FIELDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = fromEnv.length
  ? fromEnv
  : ['Client Acronym', 'Client Full Name', 'Report Title', 'Version'];
