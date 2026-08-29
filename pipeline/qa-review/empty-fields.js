// The empty-custom-field check, shared by all three QA rounds.
//
// A report's custom fields (Team Name, Author 1, Author 1 Title, Author 1 Email, …)
// fill the template's %%...%% placeholders, so one left blank leaves a hole in the
// rendered report. Every round checks them and reports any that are empty to the
// person who moved the report into that round — the one who can fix it.
//
// First round folds the result into its bigger threaded feedback body (see
// pipeline/qa-review/index.js); the second-round and release announcements post it
// as a reply in their own message's thread via postEmptyFieldsNotice. Which labels
// are exempt lives in config/optional-report-fields.js.

const slack = require('../../lib/slack');
const users = require('../../lib/plextrac-users');
const log = require('../../lib/logger');
const { findEmptyCustomFields } = require('./report-fields');

// Escapes the three characters that are special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolves the actor who moved the report into this round (the webhook's `actorCuid`
// — whoever submitted it for QA, passed it to second round, or released it) to a
// Slack @-mention. Degrades gracefully: cuid → Slack id gives a real "<@U…>" ping; if
// only the Plextrac record resolves we use their name (no ping); if nothing resolves
// we return null and the message simply names no one.
async function resolveActorMention(actorCuid) {
  if (!actorCuid) return null;

  let user = null;
  try {
    const map = await users.cuidMap();
    user = map.get(actorCuid) || null;
  } catch (err) {
    log.warn('Could not resolve QA actor from cuid for empty-field notice', {
      reason: err.message, actor_cuid: actorCuid,
    });
  }
  if (!user) return null;

  if (user.email) {
    try {
      const id = await slack.lookupUserIdByEmail(user.email);
      if (id) return `<@${id}>`;
    } catch (err) {
      log.warn('Slack lookup failed for QA actor — falling back to their name', {
        reason: err.message, actor_cuid: actorCuid,
      });
    }
  }
  return slackEscape(users.displayName(user, actorCuid));
}

// Per-round heading for the empty-field list. In the first two rounds the report is
// still in QA, so it reads as "fix this before it goes out". By the release round it
// has already been published with the gaps in it — that is a different, worse thing,
// so the wording says so plainly rather than sounding like a routine to-do.
function heading(round, who) {
  if (round === 'released') {
    return `:rotating_light: *Released with empty custom fields* — ${who}this report has `
      + 'ALREADY GONE OUT with the fields below blank. Please fill them in and re-issue it:';
  }
  return `*Empty custom fields* — ${who}please fill these in:`;
}

// The Slack mrkdwn lines listing the empty fields, led by a blank line so they can be
// appended to a longer body. Empty array when there is nothing to report. Pure.
function emptyFieldsLines(emptyFields, mention, round = 'first') {
  if (!emptyFields || !emptyFields.length) return [];
  const who = mention ? `${mention} ` : '';
  return [
    '',
    heading(round, who),
    ...emptyFields.map(label => `• ${slackEscape(label)}`),
  ];
}

/**
 * Checks a report's custom fields and, if any required one is empty, posts the list as
 * a reply in the round's announcement thread, @-mentioning the actor who moved the
 * report into that round. Used by the second-round and release announcements — the
 * first round folds the same lines into its own feedback body instead.
 *
 * Best-effort: every failure is logged and swallowed so it never disrupts the caller.
 *
 * @returns {Promise<string[]>} the labels of the empty fields (empty when none)
 */
async function postEmptyFieldsNotice({ report, channel, threadTs, actorCuid, reportId, round }) {
  const emptyFields = findEmptyCustomFields(report);
  if (!emptyFields.length) return [];

  for (const label of emptyFields) {
    log.warn('QA flag — report custom field is empty', { field: label, report_id: reportId, round });
  }

  const mention = await resolveActorMention(actorCuid);
  const body = emptyFieldsLines(emptyFields, mention, round).join('\n').trim();
  try {
    // No thread anchor (the announcement failed to post) — send it standalone rather
    // than lose it.
    if (threadTs) await slack.postReply(channel, threadTs, body);
    else await slack.postMessage(channel, body);
    log.info('Empty custom fields reported', { report_id: reportId, round, count: emptyFields.length });
  } catch (err) {
    log.error('Failed to post empty custom fields to Slack', {
      reason: err.message, report_id: reportId, round,
    });
  }
  return emptyFields;
}

module.exports = { resolveActorMention, emptyFieldsLines, postEmptyFieldsNotice };
