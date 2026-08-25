const TESTING_TYPES = require('../config/testing-types');

// Every phrase we know how to recognise, flattened from config/testing-types.js.
// The canonical name is itself a phrase (that's how "Acme | Grey Box" is matched);
// `notFollowedBy` only ever guards that bare canonical phrase, never an alias.
const PHRASES = TESTING_TYPES.flatMap(({ type, aliases = [], bareNotFollowedBy = null, methodology = false }) => [
  { phrase: type, type, methodology, notFollowedBy: bareNotFollowedBy },
  ...aliases.map(phrase => ({ phrase, type, methodology, notFollowedBy: null })),
]);

const CANONICAL_NAMES = TESTING_TYPES.map(t => t.type);

// Phrases that describe the WORK rather than the client. Used only to notice a task
// name entered in the wrong order (e.g. "Black Box Pen Test - Brask - Black Box Web
// Application Penetration Testing") so a testing type is never taken as the client
// name. These are deliberately unambiguous — no client is called "Pen Test".
//
// Single-word canonical types (Internal, External, CIS) are NOT in here: they appear
// in real company names ("Internal Systems Ltd"), so on their own they must never
// trigger the reordering heuristic. A segment that is EXACTLY a canonical type still
// counts, via looksLikeType() below.
const STRONG_HINTS = [
  'penetration testing', 'penetration test', 'pen testing', 'pen test', 'pentest',
  'vulnerability assessment', 'vulnerability scan', 'security assessment',
  'security review', 'security audit', 'configuration review', 'build review',
  'red team', 'social engineering', 'phishing',
  // Multi-word canonical types, and every alias, are strong signals in their own right.
  ...CANONICAL_NAMES.filter(t => t.includes(' ')),
  ...TESTING_TYPES.flatMap(t => t.aliases || []),
];

// Longest scope qualifier we'll carry into a report name — anything beyond this is
// prose, not a scope, and would make the Plextrac report name unreadable.
const MAX_SCOPE_LENGTH = 60;

const isWordChar = (ch) => ch != null && /[a-z0-9]/i.test(ch);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-phrase containment, so "ExternalSystem" doesn't count as "External".
function containsPhrase(text, phrase) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * Finds the testing type inside a task name.
 *
 * Deal names arrive as "Client - Deal name - Service" (with '|' and '-' mixed
 * freely), so the service can't be found by splitting on a separator — we search
 * the whole name for a known phrase instead.
 *
 * Two rules decide between competing matches:
 *   • a methodology (Black Box / Grey Box) outranks a target type, because that's
 *     what config/template-map.js selects a Plextrac template on. "Black Box Web
 *     Application Penetration Testing" is therefore Black Box, not Web App;
 *   • otherwise the match that ENDS last wins, since the service is the tail of the
 *     name, with ties going to the longer phrase — so "Mobile Device Application
 *     Penetration Testing" beats the "Application Penetration Testing" inside it.
 *
 * Returns { type, start, end, recognisedEnd } or null when nothing is recognised.
 * `recognisedEnd` is where the LAST recognised phrase ends, which is not the winner's
 * own end when a methodology outranks a longer target phrase after it — the scope
 * qualifier starts there, so "Black Box Web Application Penetration Testing" carries
 * no scope rather than a scope of "Web Application Penetration Testing".
 */
function findTestingType(name) {
  const lower = name.toLowerCase();
  const matches = [];

  for (const { phrase, type, methodology, notFollowedBy } of PHRASES) {
    const needle = phrase.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      // Word boundary both sides: "Client ExternalSystem" is not an External test.
      if (isWordChar(lower[i - 1]) || isWordChar(lower[end])) continue;
      if (notFollowedBy && notFollowedBy.test(name.slice(end))) continue;
      matches.push({ type, start: i, end, length: needle.length, methodology });
    }
  }

  if (!matches.length) return null;

  const methodologies = matches.filter(m => m.methodology);
  const pool = methodologies.length ? methodologies : matches;
  const best = pool.reduce((a, b) => {
    if (b.end !== a.end) return b.end > a.end ? b : a;
    return b.length > a.length ? b : a;
  });

  const recognisedEnd = matches.reduce((max, m) => (m.end > max ? m.end : max), best.end);
  return { type: best.type, start: best.start, end: best.end, recognisedEnd };
}

// Splits on pipes and spaced hyphens, so hyphenated names ("Smith-Jones Ltd") stay
// whole. Both separators are treated alike — deal names mix them freely.
function segments(name) {
  return String(name || '').split(/\s+-\s+|\|/).map(s => s.trim()).filter(Boolean);
}

