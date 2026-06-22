// Executive-summary section names that SKIP the de-jargon check specifically.
//
// Unlike config/excluded-sections.js (which gives a section a fully reduced,
// client-name-only review), these sections keep their client-name AND
// incomplete-sentence checks — only the de-jargon rewrite is skipped, because
// they contain deliberate technical/structured wording (e.g. "Limitation(s)"
// and "Roadmap") that de-jargon would wrongly simplify.
//
// Matching is case-insensitive and substring-based against the section's
// label/title (so "Project Roadmap" matches "Roadmap" and "Limitation" matches
// both the singular and "Limitations").
//
// Override / extend via env QA_DEJARGON_EXCLUDED_SECTIONS (comma-separated).
const fromEnv = (process.env.QA_DEJARGON_EXCLUDED_SECTIONS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = fromEnv.length
  ? fromEnv
  : ['Limitation', 'Roadmap'];
