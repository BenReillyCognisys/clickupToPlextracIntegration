// Syncs a ClickUp task rename into Plextrac.
//
// The ClickUp project template creates each task as a placeholder ("Test Task"),
// which ClickBot then renames to "Client | Testing Type". taskCreated therefore
// fires before the real name exists (the create pipeline skips placeholder names —
// see pipeline/index.js), so for those projects the Plextrac client + report are
// actually created here, on the first meaningful rename.
//
// Later edits to an existing project's name are reflected too:
//   • testing type changed (e.g. Black Box → Grey Box) — the Plextrac report is
//     renamed to "<Testing Type> | Month Year" (name only; the existing template
//     and its content are left untouched).
//   • client name changed — the report is moved under the Plextrac client matching
//     the new name (found or created), leaving the old client as-is.
//
// Every Plextrac call is best-effort: a failure is logged (and, where a human needs
// to act, posted to Slack), never thrown, so one bad sync can't wedge the webhook.

const { parseTaskName } = require('./parse-task');
const { findOrCreateClient } = require('./plextrac-client');
const { buildReportName } = require('./plextrac-report');
const { runPipeline } = require('./index');
const api = require('../lib/plextrac-api');
const store = require('../lib/task-store');
const log = require('../lib/logger');

const PLEXTRAC_BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// Renames the Plextrac report to reflect the current testing type / start date.
// Returns true if the report was renamed, false if it was already correct or the
// rename failed (failures are logged). Name only — the template is left as-is.
async function syncReportName(clientId, reportId, testingType, startDateMs, taskName) {
  let currentName = null;
  try {
    const report = await api.getReport(clientId, reportId);
    currentName = report?.name ?? null;
  } catch (err) {
    log.error('Task rename — failed to fetch Plextrac report for name compare', {
      reason: err.message, client_id: clientId, report_id: reportId,
    });
    return false;
  }

  const newName = buildReportName(testingType, startDateMs);
  if (currentName != null && currentName.toLowerCase() === newName.toLowerCase()) {
    return false; // already reflects the current type/date
  }

  try {
    await api.updateReport(clientId, reportId, { name: newName });
  } catch (err) {
    log.error('Task rename — failed to rename Plextrac report', {
      reason: err.message, client_id: clientId, report_id: reportId,
    });
    return false;
  }

  const url = `${PLEXTRAC_BASE}/client/${clientId}/report/${reportId}`;
  log.info('Task rename — Plextrac report renamed', {
    client_id: clientId, report_id: reportId, old_name: currentName, new_name: newName, task: taskName,
  });
  log.notify(`ClickUp rename synced for "${taskName}" — report renamed from "${currentName}" to <${url}|${newName}>.`);
  return true;
}

// Ensures the report lives under the Plextrac client matching the (possibly new)
// client name. Resolves the target client (find or create); if it differs from the
// report's current client, moves the report under it. Returns
// { moved, clientId } — clientId is the client the report is under afterwards
// (unchanged from `currentClientId` when nothing moved or the move failed).
async function repointClient(currentClientId, reportId, newClientName, taskName) {
  let target;
  try {
    target = await findOrCreateClient(newClientName);
  } catch (err) {
    log.error('Task rename — failed to resolve target Plextrac client', {
      reason: err.message, client: newClientName, report_id: reportId,
    });
    return { moved: false, clientId: currentClientId };
  }

  if (String(target.clientId) === String(currentClientId)) {
    return { moved: false, clientId: currentClientId }; // same client — nothing to move
  }

  try {
    await api.moveReport(currentClientId, reportId, target.clientId);
  } catch (err) {
    // Leave the mapping pointing at the old client so the reverse (Plextrac →
    // ClickUp) webhook keeps working, and ask a human to move it.
    log.error('Task rename — failed to move report to new Plextrac client (manual move needed)', {
      reason: err.message, report_id: reportId, from_client: currentClientId, to_client: target.clientId,
    });
    log.notify(
      `ClickUp client renamed to "${newClientName}" but the Plextrac report (id ${reportId}) ` +
      `could not be moved automatically — please move it to the "${newClientName}" client manually.`
    );
    return { moved: false, clientId: currentClientId };
  }

  log.info('Task rename — report moved to new Plextrac client', {
    report_id: reportId, from_client: currentClientId, to_client: target.clientId, client: newClientName,
  });
  log.notify(`ClickUp client renamed — report (id ${reportId}) moved to Plextrac client "${newClientName}".`);
  return { moved: true, clientId: target.clientId };
}

// Entry point: handle a ClickUp task whose name has changed.
async function handleTaskRename(task) {
  const { client_name, testing_type } = parseTaskName(task.name);

  const mapping = await store.findByTaskId(task.id).catch(err => {
    log.error('Task rename — mapping lookup failed', { reason: err.message, task_id: task.id });
    return null;
  });

  // No report yet — the task was a placeholder / Unknown at creation and has now
  // been given its real name. Create the client + report now (runPipeline is
  // idempotent and re-parses the current name).
  if (!mapping) {
    log.info('Renamed task has no Plextrac report yet — running create pipeline', {
      task: task.name, task_id: task.id,
    });
    await runPipeline(task);
    return;
  }

  // An existing project renamed to something we can no longer classify: don't
  // clobber the live report name with a fallback. Leave it and flag it.
  if (testing_type === 'Unknown') {
    log.warn('Renamed task no longer resolves to a testing type — leaving existing report unchanged', {
      task: task.name, task_id: task.id, report_id: mapping.plextrac_report_id,
    });
    return;
  }

  // Re-point the client first so the report-name compare/rename below targets the
  // correct client id after any move.
  const repoint = await repointClient(
    mapping.plextrac_client_id, mapping.plextrac_report_id, client_name, task.name
  );
  const clientId = repoint.clientId;

  const renamed = await syncReportName(
    clientId, mapping.plextrac_report_id, testing_type, task.start_date, task.name
  );

  // Persist the new details so future rename events and the reverse webhook stay in
  // step with what's now in Plextrac.
  try {
    await store.updateMappingDetails(mapping.plextrac_report_id, {
      clientId, taskName: task.name, testingType: testing_type,
    });
  } catch (err) {
    log.error('Task rename — failed to persist updated mapping', {
      reason: err.message, report_id: mapping.plextrac_report_id,
    });
  }

  if (!renamed && !repoint.moved) {
    log.info('Task rename — no Plextrac change required (name already in sync)', {
      task: task.name, report_id: mapping.plextrac_report_id,
    });
  }
}

module.exports = { handleTaskRename };
