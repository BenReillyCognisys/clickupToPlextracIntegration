/**
 * DeliveryFlow → break.services: the PT QA queue page.
 *
 *   GET  /api/deliveryflow/qa-queue?viewer=<email>      reports in first- and
 *                                                        second-round QA, with claims,
 *                                                        due dates, and what the viewer
 *                                                        may claim
 *   POST /api/deliveryflow/qa-queue/:reportId/claim     { stage, name, email }
 *   POST /api/deliveryflow/qa-queue/:reportId/release   { stage, name, email, override }
 *
 * The queue itself is the one the Plextrac webhook keeps for /reportqueue
 * (lib/qa-queue-store.js), so the page, Slack and Plextrac always agree. A consultant
 * claims a report for the round it is in; everyone still sees it, but nobody else can
 * claim it. When Plextrac moves the report to the next round the claim is cleared and
 * anyone may claim it again. `stage` is the round the person was looking at, so a claim
 * from a page that hadn't caught up with a move is refused (409 moved).
 *
 * Anyone may claim a first-round report; second-round reports only the reviewers in
 * config/qa-queue.js (403 not_reviewer otherwise). A report that moves on unclaimed
 * simply arrives unclaimed in the next round.
 *
 * dueDate: when a ClickUp-era report is due (lib/qa-queue-due.js). DeliveryFlow fills
 * in its own engagements' report due dates and orders the list soonest-due first.
 *
 * DeliveryFlow signs in its own users and sends who is acting (name, email); it decides
 * who may release someone else's claim and says so with `override`. Each claim and
 * release is noted in the thread of that round's Slack announcement, when there is one.
 *
 * Authenticated with the DeliveryFlow shared secret in X-API-Key, as the other
 * /api/deliveryflow routes. Mounted ahead of the request log (index.js): the page
 * refreshes the list often, and claims and releases are logged here instead.
 */

const express = require('express');
const { requireDeliveryFlowKey } = require('../lib/deliveryflow-key-auth');
const qaQueue = require('../lib/qa-queue-store');
const { refreshDueDates } = require('../lib/qa-queue-due');
const { fillClientNames } = require('../lib/qa-queue-clients');
const { mayClaim, sameMailbox } = require('../config/qa-queue');
const store = require('../lib/deliveryflow-store');
const users = require('../lib/plextrac-users');
const slack = require('../lib/slack');
const log = require('../lib/logger');

const router = express.Router();

const STAGES = ['first', 'second'];
const ROUND = { first: 'first-round', second: 'second-round' };

const iso = (d) => (d ? new Date(d).toISOString() : null);

// Who moved the report into its round, by name. Best-effort: the user list is cached
// for an hour and a failure only loses the name.
async function actorNames(entries) {
  if (!entries.some((e) => e.stage_actor_cuid)) return new Map();
  try {
    const map = await users.cuidMap();
    return new Map(entries
      .filter((e) => e.stage_actor_cuid)
      .map((e) => [e.stage_actor_cuid, users.displayName(map.get(e.stage_actor_cuid), e.stage_actor_cuid)]));
  } catch (err) {
    log.warn('QA queue: could not resolve who moved reports into their round', { reason: err.message });
    return new Map();
  }
}

function toEntry(e, { engagements = new Map(), actors = new Map() } = {}) {
  return {
    reportId:       e.report_id,
    clientId:       e.client_id ?? null,
    clientName:     e.client_name || null,
    reportName:     e.report_name || `Report ${e.report_id}`,
    reportUrl:      e.report_url || null,
    stage:          e.stage,
    enteredAt:      iso(e.entered_at),
    stageEnteredAt: iso(e.stage_entered_at || e.entered_at),
    movedBy:        e.stage_actor_cuid ? (actors.get(e.stage_actor_cuid) || null) : null,
    engagementId:   engagements.get(String(e.report_id)) || null,
    dueDate:        e.due_date || null,
    claimedBy:      e.claimed_by?.name ? { name: e.claimed_by.name, email: e.claimed_by.email || null } : null,
    claimedAt:      e.claimed_by?.name ? iso(e.claimed_at) : null,
  };
}

// Parses { stage, name, email } (+ override) and the report id, or answers 400.
function parseAction(req, res) {
  const reportId = Number(req.params.reportId);
  const { stage, name, email, override } = req.body || {};
  if (!Number.isInteger(reportId) || reportId <= 0) {
    res.status(400).json({ ok: false, error: 'reportId must be a Plextrac report id' });
    return null;
  }
  if (!STAGES.includes(stage)) {
    res.status(400).json({ ok: false, error: `stage must be one of ${STAGES.join(', ')}`, field: 'stage' });
    return null;
  }
  const who = { name: String(name ?? '').trim().slice(0, 120), email: String(email ?? '').trim().toLowerCase().slice(0, 200) };
  if (!who.name || !/^[^\s@]+@[^\s@]+$/.test(who.email)) {
    res.status(400).json({ ok: false, error: 'name and email of the person acting are required', field: 'email' });
    return null;
  }
  return { reportId, stage, who, override: override === true };
}

