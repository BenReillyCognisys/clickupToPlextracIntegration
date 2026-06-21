// Executive-summary section names that get a REDUCED AI QA review.
//
// Some report sections are boilerplate / reference material — e.g. "Methodology",
// "Issue Matrix" and "Limitations" — that is templated, not free-form narrative.
// These sections are NOT skipped entirely: they are still checked for an incorrect
// client name (that must be right everywhere). They only skip the de-jargon and
// incomplete-sentence checks, which would wrongly rewrite fixed structural content.
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
  : ['Methodology', 'Issue Matrix', 'Limitations'];
