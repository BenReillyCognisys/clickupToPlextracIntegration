// QA-review pipeline: triggered when a Plextrac report moves to "ready for QA".
//
// Flow:
//   1. Enable Plextrac change-tracking (best-effort; see change-tracking.js).
//   2. Review + correct the executive summary (formatting, client name,
//      de-jargon, flag incomplete sentences).
//   3. Review + correct each finding (formatting, client name, flag incomplete
//      sentences — NOT de-jargon: findings are for a technical audience).
//   4. Disable Plextrac change-tracking.
//   5. Log every change to the log file and post a summary to Slack.

const api = require('../../lib/plextrac-api');
const log = require('../../lib/logger');
const tracking = require('./change-tracking');
const { runChecks } = require('./checks');
const fields = require('./report-fields');

const MAX_FINDINGS = Number(process.env.QA_MAX_FINDINGS || 200);

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

  await tracking.enable(clientId, reportId);

  try {
    // ── Executive summary ─────────────────────────────────────────────────────
    const execSegments = fields.getExecutiveSummarySegments(report);
    if (execSegments.length) {
      let updatedReport = report;
      const changedRoots = new Set();
      for (const seg of execSegments) {
        const result = await runChecks(seg.text, { label: seg.label, clientName, isExecutiveSummary: true });
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

  postSlackSummary(mapping, clientId, reportId, applied, flags);

  log.info('QA review complete', {
    report_id: reportId, changes_applied: applied.length, flags_raised: flags.length,
  });

  return { applied, flags };
}

function postSlackSummary(mapping, clientId, reportId, applied, flags) {
  const base = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
  const url = `${base}/client/${clientId}/report/${reportId}`;
  const title = mapping.task_name || `Report ${reportId}`;

  const lines = [`*QA review complete* — <${url}|${title}>`,
    `${applied.length} change(s) applied, ${flags.length} item(s) flagged.`];

  if (applied.length) {
    lines.push('', '*Changes applied:*');
    for (const c of applied.slice(0, 40)) {
      lines.push(`• [${c.label}] _${c.type}_: "${truncate(c.before)}" → "${truncate(c.after)}"`);
    }
    if (applied.length > 40) lines.push(`…and ${applied.length - 40} more (see log file).`);
  }

  if (flags.length) {
    lines.push('', '*Flagged for author (not auto-changed):*');
    for (const f of flags.slice(0, 20)) {
      lines.push(`• [${f.label}] ${f.issue}: "${truncate(f.sentence)}"`);
    }
    if (flags.length > 20) lines.push(`…and ${flags.length - 20} more (see log file).`);
  }

  log.notifyQA(lines.join('\n'));
}

module.exports = { runQaReview };
