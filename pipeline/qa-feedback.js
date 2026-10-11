// Pentest QA feedback: when a QA reviewer finishes their round, they're asked to rate
// the report on a private form in the secure portal (SFE).
//
//   first round done  — the report moves Ready For Review → In Review; whoever moved it
//                       did the first QA and rates the report;
//   second round done — the report moves In Review → Approved; whoever approved it did
//                       the second QA and rates the report and the first QA.
//
// Only a report moving forward asks: one sent back (to Draft or an earlier round) does
// not. "Forward" is judged from the QA queue entry as it was before this change (the
// round it was in), so the webhook reads it before updating the queue.
//
// Once per round: a report can go through a round of QA more than once (sent back and
// resubmitted). Only the first time it leaves each round asks for feedback — recorded
// for good in lib/qa-feedback-store.js — and the portal also never makes a second form
// for the same report and round.
//
// The portal makes (or returns) the reviewer's form and its link; the link goes to the
// reviewer alone by Slack DM, and DeliveryFlow shows it to them too (their pending
// forms, routes/deliveryflow-pt-management.js). The answers are CONFIDENTIAL to PT
// Management: they live in the portal and only DeliveryFlow's PT Management section
// reads them. Nothing here ever posts to a channel.
//
// Best-effort: every failure is logged and swallowed — it must never disturb the rest
// of the status webhook.

const portal = require('../lib/secure-portal-api');
const users = require('../lib/plextrac-users');
const submissionStore = require('../lib/qa-submission-store');
const requests = require('../lib/qa-feedback-store');
const slack = require('../lib/slack');
const people = require('../lib/slack-people');
const log = require('../lib/logger');

const ROUND_NAME = { first: 'first-round', second: 'second-round' };

// The round a report was in before this change, if it's the one being completed —
// otherwise the change isn't a step forward out of that round.
function completesRound(round, prior) {
  if (!prior) return true; // not in the queue (e.g. queued before this existed): trust the status
  return prior.stage === round;
}

async function personFor(cuid, map) {
  if (!cuid) return null;
  const user = map.get(cuid);
  return { cuid, name: user?.name || null, email: user?.email || null };
}

const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dmText({ round, clientName, reportName, url }) {
  const report = [clientName, reportName].filter(Boolean).join(' - ') || 'the report';
  return `:memo: Thanks for doing the ${ROUND_NAME[round]} QA on *${slackEscape(report)}*. ` +
    `Please rate the report here: <${url}|Pentest QA feedback>\n` +
    '_It takes a couple of minutes. Your answers go only to PT Management; the author won\'t see them._';
}

/**
 * Asks the portal for the reviewer's form and sends them the link. `prior` is the QA
 * queue entry before this status change. Resolves to { url, created } or null when no
 * form was made (not a forward move, the reviewer can't be identified, or a failure).
 */
async function requestQaFeedback({
  round, actorCuid, prior, reportId, reportCuid, clientName, reportName, reportUrl, engagementId,
}) {
  if (!completesRound(round, prior)) {
    log.info('QA feedback: not asked — the report did not move forward out of this round', {
      report_id: reportId, round, prior_stage: prior?.stage ?? null,
    });
    return null;
  }
  if (!actorCuid) {
    log.warn('QA feedback: not asked — Plextrac did not say who finished the QA', { report_id: reportId, round });
    return null;
  }

  try {
    const map = await users.cuidMap();
    const reviewer = await personFor(actorCuid, map);
    if (!reviewer?.email) {
      log.warn('QA feedback: not asked — the QA reviewer has no email in Plextrac', { report_id: reportId, round, actor_cuid: actorCuid });
      return null;
    }

    // Who wrote it: whoever submitted it for QA (moved it into the first round).
    let authorCuid = prior?.stage === 'first' ? prior.stage_actor_cuid : null;
    if (!authorCuid) authorCuid = (await submissionStore.actorFor(reportId).catch(() => null)) || null;
    const author = await personFor(authorCuid, map);
    // Second round: the first QA is whoever moved it into the second round.
    const firstReviewer = round === 'second' && prior?.stage === 'second'
      ? await personFor(prior.stage_actor_cuid, map)
      : null;

    // Only the first time the report leaves this round asks: a report sent back and
    // resubmitted, then passed again, gets no second form.
    if (!(await requests.claim(reportId, round, reviewer.email))) {
      log.info('QA feedback: not asked — feedback was already asked for this round of this report', {
        report_id: reportId, round, reviewer: reviewer.email,
      });
      return null;
    }

    let res;
    try {
      res = await portal.createQaFeedback({
        round, reportId, reportCuid, clientName, reportName, reportUrl,
        engagementId: engagementId || null, reviewer, author, firstReviewer,
      });
    } catch (err) {
      // Nothing was made, so the round can still be asked about next time.
      await requests.release(reportId, round).catch(() => {});
      throw err;
    }
    log.info('QA feedback form ready', { report_id: reportId, round, reviewer: reviewer.email, created: res.created });

    if (res.created) {
      const slackId = await people.slackIdForEmail(reviewer.email);
      if (slackId) {
        await slack.postMessage(slackId, dmText({ round, clientName, reportName, url: res.url }))
          .catch((err) => log.warn('QA feedback: could not DM the reviewer', { reason: err.message, report_id: reportId, reviewer: reviewer.email }));
      } else {
        log.warn('QA feedback: reviewer not found in Slack — link only shown in DeliveryFlow', { report_id: reportId, reviewer: reviewer.email });
      }
    }
    return { url: res.url, created: res.created };
  } catch (err) {
    log.error('QA feedback: could not create the form', { reason: err.message, report_id: reportId, round });
    return null;
  }
}

module.exports = { requestQaFeedback, completesRound, dmText };
