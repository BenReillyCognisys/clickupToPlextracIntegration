// Finding Cognisys people in Slack from their Plextrac email, for @-mentions.
//
// Plextrac and Slack don't always hold someone under the same Cognisys domain
// (karan.luniyal@cognisys.co.uk in Plextrac, karan.luniyal@cognisys.group in Slack), so
// the other domain is tried too. Ids found are kept for the life of the process; a miss
// is looked up again next time (someone may have joined Slack since).

const slack = require('./slack');
const PERMS = require('../config/report-status-permissions');

const COGNISYS_DOMAINS = ['cognisys.group', 'cognisys.co.uk'];
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The email, then the same mailbox on the other Cognisys domain. */
function emailsToTry(email) {
  const [local, domain] = norm(email).split('@');
  if (!local || !domain) return [];
  const others = COGNISYS_DOMAINS.includes(domain) ? COGNISYS_DOMAINS.filter((d) => d !== domain) : [];
  return [norm(email), ...others.map((d) => `${local}@${d}`)];
}

/** Do these two emails belong to the same person (same mailbox, either Cognisys domain)? */
const samePerson = (a, b) => Boolean(a && b) && emailsToTry(a).includes(norm(b));

const found = new Map(); // email -> Slack id

/** The Slack user id for a Plextrac email, or null. Never throws. */
async function slackIdForEmail(email) {
  if (!email) return null;
  if (found.has(norm(email))) return found.get(norm(email));
  for (const candidate of emailsToTry(email)) {
    const id = await slack.lookupUserIdByEmail(candidate).catch(() => null);
    if (id) {
      found.set(norm(email), id);
      return id;
    }
  }
  return null;
}

/**
 * Slack ids of the people who can publish (config/report-status-permissions.js),
 * leaving out `except` — whoever released the report, so the release announcement
 * tags the other publisher(s), not the person who did it. Anyone Slack can't find is
 * left out.
 */
async function publisherMentions({ except = null } = {}) {
  const emails = PERMS.PUBLISHERS.filter((email) => !samePerson(email, except));
  const ids = await Promise.all(emails.map(slackIdForEmail));
  return [...new Set(ids.filter(Boolean))];
}

function clearCache() {
  found.clear();
}

module.exports = { emailsToTry, samePerson, slackIdForEmail, publisherMentions, clearCache };