// True when a segment clearly describes the work rather than the client: it either
// IS a canonical type, or contains one of the unambiguous phrases above.
function looksLikeType(segment) {
  const text = (segment || '').trim();
  if (!text) return false;
  if (CANONICAL_NAMES.some(t => t.toLowerCase() === text.toLowerCase())) return true;
  return STRONG_HINTS.some(h => containsPhrase(text, h));
}

/**
 * Recovers the client from a name whose FIRST segment describes the testing type —
 * a name entered in the wrong order, e.g.
 *   "Black Box Pen Test - Brask - Black Box Web Application Penetration Testing"
 * A correctly-entered name starts with the client, so this only engages when the
 * leading segment is clearly a testing type. Returns null when it doesn't apply,
 * leaving the normal rules in charge.
 */
function recoverMisorderedClient(name) {
  const segs = segments(name);
  if (segs.length < 2 || !looksLikeType(segs[0])) return null;

  // First segment that doesn't clearly describe the work is the client. If every
  // segment reads as a type ("Black Box - Grey Box"), don't guess.
  const client = segs.find(s => !looksLikeType(s));
  if (!client) return null;

  return {
    client_name: client,
    warning: `Task name looks out of order — "${segs[0]}" reads like a testing type, `
      + `so "${client}" was used as the client name.`,
  };
}

// The client is the first segment of the name: everything before the first '|' or
// spaced hyphen that precedes the testing type. Requiring whitespace around the
// hyphen keeps "Smith-Jones Ltd" intact. With no separator at all we fall back to
// the text immediately before the type, so "Acme Corp-External" still yields
// "Acme Corp".
function clientFrom(name, typeStart) {
  const head = typeStart == null ? name : name.slice(0, typeStart);
  const cuts = [head.indexOf('|'), head.search(/\s-\s/)].filter(i => i !== -1);
  if (cuts.length) return head.slice(0, Math.min(...cuts)).trim();
  return head.replace(/[\s\-|,:]+$/, '').trim();
}

// Whatever trails the testing type — the per-target qualifier in deal names like
// "… - Application Penetration Testing- Money Guru". It keeps two same-type
// engagements for one client distinguishable in Plextrac (their reports would
// otherwise both be named "Web App | August 2026" and the second would be dropped
// by the duplicate check in pipeline/plextrac-report.js).
function scopeFrom(name, typeEnd) {
  if (typeEnd == null) return null;
  const tail = name.slice(typeEnd)
    .replace(/^[\s\-|:,–—]+/, '')
    .replace(/[\s\-|:,]+$/, '')
    .trim();
  if (!tail || tail.length > MAX_SCOPE_LENGTH) return null;
  return tail;
}

/**
 * Parses a ClickUp task name into { client_name, testing_type, scope }, plus an
 * optional `warning` when the name looked mis-entered and had to be interpreted.
 *
 * Handles the hand-written format ("Client Name | Testing Type") and the HubSpot
 * deal names the ClickUp automation creates, which carry the deal title between the
 * client and the service:
 *
 *   "Quint - Web App Testing (Money Guru) - Application Penetration Testing- Money Guru"
 *     → { client_name: 'Quint', testing_type: 'Web App', scope: 'Money Guru' }
 *
 * The client name is never allowed to be a testing type: if the name puts the type
 * first, the client is recovered from the remaining segments and flagged with a
 * warning so someone can fix the task name.
 *
 * `testing_type` is always a canonical name from config/testing-types.js, or
 * 'Unknown' when the name contains no recognised service. Unknown deliberately
 * aborts the create pipeline (pipeline/index.js) — a name we can't classify must
 * not be turned into a Plextrac client and report on a guess.
 */
function parseTaskName(rawName) {
  const name = (rawName || '').trim();
  const match = findTestingType(name);
  const testing_type = match ? match.type : 'Unknown';

  // A misordered name's trailing text is the client, not a scope qualifier, so the
  // recovered branch never carries a scope.
  const misordered = recoverMisorderedClient(name);
  if (misordered) {
    return {
      client_name: misordered.client_name,
      testing_type,
      scope: null,
      warning: misordered.warning,
    };
  }

  return {
    client_name: clientFrom(name, match ? match.start : null),
    testing_type,
    scope: match ? scopeFrom(name, match.recognisedEnd) : null,
  };
}

module.exports = { parseTaskName, findTestingType };
