// QA-review pipeline: triggered when a Plextrac report moves to "ready for QA".
//
// Flow:
//   1. Post the "ready for first round of QA" parent message to #pt-first-round-qa
//      up front (so the channel is notified the moment review begins).
//   2. Enable Plextrac change-tracking (best-effort; see change-tracking.js).
//   3. Review + correct the executive summary (formatting, client name,
//      de-jargon, flag incomplete sentences).
//   4. Review + correct each finding (formatting, client name, flag incomplete
//      sentences — NOT de-jargon: findings are for a technical audience).
//   5. Log every change to the log file, then reply IN THE PARENT'S THREAD with
//      the AI QA feedback (the changes + flags) once the review has fully
//      completed.

const api = require('../../lib/plextrac-api');
const log = require('../../lib/logger');
const slack = require('../../lib/slack');
const tracking = require('./change-tracking');
const { runChecks } = require('./checks');
const fields = require('./report-fields');

const MAX_FINDINGS = Number(process.env.QA_MAX_FINDINGS || 200);
// #pt-first-round-qa channel id (override via env).
const FIRST_ROUND_QA_CHANNEL = process.env.SLACK_FIRST_ROUND_QA_CHANNEL || 'C0B9D6487HR';

function truncate(s, n = 80) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// Tolerantly pull a finding's id out of whatever shape the list returns.
function findingId(item) {
  return item?.id ?? item?.flaw_id ?? (Array.isArray(item?.data) ? item.data[0] : undefined);
}

/**
 * @param {object} mapping  Mongo mapping: { plextrac_client_id, plextrac_report_id, task_name }
 */
