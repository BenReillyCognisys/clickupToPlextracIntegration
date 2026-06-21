// Helpers to enforce that protected organisation names (e.g. the testing
// provider, Cognisys) are never removed or replaced by an AI edit. Used as a
// deterministic guard on top of the prompt instruction.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive count of non-overlapping occurrences of `needle` in `text`.
function countOccurrences(text, needle) {
  if (!needle) return 0;
  const matches = String(text).match(new RegExp(escapeRegex(needle), 'gi'));
  return matches ? matches.length : 0;
}

// True if `after` contains at least as many occurrences of every protected name
// as `before` did — i.e. the edit didn't remove or rename any of them.
function namesPreserved(before, after, names) {
  for (const name of names) {
    if (countOccurrences(after, name) < countOccurrences(before, name)) return false;
  }
  return true;
}

module.exports = { namesPreserved, countOccurrences };
