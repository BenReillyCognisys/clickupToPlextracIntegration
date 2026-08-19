const TESTING_TYPES = require('../config/testing-types');

// Ensure longest types are tested first so "Secure Build Review" beats "Review"
const SORTED_TYPES = [...TESTING_TYPES].sort((a, b) => b.length - a.length);

// Canonical casing for a known type, or null if it isn't one we recognise.
function canonicalType(rawType) {
  const t = (rawType || '').trim();
  return SORTED_TYPES.find(type => type.toLowerCase() === t.toLowerCase()) || null;
}

/**
 * Parses a ClickUp task name into { client_name, testing_type }.
 *
 * Format 1 (preferred): "Client Name | Testing Type"
 * Format 2 (fallback):  "Client Name - Testing Type"
 * Format 3 (fallback):  "Client Name Testing Type"  — type matched at end of name
 */
function parseTaskName(rawName) {
  const name = (rawName || '').trim();

  if (name.includes('|')) {
    const idx = name.indexOf('|');
    const rawType = name.slice(idx + 1).trim();
    return {
      client_name: name.slice(0, idx).trim(),
      testing_type: canonicalType(rawType) || rawType,
    };
  }

  if (name.includes('-')) {
    // Prefer the hyphen whose right-hand side is a known testing type, so that
    // hyphenated client names stay intact ("Smith-Jones Ltd - External").
    for (let idx = name.indexOf('-'); idx !== -1; idx = name.indexOf('-', idx + 1)) {
      const canonical = canonicalType(name.slice(idx + 1));
      if (canonical) {
        return {
          client_name: name.slice(0, idx).trim(),
          testing_type: canonical,
        };
      }
    }

    // No known type: fall back to the first spaced hyphen used as a separator.
    // Requiring whitespace on both sides keeps "Smith-Jones Ltd" as one name.
    const sep = name.match(/\s-\s/);
    if (sep) {
      return {
        client_name: name.slice(0, sep.index).trim(),
        testing_type: name.slice(sep.index + sep[0].length).trim(),
      };
    }
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
