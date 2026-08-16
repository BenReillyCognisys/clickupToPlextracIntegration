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
//     The client authorisation form is re-scoped to match (the old testing type's
//     element is removed and the new one added) — see pipeline/auth-form-rename.js.
//   • client name changed — the Plextrac client is renamed in place, but ONLY when
//     (a) this report is the only one under it and (b) no other client already has
//     the new name. Plextrac has no move-report API, so renaming a shared client
//     would rename it for every report it holds, and renaming onto a name that
//     already exists would create a duplicate client (e.g. fixing a typo when the
//     correctly-spelled client already exists). Either case is left alone with a
//     Slack notice for manual handling instead.
//
// Every Plextrac call is best-effort: a failure is logged (and, where a human needs
// to act, posted to Slack), never thrown, so one bad sync can't wedge the webhook.

const { parseTaskName } = require('./parse-task');
const { buildReportName } = require('./plextrac-report');
const { syncAuthFormForRename } = require('./auth-form-rename');
const { runPipeline } = require('./index');
const api = require('../lib/plextrac-api');
const lookup = require('../lib/plextrac-lookup');
const store = require('../lib/task-store');
const log = require('../lib/logger');

const PLEXTRAC_BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

const normalise = (s) => String(s || '').trim().toLowerCase();

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

// Counts the reports under a Plextrac client. Returns the count, or null if it
// can't be determined (callers treat null conservatively — as "possibly shared").
async function countClientReports(clientId) {
  try {
    const reports = await api.listClientReports(clientId);
    if (Array.isArray(reports)) return reports.length;
    if (Array.isArray(reports?.data)) return reports.data.length;
    return null;
  } catch (err) {
    log.error('Task rename — failed to list client reports for sole-report check', {
      reason: err.message, client_id: clientId,
    });
    return null;
  }
}

