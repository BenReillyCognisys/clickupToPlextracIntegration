// Organisation names that the client-name check must NEVER change.
//
// Cognisys is the penetration-testing PROVIDER (the report author), not the
// client under test — so references to it in the report are correct, not errors.
// Without this, the client-name check rewrites "Cognisys" into the client's name
// (e.g. "Cognisys" → "Ben Test"), which is wrong.
//
// Override / extend via env QA_PROTECTED_NAMES (comma-separated).
const fromEnv = (process.env.QA_PROTECTED_NAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = fromEnv.length
  ? fromEnv
  : ['Cognisys Group Limited', 'Cognisys Group', 'Cognisys'];