async function runQaReview(mapping) {
  const clientId = mapping.plextrac_client_id;
  const reportId = mapping.plextrac_report_id;
  const applied = [];
  const flags = [];

  log.info('QA review started', { client_id: clientId, report_id: reportId, task: mapping.task_name });

  // Fetch the report up front so we can gate on status BEFORE enabling tracking
  // or spending any AI calls.
  const report = await api.getReport(clientId, reportId);

  // Optional status gate: only run when the report is in the configured QA status.
  // Leave PLEXTRAC_QA_STATUS unset to act on every delivery of this webhook.
  const qaStatus = process.env.PLEXTRAC_QA_STATUS;
  if (qaStatus && report?.status && report.status !== qaStatus) {
    log.info('QA review skipped — report not in QA status', {
      report_id: reportId, status: report.status, expected: qaStatus,
    });
    return { applied: [], flags: [], skipped: true };
  }

  // Resolve the canonical client name for the client-name check.
  let clientName = mapping.client_name;
  try {
    const clientRecord = await api.getClient(clientId);
    clientName = fields.clientNameFromRecord(clientRecord, clientName);
  } catch (err) {
    log.warn('Could not fetch client record — falling back to mapping name', { reason: err.message });
  }

  // Announce up front, BEFORE the (slower) review runs: post the "ready for first
  // round of QA" parent message now and keep its thread anchor (ts). The AI QA
  // feedback is posted as a threaded reply once the review has fully completed.
  const base = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
  const clientUrl = `${base}/client/${clientId}`;
  const reportUrl = `${base}/client/${clientId}/report/${reportId}`;
  const reportName = report?.name || mapping.task_name || `Report ${reportId}`;
  const threadTs = await postFirstRoundParent({ clientName, clientUrl, reportName, reportUrl });

  await tracking.enable(clientId, reportId);

  try {
    // ── Executive summary ─────────────────────────────────────────────────────
    const execSegments = fields.getExecutiveSummarySegments(report);
    if (execSegments.length) {
      let updatedReport = report;
      const changedRoots = new Set();
      for (const seg of execSegments) {
        const result = await runChecks(seg.text, {
          label: seg.label, clientName, isExecutiveSummary: true,
          clientNameOnly: seg.clientNameOnly, noDejargon: seg.noDejargon,
        });
        applied.push(...result.applied);
        flags.push(...result.flags);
        if (result.changed) {
          updatedReport = fields.setByPath(updatedReport, seg.path, result.finalText);
          changedRoots.add(seg.path.split(/[.[]/)[0]); // e.g. "exec_summary"
        }
      }
      if (changedRoots.size) {
        // Partial update — send only the changed top-level field(s). This avoids
        // clobbering other report fields (notably isTrackChanges, which the
        // tracking toggle just set) by PUT-ing the whole report object.
        const payload = {};
        for (const root of changedRoots) payload[root] = updatedReport[root];
        try {
          await api.updateReport(clientId, reportId, payload);
          log.info('Executive summary updated in Plextrac', { report_id: reportId, fields: [...changedRoots] });
        } catch (err) {
          log.error('Failed to write executive summary changes', { reason: err.message, report_id: reportId });
        }
      }
    } else {
      log.warn('No executive-summary segment found — skipping exec summary checks', { report_id: reportId });
    }

    // ── Findings ──────────────────────────────────────────────────────────────
    let findingsList = [];
    try {
      const raw = await api.listReportFindings(clientId, reportId);
      findingsList = Array.isArray(raw) ? raw : (raw?.data || []);
    } catch (err) {
      log.error('Failed to list findings — skipping findings checks', { reason: err.message, report_id: reportId });
    }

    if (findingsList.length > MAX_FINDINGS) {
      log.warn('Findings count exceeds QA_MAX_FINDINGS — processing first N only', {
        total: findingsList.length, limit: MAX_FINDINGS,
      });
      findingsList = findingsList.slice(0, MAX_FINDINGS);
    }

    for (const item of findingsList) {
      const id = findingId(item);
      if (id == null) continue;

      let finding;
      try {
        finding = await api.getFinding(clientId, reportId, id);
      } catch {
        finding = item; // fall back to the list item if the detail fetch fails
      }

      const segments = fields.getFindingSegments(finding);
      let updatedFinding = finding;
      let dirty = false;
      for (const seg of segments) {
        const result = await runChecks(seg.text, {
          label: `finding:${id}:${seg.label}`,
          clientName,
          isExecutiveSummary: false,
        });
        applied.push(...result.applied);
        flags.push(...result.flags);
        if (result.changed) {
          updatedFinding = fields.setByPath(updatedFinding, seg.path, result.finalText);
          dirty = true;
        }
      }

      if (dirty) {
        try {
          await api.updateFinding(clientId, reportId, id, updatedFinding);
          log.info('Finding updated in Plextrac', { report_id: reportId, finding_id: id });
        } catch (err) {
          log.error('Failed to write finding changes', { reason: err.message, report_id: reportId, finding_id: id });
        }
      }
    }
  } catch (err) {
    // Change tracking is intentionally left ON after the run — we never toggle it
    // off, so the report keeps tracking subsequent edits too.
    log.error('QA review encountered an error mid-run', { reason: err.message, report_id: reportId });
  }

  // ── Audit: log every change + post a Slack summary ──────────────────────────
  for (const c of applied) {
    log.info('QA change applied', {
      type: c.type, field: c.label, before: truncate(c.before, 120), after: truncate(c.after, 120),
    });
  }
  for (const f of flags) {
    log.warn('QA flag (needs author attention)', { type: f.type, field: f.label, sentence: truncate(f.sentence, 120), issue: f.issue });
  }

  // Now that QA has fully completed, post the AI feedback as a threaded reply to
  // the parent message sent at the start.
  await postFirstRoundReply({ threadTs, reportUrl, applied, flags });

  log.info('QA review complete', {
    report_id: reportId, changes_applied: applied.length, flags_raised: flags.length,
  });

  return { applied, flags };
}

// Escapes the three characters that are special in Slack mrkdwn link text.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds the parent message with the client and report names hyperlinked.
//   Client: <client> - <report> ready for first round of QA
function buildFirstRoundMessage({ clientName, clientUrl, reportName, reportUrl }) {
  const client = clientUrl ? `<${clientUrl}|${slackEscape(clientName)}>` : slackEscape(clientName);
  const report = reportUrl ? `<${reportUrl}|${slackEscape(reportName)}>` : slackEscape(reportName);
  return `Client: ${client} - ${report} ready for first round of QA`;
}

// Posts the "ready for first round of QA" parent message to #pt-first-round-qa up
// front (before the review runs). Returns the message `ts` to thread the feedback
// reply against, or null if the post failed (the review still proceeds).
async function postFirstRoundParent({ clientName, clientUrl, reportName, reportUrl }) {
  const parent = buildFirstRoundMessage({ clientName, clientUrl, reportName, reportUrl });
  try {
    return await slack.postMessage(FIRST_ROUND_QA_CHANNEL, parent);
  } catch (err) {
    log.error('Failed to post first-round QA message to Slack', { reason: err.message });
    return null;
  }
}

// Posts the AI QA feedback once the review is complete — as a reply in the parent
// message's thread. If the parent post failed (no threadTs), it falls back to a
// standalone message so the feedback is never silently lost.
async function postFirstRoundReply({ threadTs, reportUrl, applied, flags }) {
  const body = buildThreadBody(applied, flags, reportUrl);
  try {
    if (threadTs) await slack.postReply(FIRST_ROUND_QA_CHANNEL, threadTs, body);
    else await slack.postMessage(FIRST_ROUND_QA_CHANNEL, body);
  } catch (err) {
    log.error('Failed to post first-round QA feedback to Slack', { reason: err.message });
  }
}

// Builds the threaded reply body listing the AI QA feedback.
function buildThreadBody(applied, flags, url) {
  const lines = [
    `*AI QA feedback* — <${url}|open report>`,
    `${applied.length} change(s) applied, ${flags.length} item(s) flagged.`,
  ];

  if (applied.length) {
    lines.push('', '*Changes applied:*');
    for (const c of applied.slice(0, 50)) {
      lines.push(`• [${c.label}] _${c.type}_: "${truncate(c.before)}" → "${truncate(c.after)}"`);
    }
    if (applied.length > 50) lines.push(`…and ${applied.length - 50} more (see log file).`);
  }

  if (flags.length) {
    lines.push('', '*Flagged for author (not auto-changed):*');
    for (const f of flags.slice(0, 30)) {
      lines.push(`• [${f.label}] ${f.issue}: "${truncate(f.sentence)}"`);
    }
    if (flags.length > 30) lines.push(`…and ${flags.length - 30} more (see log file).`);
  }

  if (!applied.length && !flags.length) lines.push('', 'No changes or issues found.');

  return lines.join('\n');
}

module.exports = { runQaReview, buildThreadBody, buildFirstRoundMessage };
