const TESTING_TYPES = require('../config/testing-types');

// Ensure longest types are tested first so "Secure Build Review" beats "Review"
const SORTED_TYPES = [...TESTING_TYPES].sort((a, b) => b.length - a.length);

// Phrases that describe the WORK rather than the client. Used to notice a task name
// that was entered in the wrong order (e.g. "Black Box Pen Test - Brask - Black Box
// Web Application Penetration Testing") so a testing type is never taken as the
// client name. STRONG phrases are unambiguous — no client is called "Pen Test".
// WEAK words also appear in real company names ("Internal Systems Ltd", "Audit
// Partners"), so on their own they never trigger the reordering heuristics.
const STRONG_HINTS = [
  'penetration testing', 'penetration test', 'pen testing', 'pen test', 'pentest',
  'vulnerability assessment', 'vulnerability scan', 'security assessment',
  'security review', 'security audit', 'configuration review', 'build review',
  'red team', 'social engineering', 'phishing',
  'web application', 'web app', 'mobile application',
  // Multi-word canonical types are strong signals in their own right.
  ...TESTING_TYPES.filter(t => t.includes(' ')),
];

const WEAK_HINTS = ['assessment', 'audit', 'review', 'testing', 'scan',
  ...TESTING_TYPES.filter(t => !t.includes(' '))];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-phrase containment, so "ExternalSystem" doesn't count as "External".
function containsPhrase(text, phrase) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`, 'i').test(text);
}

// Canonical casing for a known type, or null if it isn't one we recognise.
function canonicalType(rawType) {
  const t = (rawType || '').trim();
  return SORTED_TYPES.find(type => type.toLowerCase() === t.toLowerCase()) || null;
}

// How much a fragment reads like a testing type rather than a client name:
//   3 = it IS a canonical type, 2 = contains a strong phrase,
//   1 = contains a weak word only, 0 = looks like a client name.
function typeScore(fragment) {
  const text = (fragment || '').trim();
  if (!text) return 0;
  if (canonicalType(text)) return 3;
  if (STRONG_HINTS.some(h => containsPhrase(text, h))) return 2;
  if (WEAK_HINTS.some(h => containsPhrase(text, h))) return 1;
  return 0;
}

// A fragment we're confident describes the work, not the client.
const looksLikeType = (fragment) => typeScore(fragment) >= 2;

// Splits on spaced hyphens only, so hyphenated names ("Smith-Jones Ltd") stay whole.
function hyphenSegments(text) {
  return String(text || '').split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Recovers the client from a name whose FIRST segment describes the testing type —
 * a name entered in the wrong order, e.g.
 *   "Black Box Pen Test - Brask - Black Box Web Application Penetration Testing"
 * A correctly-entered name starts with the client, so this only engages when the
 * leading segment is clearly a testing type. Returns null when it doesn't apply,
 * leaving the normal rules in charge.
 */
function recoverMisorderedName(name) {
  const segs = hyphenSegments(name);
  if (segs.length < 2 || !looksLikeType(segs[0])) return null;

  // First segment that doesn't clearly describe the work is the client.
  const clientIdx = segs.findIndex(s => !looksLikeType(s));
  if (clientIdx === -1) return null; // every segment reads as a type — don't guess

  // Prefer a type segment after the client (the usual "... - Client - Type" shape),
  // otherwise fall back to the strongest type segment anywhere in the name.
  const candidates = segs
    .map((text, idx) => ({ text, idx }))
    .filter(c => c.idx !== clientIdx && looksLikeType(c.text));
  const after = candidates.filter(c => c.idx > clientIdx);
  const pool = after.length ? after : candidates;
  const best = pool.reduce((a, b) => (typeScore(b.text) > typeScore(a.text) ? b : a));

  return {
    client_name: segs[clientIdx],
    testing_type: canonicalType(best.text) || best.text,
    warning: `Task name looks out of order — "${segs[0]}" reads like a testing type, `
      + `so "${segs[clientIdx]}" was used as the client name.`,
  };
}

/**
 * Parses a ClickUp task name into { client_name, testing_type }, plus an optional
 * `warning` when the name looked mis-entered and had to be interpreted.
 *
 * Format 1 (preferred): "Client Name | Testing Type"
 * Format 2 (fallback):  "Client Name - Testing Type"
 * Format 3 (fallback):  "Client Name Testing Type"  — type matched at end of name
 *
 * In every format the client name is never allowed to be a testing type: if the
 * name puts the type first, the client is recovered from the remaining segments.
 */
function parseTaskName(rawName) {
  const name = (rawName || '').trim();

  if (name.includes('|')) {
    const idx = name.indexOf('|');
    const left = name.slice(0, idx).trim();
    const rawType = name.slice(idx + 1).trim();
    const testing_type = canonicalType(rawType) || rawType;

    if (looksLikeType(left)) {
      // The client-side half describes the work. Either it's a hyphenated mess with
      // the client buried in it, or the two halves were entered the wrong way round.
      const leftSegs = hyphenSegments(left);
      const buried = leftSegs.find(s => !looksLikeType(s));
      if (buried) {
        return {
          client_name: buried,
          testing_type,
          warning: `Task name looks out of order — "${leftSegs[0]}" reads like a testing type, `
            + `so "${buried}" was used as the client name.`,
        };
      }
      if (!looksLikeType(rawType)) {
        return {
          client_name: rawType,
          testing_type: canonicalType(left) || left,
          warning: `Task name looks reversed — "${left}" reads like a testing type, `
            + `so "${rawType}" was used as the client name.`,
        };
      }
    }

    return { client_name: left, testing_type };
  }

  const misordered = recoverMisorderedName(name);
  if (misordered) return misordered;

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
