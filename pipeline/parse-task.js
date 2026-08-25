const TESTING_TYPES = require('../config/testing-types');

// Every phrase we know how to recognise, flattened from config/testing-types.js.
// The canonical name is itself a phrase (that's how "Acme | Grey Box" is matched);
// `notFollowedBy` only ever guards that bare canonical phrase, never an alias.
const PHRASES = TESTING_TYPES.flatMap(({ type, aliases = [], bareNotFollowedBy = null }) => [
  { phrase: type, type, notFollowedBy: bareNotFollowedBy },
  ...aliases.map(phrase => ({ phrase, type, notFollowedBy: null })),
]);

// Longest scope qualifier we'll carry into a report name — anything beyond this is
// prose, not a scope, and would make the Plextrac report name unreadable.
const MAX_SCOPE_LENGTH = 60;

const isWordChar = (ch) => ch != null && /[a-z0-9]/i.test(ch);

/**
 * Finds the testing type inside a task name.
 *
 * Deal names arrive as "Client - Deal name - Service" (with '|' and '-' mixed
 * freely), so the service can't be found by splitting on a separator — we search
 * the whole name for a known phrase instead. The match that ENDS last wins, since
 * the service is the tail of the name; ties go to the longer phrase, so
 * "Mobile Device Application Penetration Testing" beats the shorter
 * "Application Penetration Testing" that sits inside it.
 *
 * Returns { type, start, end } or null when nothing is recognised.
 */
function findTestingType(name) {
  const lower = name.toLowerCase();
  let best = null;

  for (const { phrase, type, notFollowedBy } of PHRASES) {
    const needle = phrase.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      // Word boundary both sides: "Client ExternalSystem" is not an External test.
      if (isWordChar(lower[i - 1]) || isWordChar(lower[end])) continue;
      if (notFollowedBy && notFollowedBy.test(name.slice(end))) continue;
      const better = !best || end > best.end || (end === best.end && needle.length > best.length);
      if (better) best = { type, start: i, end, length: needle.length };
    }
  }

  return best ? { type: best.type, start: best.start, end: best.end } : null;
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
 * Parses a ClickUp task name into { client_name, testing_type, scope }.
 *
 * Handles both the hand-written format ("Client Name | Testing Type") and the
 * HubSpot deal names the ClickUp automation creates, which carry the deal title
 * between the client and the service:
 *
 *   "Quint - Web App Testing (Money Guru) - Application Penetration Testing- Money Guru"
 *     → { client_name: 'Quint', testing_type: 'Web App', scope: 'Money Guru' }
 *
 * `testing_type` is always a canonical name from config/testing-types.js, or
 * 'Unknown' when the name contains no recognised service. Unknown deliberately
 * aborts the create pipeline (pipeline/index.js) — a name we can't classify must
 * not be turned into a Plextrac client and report on a guess.
 */
function parseTaskName(rawName) {
  const name = (rawName || '').trim();
  const match = findTestingType(name);

  return {
    client_name: clientFrom(name, match ? match.start : null),
    testing_type: match ? match.type : 'Unknown',
    scope: match ? scopeFrom(name, match.end) : null,
  };
}

module.exports = { parseTaskName, findTestingType };
