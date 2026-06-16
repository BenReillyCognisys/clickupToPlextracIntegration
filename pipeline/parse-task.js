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
    const rawType = name.slice(idx + 1).trim();
    const canonical = SORTED_TYPES.find(t => t.toLowerCase() === rawType.toLowerCase());
    return {
      client_name: name.slice(0, idx).trim(),
      testing_type: canonical || rawType,
    };
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
