const TESTING_TYPES = require('../config/testing-types');

// Ensure longest types are tested first so "Secure Build Review" beats "Review"
const SORTED_TYPES = [...TESTING_TYPES].sort((a, b) => b.length - a.length);

/**
 * Parses a ClickUp task name into { client_name, testing_type }.
 *
 * Format 1 (preferred): "Client Name | Testing Type"
 * Format 2 (fallback):  "Client Name Testing Type"  — type matched at end of name
 */
function parseTaskName(rawName) {
  const name = (rawName || '').trim();

  if (name.includes('|')) {
    const idx = name.indexOf('|');
    const client_name = name.slice(0, idx).trim();
    const rawType = name.slice(idx + 1).trim();

    // Extra pipes or a ? mean the name is ambiguous — don't guess
    if (rawType.includes('|') || rawType.includes('?')) {
      return { client_name, testing_type: 'Unknown' };
    }

    // Exact canonical match
    const exact = SORTED_TYPES.find(t => t.toLowerCase() === rawType.toLowerCase());
    if (exact) return { client_name, testing_type: exact };

    // Keyword match (e.g. "Grey Box Pentest" → "Grey Box")
    const lower = rawType.toLowerCase();
    const keyword = SORTED_TYPES.find(t => lower.includes(t.toLowerCase()));
    return { client_name, testing_type: keyword || 'Unknown' };
  }

  const lower = name.toLowerCase();
  for (const type of SORTED_TYPES) {
    const typeLower = type.toLowerCase();
    if (lower.endsWith(typeLower)) {
      const pos = name.length - type.length;
      // Require a word boundary: the character before the type must be a space (or start)
      if (pos === 0 || name[pos - 1] === ' ') {
        return {
          client_name: name.slice(0, pos).trim(),
          testing_type: type,
        };
      }
    }
  }

  return { client_name: name, testing_type: 'Unknown' };
}

module.exports = { parseTaskName };
