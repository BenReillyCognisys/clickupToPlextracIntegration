// Plextrac report-level change tracking.
//
// Plextrac controls "track changes" for a report via the boolean `isTrackChanges`
// field on the report object: true = track changes across all rich-text fields,
// false = off at the report level (per-field default).
// Ref: https://docs.plextrac.com/.../object-structures/report-object
//
// We set it true before editing and false again once the QA review completes,
// using the standard report update endpoint (PUT /client/{id}/report/{id}).
//
// On by default. Set PLEXTRAC_CHANGE_TRACKING_ENABLED=false to opt out (the
// internal audit log — log file + Slack — records every change regardless).

const api = require('../../lib/plextrac-api');
const log = require('../../lib/logger');

const DISABLED = String(process.env.PLEXTRAC_CHANGE_TRACKING_ENABLED).toLowerCase() === 'false';

async function setTracking(clientId, reportId, on) {
  if (DISABLED) {
    log.info('Plextrac change-tracking toggle skipped (PLEXTRAC_CHANGE_TRACKING_ENABLED=false)', {
      desired_state: on ? 'on' : 'off', report_id: reportId,
    });
    return false;
  }

  try {
    // Partial update — merges, so it only touches isTrackChanges.
    await api.updateReport(clientId, reportId, { isTrackChanges: on });
    log.info('Plextrac change-tracking toggled', { state: on ? 'on' : 'off', report_id: reportId });
    return true;
  } catch (err) {
    // Never abort the QA run because tracking failed — the internal audit log
    // still records every change.
    log.error('Plextrac change-tracking toggle failed (continuing with internal audit log)', {
      reason: err.message, state: on ? 'on' : 'off', report_id: reportId,
    });
    return false;
  }
}

const enable = (clientId, reportId) => setTracking(clientId, reportId, true);
const disable = (clientId, reportId) => setTracking(clientId, reportId, false);

module.exports = { enable, disable };