// Notes a claim or release in the round's Slack thread. Fire-and-forget.
function noteInThread(entry, text) {
  if (!entry?.slack_channel || !entry?.slack_ts) return;
  slack.postReply(entry.slack_channel, entry.slack_ts, text).catch((err) =>
    log.warn('QA queue: could not note the claim in Slack', { reason: err.message, report_id: entry.report_id }));
}

const REFUSED = {
  not_found: [404, 'This report is no longer in the QA queue.'],
  moved:     [409, 'This report has moved to another round of QA. Refresh to see where it is now.'],
  claimed:   [409, 'Someone else has already claimed this report.'],
  not_reviewer: [403, 'Second-round QA can only be claimed by the second-round reviewers.'],
  not_yours: [403, 'Only the person who claimed this report can release it.'],
};

function refuse(res, result) {
  const [status, error] = REFUSED[result.reason] || [409, 'The report could not be changed.'];
  return res.status(status).json({ ok: false, reason: result.reason, error, entry: result.entry ? toEntry(result.entry) : null });
}

router.get('/', requireDeliveryFlowKey, async (req, res) => {
  try {
    const all = (await qaQueue.list()).filter((e) => STAGES.includes(e.stage));
    const [engagements, actors] = await Promise.all([
      store.findEngagementsByReportIds(all.map((e) => e.report_id)).catch((err) => {
        log.warn('QA queue: could not match reports to DeliveryFlow engagements', { reason: err.message });
        return new Map();
      }),
      actorNames(all),
      // Entries queued without a client name get it from Plextrac (once; it is saved).
      fillClientNames(all, (reportId, name, clientId) => qaQueue.setClientName(reportId, name, clientId)),
    ]);
    refreshDueDates(all, engagements);
    const viewer = String(req.query.viewer || '').trim().toLowerCase();
    res.json({
      ok: true,
      entries: all.map((e) => toEntry(e, { engagements, actors })),
      viewer: viewer ? { canClaim: { first: mayClaim('first', viewer), second: mayClaim('second', viewer) } } : null,
    });
  } catch (err) {
    log.error('QA queue: could not read the queue for DeliveryFlow', { reason: err.message });
    res.status(500).json({ ok: false, error: 'Could not read the QA queue' });
  }
});

router.post('/:reportId/claim', requireDeliveryFlowKey, async (req, res) => {
  const input = parseAction(req, res);
  if (!input) return;
  if (!mayClaim(input.stage, input.who.email)) {
    log.info('QA queue: claim refused', { report_id: input.reportId, stage: input.stage, by: input.who.email, reason: 'not_reviewer' });
    return refuse(res, { reason: 'not_reviewer', entry: await qaQueue.get(input.reportId).catch(() => null) });
  }
  try {
    const result = await qaQueue.claim({ reportId: input.reportId, stage: input.stage, by: input.who });
    if (!result.ok) {
      log.info('QA queue: claim refused', { report_id: input.reportId, stage: input.stage, by: input.who.email, reason: result.reason });
      return refuse(res, result);
    }
    if (!result.already) {
      log.info('QA queue: report claimed', { report_id: input.reportId, stage: input.stage, by: input.who.email });
      noteInThread(result.entry, `:raising_hand: *${input.who.name}* has claimed this report for ${ROUND[input.stage]} QA (DeliveryFlow).`);
    }
    res.json({ ok: true, entry: toEntry(result.entry) });
  } catch (err) {
    log.error('QA queue: claim failed', { reason: err.message, report_id: input.reportId });
    res.status(500).json({ ok: false, error: 'Could not claim the report' });
  }
});

router.post('/:reportId/release', requireDeliveryFlowKey, async (req, res) => {
  const input = parseAction(req, res);
  if (!input) return;
  try {
    const result = await qaQueue.release({
      reportId: input.reportId, stage: input.stage, by: input.who, override: input.override,
    });
    if (!result.ok) {
      log.info('QA queue: release refused', { report_id: input.reportId, stage: input.stage, by: input.who.email, reason: result.reason });
      return refuse(res, result);
    }
    if (result.released) {
      const own = sameMailbox(result.previous?.email, input.who.email);
      log.info('QA queue: claim released', {
        report_id: input.reportId, stage: input.stage, by: input.who.email, claimed_by: result.previous?.email,
      });
      noteInThread(result.entry, own
        ? `:leftwards_arrow_with_hook: *${input.who.name}* released their claim. This report is free to claim again.`
        : `:leftwards_arrow_with_hook: *${input.who.name}* released ${result.previous?.name ? `${result.previous.name}'s` : 'the'} claim. This report is free to claim again.`);
    }
    res.json({ ok: true, entry: toEntry(result.entry) });
  } catch (err) {
    log.error('QA queue: release failed', { reason: err.message, report_id: input.reportId });
    res.status(500).json({ ok: false, error: 'Could not release the claim' });
  }
});

module.exports = router;
module.exports.toEntry = toEntry;
