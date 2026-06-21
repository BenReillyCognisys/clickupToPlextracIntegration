// Executive-summary section names the AI QA review must SKIP entirely.
//
// Some report sections are boilerplate / reference material — e.g. "Methodology"
// and "Issue Matrix" — that is templated, not free-form narrative, and must never
// be run through the AI (no client-name, de-jargon or sentence checks). Editing
// them wastes API spend and risks rewriting fixed structural content.
//
// Matching is case-insensitive and substring-based against the section's
// label/title (so "Testing Methodology" also matches "Methodology").
//
// Override / extend via env QA_EXCLUDED_SECTIONS (comma-separated).
const fromEnv = (process.env.QA_EXCLUDED_SECTIONS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = fromEnv.length
  ? fromEnv
  : ['Methodology', 'Issue Matrix'];
