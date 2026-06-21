// Plextrac template placeholders look like %%CLIENT_SHORTNAME%%,
// %%REPORT_START_DATE%%, %%Author_01%%, etc. Plextrac substitutes them at render
// time, so the QA process must never add, remove, or alter them. These helpers
// let the check runner verify an AI edit left every placeholder intact.

const PLACEHOLDER_RE = /%%[^%]+%%/g;

// Returns the sorted list of %%...%% placeholders found in the text.
function extractPlaceholders(text) {
  if (typeof text !== 'string') return [];
  return (text.match(PLACEHOLDER_RE) || []).sort();
}

// True if `after` contains exactly the same multiset of placeholders as `before`
// (same tokens, same counts). A reordering is allowed; an add/remove/edit is not.
function placeholdersPreserved(before, after) {
  const a = extractPlaceholders(before);
  const b = extractPlaceholders(after);
  if (a.length !== b.length) return false;
  return a.every((p, i) => p === b[i]);
}

module.exports = { extractPlaceholders, placeholdersPreserved, PLACEHOLDER_RE };