// Reflects a client-name change into Plextrac. Plextrac has no move-report API, so
// the report can't be re-parented; instead we rename the client in place — but only
// when this report is the only one under it, so a shared client is never renamed out
// from under its other reports. Shared / unverifiable cases post a Slack notice for
// manual handling. Returns true if the Plextrac client was renamed.
async function syncClientName(mapping, newClientName, taskName) {
  const oldClientName = parseTaskName(mapping.task_name || '').client_name;
  if (normalise(oldClientName) === normalise(newClientName)) {
    return false; // client portion unchanged — only the type (or nothing) changed
  }

  const clientId = mapping.plextrac_client_id;

  // Don't rename onto a name another client already uses — that would just create a
  // duplicate (and we can't move this report onto the existing one: no move API).
  // Common case: a typo fix where the correctly-spelled client already exists.
  let clientsWithNewName;
  try {
    clientsWithNewName = await lookup.findClientIdsByName(newClientName);
  } catch (err) {
    log.error('Task rename — failed to check for an existing client with the new name', {
      reason: err.message, new_client: newClientName,
    });
    clientsWithNewName = null;
  }
  const otherWithNewName = (clientsWithNewName || []).filter(id => String(id) !== String(clientId));
  if (clientsWithNewName == null || otherWithNewName.length) {
    const reason = clientsWithNewName == null
      ? "couldn't verify whether a client with that name already exists"
      : `a Plextrac client named "${newClientName}" already exists (id ${otherWithNewName.join(', ')})`;
    log.warn('Task rename — skipping client rename to avoid a duplicate client', {
      client_id: clientId, old_client: oldClientName, new_client: newClientName,
      existing_ids: otherWithNewName, verified: clientsWithNewName != null,
    });
    log.notify(
      `ClickUp client renamed from "${oldClientName}" to "${newClientName}" for "${taskName}", but ` +
      `${reason} — not renaming automatically to avoid a duplicate. Please move the report to the ` +
      `correct client in Plextrac and tidy up the old one manually.`
    );
    return false;
  }

  const reportCount = await countClientReports(clientId);

  if (reportCount == null) {
    log.warn('Task rename — could not verify the client is unshared; skipping rename to stay safe', {
      client_id: clientId, old_client: oldClientName, new_client: newClientName,
    });
    log.notify(
      `ClickUp client renamed to "${newClientName}" for "${taskName}", but the Plextrac client ` +
      `(id ${clientId}) rename was skipped — couldn't confirm it isn't shared. Please check it manually.`
    );
    return false;
  }

  if (reportCount > 1) {
    log.info('Task rename — client name changed but client is shared; skipping auto-rename', {
      client_id: clientId, reports: reportCount, old_client: oldClientName, new_client: newClientName,
    });
    log.notify(
      `ClickUp client renamed from "${oldClientName}" to "${newClientName}" for "${taskName}", but the ` +
      `Plextrac client (id ${clientId}) has ${reportCount} reports under it — not renaming automatically. ` +
      `Please update it in Plextrac if appropriate.`
    );
    return false;
  }

  try {
    await api.updateClient(clientId, { name: newClientName });
  } catch (err) {
    log.error('Task rename — failed to rename Plextrac client', {
      reason: err.message, client_id: clientId, new_client: newClientName,
    });
    log.notify(
      `ClickUp client renamed to "${newClientName}" for "${taskName}" but the Plextrac client ` +
      `(id ${clientId}) rename failed — please update it manually.`
    );
    return false;
  }

  log.info('Task rename — Plextrac client renamed', {
    client_id: clientId, old_client: oldClientName, new_client: newClientName, task: taskName,
  });
  log.notify(`ClickUp client rename synced — Plextrac client renamed from "${oldClientName}" to "${newClientName}".`);
  return true;
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

  // What the auth form was generated against, captured before the mapping is updated
  // below. The stored testing_type is authoritative (it's what the create pipeline
  // sent the portal); older mappings predate the field, so fall back to re-parsing
  // the stored name.
  const oldClientName = parseTaskName(mapping.task_name || '').client_name;
  const oldTestType = mapping.testing_type || parseTaskName(mapping.task_name || '').testing_type;

  // Reflect a client-name change (renames the Plextrac client in place when safe)
  // and a testing-type change (renames the report). The report stays under the same
  // client id throughout — Plextrac has no move-report API.
  const clientId = mapping.plextrac_client_id;
  const clientRenamed = await syncClientName(mapping, client_name, task.name);
  const reportRenamed = await syncReportName(
    clientId, mapping.plextrac_report_id, testing_type, task.start_date, task.name
  );

  // Re-scope the client authorisation form so it stops authorising the old testing
  // type and starts authorising the new one. Best-effort and independent of the
  // Plextrac syncs above — a portal failure must not stop the mapping being updated.
  const authFormSynced = await syncAuthFormForRename(task, {
    oldClientName,
    oldTestType,
    clientName: client_name,
    testType: testing_type,
    clientId,
    reportId: mapping.plextrac_report_id,
  }).catch(err => {
    // The sync handles its own failures; this only guards the mapping update below
    // against an unexpected throw.
    log.error('Task rename — auth-form sync threw unexpectedly', {
      reason: err.message, task: task.name, task_id: task.id,
    });
    return null;
  });

  // Persist the new details so future rename events and the reverse webhook stay in
  // step with what's now in Plextrac.
  try {
    await store.updateMappingDetails(mapping.plextrac_report_id, {
      taskName: task.name, testingType: testing_type,
    });
  } catch (err) {
    log.error('Task rename — failed to persist updated mapping', {
      reason: err.message, report_id: mapping.plextrac_report_id,
    });
  }

  if (!clientRenamed && !reportRenamed && !authFormSynced) {
    log.info('Task rename — no Plextrac or auth-form change required (name already in sync)', {
      task: task.name, report_id: mapping.plextrac_report_id,
    });
  }
}

module.exports = { handleTaskRename };
