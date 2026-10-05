// Merges one Plextrac client into another: every report of the client being removed
// is moved to the client being kept, then the removed client is deleted.
//
// Plextrac has no "move report". Its documented way to move one is the .ptrac export
// and import, so that is what this does — the import creates a NEW report (new id and
// cuid) under the kept client. Driven from the SFE portal through routes/client-merge.js.
//
// Order, and what has to be true before each step:
//
//   1. Snapshot   both clients and their reports, as they are now.
//   2. Backup     EVERY report of BOTH clients to Google Drive:
//                   <CLIENT_MERGE_DRIVE_FOLDER_ID>/<Removed> - <Kept> Merge - <timestamp>/
//                     manifest.json                     this merge, as recorded
//                     <Client> (<id>)/client.json       the client record + report list
//                     <Client> (<id>)/<Report> (<id>)/
//                       <Report>.ptrac                  restorable copy of the report
//                       Full-Pentest-Report-Tech-Details <timestamp>.pdf
//                       Executive Summary Report <timestamp>.pdf
//                       Letter of Attestation <timestamp>.pdf
//                       Artifacts/<files on the report's Artifacts tab>
//                 Every file is checked against the MD5 Drive reports for it. If ANY file
//                 of ANY report fails, the merge stops here and nothing in Plextrac has
//                 been changed.
//   3. Move       one report at a time:
//                   a. download the .ptrac BACK from Drive (MD5-checked) — the import uses
//                      the backup itself, which also proves the backup restores;
//                   b. import it into the kept client and find the new report;
//                   c. verify the copy: re-export it and compare name, status, finding
//                      count and screenshot count with the original;
//                   d. copy the Artifacts tab (the .ptrac doesn't carry it);
//                   e. check the original wasn't edited since it was backed up;
//                   f. re-point this service's records (ClickUp mapping, DeliveryFlow
//                      engagement, QA queue/KPIs) to the copy, and send DeliveryFlow the
//                      new link;
//                   g. delete the original and confirm it is gone.
//                 Any failure stops the merge where it is; the record says exactly which
//                 report reached which step.
//   4. Delete     the removed client — only once it has no reports left — after
//                 recording its name as an alias of the kept client, so the ClickUp /
//                 DeliveryFlow pipelines file future work under the kept client instead
//                 of creating the duplicate again.
//
// Not carried by a .ptrac, and so not moved: report comments. Their absence is noted in
// the record; the PDFs in the backup are the reference copy.
//
// Configuration (.env.example → "Client merge"):
//   CLIENT_MERGE_DRIVE_FOLDER_ID       where the backup folders go
//   CLIENT_MERGE_BACKUP_CONCURRENCY    reports backed up at once (default 2)
//   CLIENT_MERGE_IMPORT_WAIT_MS        how long to wait for an import to land (default 180000)

const crypto = require('crypto');
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const store = require('../lib/client-merge-store');
const deliveryflow = require('../lib/deliveryflow-api');
const suppression = require('../lib/webhook-suppression');
const backup = require('./report-backup');
const DOCUMENTS = require('../config/client-documents');
const { exportTimestamp, safeFilename } = require('./report-export');
const { withTaskLock } = require('../lib/task-lock');
const { limiter } = require('../lib/concurrency');
const log = require('../lib/logger');

const PLEXTRAC_BASE = () => `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
const reportUrl = (clientId, reportId) => `${PLEXTRAC_BASE()}/client/${clientId}/report/${reportId}`;
const clientUrl = (clientId) => `${PLEXTRAC_BASE()}/client/${clientId}`;

const backupRoot = () => process.env.CLIENT_MERGE_DRIVE_FOLDER_ID || '1YxrZz42lKpbnrohi04je_RV60ESIZoWn';
const backupConcurrency = () => Number(process.env.CLIENT_MERGE_BACKUP_CONCURRENCY) || 2;
const importWaitMs = () => Number(process.env.CLIENT_MERGE_IMPORT_WAIT_MS) || 180000;
const pollMs = () => Number(process.env.CLIENT_MERGE_POLL_MS) || 5000;

const { md5, JSON_MIME } = backup;

class MergeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameName = (a, b) => store.aliasKey(a) === store.aliasKey(b);

// Plextrac list rows: clients { data: [id, name] }, reports { data: [id, name, _, status] }.
const clientRows = (raw) => (raw || []).map((c) => (Array.isArray(c.data)
  ? { id: Number(c.data[0]), name: String(c.data[1] ?? '') }
  : { id: Number(c.client_id ?? c.id), name: String(c.name ?? '') }));
const reportRows = (raw) => (raw || []).map((r) => (Array.isArray(r.data)
  ? { id: Number(r.data[0]), name: String(r.data[1] ?? ''), status: r.data[3] ?? null }
  : { id: Number(r.id ?? r.report_id), name: String(r.name ?? ''), status: r.status ?? null }));

function parseClientId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new MergeError(`${field} must be a Plextrac client id`);
  return id;
}

// ── Reading Plextrac ──────────────────────────────────────────────────────────

/** Every Plextrac client, A–Z: [{ id, name }]. */
async function listClients() {
  return clientRows(await api.listClients())
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

async function loadClient(clientId) {
  let record;
  try {
    record = await api.getClient(clientId);
  } catch (err) {
    throw new MergeError(`Plextrac client ${clientId} could not be read: ${err.message}`, /\(HTTP 404\)/.test(err.message) ? 404 : 502);
  }
  if (!record || record.client_id == null) throw new MergeError(`Plextrac client ${clientId} not found`, 404);
  return { id: Number(record.client_id), name: String(record.name ?? ''), record };
}

async function loadReports(clientId) {
  return reportRows(await api.listClientReports(clientId));
}

// A fingerprint of a report as Plextrac holds it now: the report record and every
// finding's list row, which carries the finding's last-updated time. Taken before the
// backup export and again just before the original is deleted — if they differ,
// someone edited the report mid-merge and the original is kept.
async function fingerprint(clientId, reportId) {
  const [report, findings] = await Promise.all([
    api.getReport(clientId, reportId),
    api.listReportFindings(clientId, reportId),
  ]);
  const rows = (Array.isArray(findings) ? findings : Object.values(findings || {}))
    .map((f) => JSON.stringify(f)).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ report, rows })).digest('hex');
}

// ── Preview ───────────────────────────────────────────────────────────────────

function mergeFolderName(mergeClient, keepClient, at) {
  return `${safeFilename(mergeClient.name, 'Client')} - ${safeFilename(keepClient.name, 'Client')} Merge - ${exportTimestamp(at)}`;
}

/**
 * What a merge of `mergeClientId` into `keepClientId` would do, without doing any of it.
 */
async function preview({ keepClientId, mergeClientId }) {
  const keepId = parseClientId(keepClientId, 'keepClientId');
  const mergeId = parseClientId(mergeClientId, 'mergeClientId');
  if (keepId === mergeId) throw new MergeError('Choose two different clients');

  const [keep, merge] = await Promise.all([loadClient(keepId), loadClient(mergeId)]);
  const [keepReports, mergeReports] = await Promise.all([loadReports(keepId), loadReports(mergeId)]);

  const warnings = [];
  const linked = await store.linkedRecords(mergeId).catch((err) => {
    warnings.push(`Could not read break.services' own records for this client: ${err.message}`);
    return null;
  });
  const active = await store.findActiveMerge([keepId, mergeId]).catch(() => null);
  if (active) warnings.push(`A merge involving one of these clients is already ${active.status} (${active.merge_id}).`);

  const nameClashes = mergeReports
    .filter((r) => keepReports.some((k) => sameName(k.name, r.name)))
    .map((r) => r.name);
  if (nameClashes.length) {
    warnings.push(`${nameClashes.length} report name(s) already exist under ${keep.name}; the moved copies will sit alongside them with the same name.`);
  }

  return {
    keep: { id: keepId, name: keep.name, url: clientUrl(keepId), reports: keepReports },
    merge: { id: mergeId, name: merge.name, url: clientUrl(mergeId), reports: mergeReports },
    nameClashes,
    linked,
    backup: {
      folderName: mergeFolderName(merge, keep, new Date()),
      parentFolderUrl: drive.driveFolderUrl(backupRoot()),
      reports: keepReports.length + mergeReports.length,
      documentsPerReport: DOCUMENTS.map((d) => d.name),
    },
    notCarried: ['Report comments (not included in a .ptrac export)'],
    warnings,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Validates and records a merge, starts it in the background, and returns its record.
 * `confirmClientName` must match the name of the client being removed — a deliberate
 * second step so a mis-click can't delete a client.
 */
async function startMerge({ keepClientId, mergeClientId, confirmClientName, requestedBy }) {
  const keepId = parseClientId(keepClientId, 'keepClientId');
  const mergeId = parseClientId(mergeClientId, 'mergeClientId');
  if (keepId === mergeId) throw new MergeError('Choose two different clients');

  const [keep, merge] = await Promise.all([loadClient(keepId), loadClient(mergeId)]);
  if (!sameName(confirmClientName, merge.name)) {
    throw new MergeError(`confirmClientName must be the name of the client being removed ("${merge.name}")`);
  }

  // Check-and-record under one lock, so two clicks can't start two merges.
  const job = await withTaskLock('client-merge:start', async () => {
    const active = await store.findActiveMerge([keepId, mergeId]);
    if (active) throw new MergeError(`A merge involving one of these clients is already ${active.status} (${active.merge_id})`, 409);
    const now = new Date();
    const record = {
      merge_id: crypto.randomUUID(),
      status: 'queued',
      stage: 'queued',
      keep_client: { id: keepId, name: keep.name },
      merge_client: { id: mergeId, name: merge.name },
      requested_by: requestedBy ? String(requestedBy).slice(0, 200) : null,
      created_at: now,
      started_at: null,
      finished_at: null,
      drive_folder: null,
      reports: [],
      client_deleted: false,
      error: null,
      events: [],
    };
    await store.saveMerge(record);
    return record;
  });

  // The record as started; the run goes on mutating its own copy in the background.
  const started = structuredClone(job);
  runMerge(job).catch((err) => log.error('Client merge crashed', { merge_id: job.merge_id, reason: err.message }));
  return started;
}

// ── Run ───────────────────────────────────────────────────────────────────────

function tracker(job) {
  const event = (level, message, data = {}) => {
    job.events.push({ at: new Date(), level, message, ...data });
    log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`Client merge: ${message}`, {
      merge_id: job.merge_id, ...data,
    });
  };
  // A failed save must not stop the merge mid-step; it is retried at the next step.
  const save = () => store.saveMerge(job).catch((err) => log.error('Client merge: could not save record', {
    merge_id: job.merge_id, reason: err.message,
  }));
  return { event, save };
}

async function runMerge(job) {
  const { event, save } = tracker(job);
  job.status = 'running';
  job.started_at = new Date();
  event('info', `STARTED — "${job.merge_client.name}" (${job.merge_client.id}) into "${job.keep_client.name}" (${job.keep_client.id})`,
    { requested_by: job.requested_by });
  await save();

  try {
    job.stage = 'snapshot';
    const clientRecords = await snapshot(job, event);
    await save();

    job.stage = 'backup';
    await backupAll(job, event, save, clientRecords);

    job.stage = 'move';
    for (const entry of job.reports.filter((r) => r.role === 'move')) {
      await moveReport(job, entry, event, save);
    }

    job.stage = 'delete_client';
    await save();
    await removeClient(job, event);

    job.stage = 'done';
    job.status = 'completed';
    event('info', `FINISHED — ${job.reports.filter((r) => r.move?.state === 'deleted').length} report(s) moved, "${job.merge_client.name}" deleted`);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    event('error', `FAILED at ${job.stage}: ${err.message}`);
  }

  job.finished_at = new Date();
  await save();
  await writeManifest(job).catch((err) => event('warn', `Could not update manifest.json in Drive: ${err.message}`));
  await save();
  notifySlack(job);
  return job;
}

async function snapshot(job, event) {
  const [keep, merge] = await Promise.all([loadClient(job.keep_client.id), loadClient(job.merge_client.id)]);
  const [keepReports, mergeReports] = await Promise.all([loadReports(keep.id), loadReports(merge.id)]);
  job.keep_client = { id: keep.id, name: keep.name, report_count: keepReports.length };
  job.merge_client = { id: merge.id, name: merge.name, report_count: mergeReports.length };
  const entry = (client, role) => (r) => ({
    role, client_id: client.id, client_name: client.name, report_id: r.id, name: r.name, status: r.status,
    backup: null, ...(role === 'move' ? { move: { state: 'pending' } } : {}),
  });
  job.reports = [...mergeReports.map(entry(merge, 'move')), ...keepReports.map(entry(keep, 'keep'))];
  event('info', `Snapshot: ${mergeReports.length} report(s) to move, ${keepReports.length} already on the kept client`);
  // The full client records go into the backup's client.json, not the merge record
  // (a client logo alone can be a large base64 string).
  return { [keep.id]: keep.record, [merge.id]: merge.record };
}

// ── Backup ────────────────────────────────────────────────────────────────────
// Each report is backed up by pipeline/report-backup.js, shared with the weekly backup.

async function backupAll(job, event, save, clientRecords) {
  const rootName = mergeFolderName(job.merge_client, job.keep_client, job.started_at);
  const rootId = await backup.folderUnder(backupRoot(), rootName);
  job.drive_folder = { id: rootId, name: rootName, url: drive.driveFolderUrl(rootId) };
  event('info', `Backup folder ready: ${rootName}`, { drive: job.drive_folder.url });
  await save();

  // One folder per client, holding the client record and the list of its reports.
  const clientFolders = {};
  for (const client of [job.merge_client, job.keep_client]) {
    const folderId = await backup.folderUnder(rootId, backup.clientFolderName(client));
    clientFolders[client.id] = folderId;
    await backup.backupClientRecord({
      record: clientRecords[client.id],
      reports: job.reports.filter((r) => r.client_id === client.id).map((r) => ({ id: r.report_id, name: r.name, status: r.status })),
      folderId,
      at: job.started_at,
    });
  }

  const slots = limiter(backupConcurrency());
  let done = 0;
  await Promise.all(job.reports.map((entry) => slots(async () => {
    await backupReport(job, entry, clientFolders[entry.client_id]);
    done++;
    if (entry.backup.ok) {
      event('info', `Backed up ${done}/${job.reports.length}: "${entry.name}"`, { report_id: entry.report_id, files: entry.backup.files.length });
    } else {
      event('error', `Backup FAILED for "${entry.name}": ${entry.backup.error}`, { report_id: entry.report_id });
    }
    await save();
  })));

  await writeManifest(job).catch((err) => { throw new Error(`manifest.json could not be written: ${err.message}`); });

  const failed = job.reports.filter((r) => !r.backup?.ok);
  if (failed.length) {
    throw new Error(`${failed.length} report(s) could not be backed up (${failed.map((r) => `"${r.name}"`).join(', ')}) — nothing was changed in Plextrac`);
  }
  event('info', `Backup complete: ${job.reports.length} report(s), ${job.reports.reduce((n, r) => n + r.backup.files.length, 0)} file(s), all verified`);
}

async function backupReport(job, entry, clientFolderId) {
  // Taken before the export, so any edit from here on shows up before deletion.
  if (entry.role === 'move') {
    try {
      entry.fingerprint = await fingerprint(entry.client_id, entry.report_id);
    } catch (err) {
      entry.backup = { ok: false, folder_id: null, files: [], warnings: [], error: `could not read the report: ${err.message}` };
      return;
    }
  }
  const result = await backup.backupReport({
    clientId: entry.client_id, report: { id: entry.report_id, name: entry.name },
    parentFolderId: clientFolderId, exportedAt: job.started_at,
  });
  entry.backup = {
    ok: result.ok, folder_id: result.folder_id, folder_url: result.folder_url,
    files: result.files, warnings: result.warnings, error: result.error,
  };
  if (result.report) {
    entry.cuid = result.report.cuid;
    entry.status = result.report.status ?? entry.status;
    entry.findings = result.report.findings.length;
    entry.media = result.report.media;
  }
  entry.artifacts = result.artifacts;
}

async function writeManifest(job) {
  if (!job.drive_folder?.id) return;
  const { events, ...rest } = job;
  const buffer = Buffer.from(JSON.stringify({ ...rest, events }, null, 2));
  await drive.uploadFile({ buffer, filename: 'manifest.json', mimeType: JSON_MIME, folderId: job.drive_folder.id, overwrite: true });
}

// ── Move ──────────────────────────────────────────────────────────────────────

// The report the import created under `clientId`: the hinted id from Plextrac's reply
// if it is a new report there, else the one new report carrying the original's name.
// Polls, as an import can take a minute or two to land.
async function findImported({ clientId, before, name, reply }) {
  const hint = Number(reply?.report_id ?? reply?.data?.report_id ?? reply?.reportId ?? reply?.data?.id ?? reply?.id);
  const deadline = Date.now() + importWaitMs();
  for (let attempt = 0; ; attempt++) {
    const fresh = (await loadReports(clientId)).filter((r) => !before.has(r.id));
    if (Number.isSafeInteger(hint) && fresh.some((r) => r.id === hint)) return { id: hint, renamed: false };
    const named = fresh.filter((r) => sameName(r.name, name));
    if (named.length === 1) return { id: named[0].id, renamed: false };
    if (named.length > 1) throw new Error(`the import produced ${named.length} reports named "${name}" — check the kept client by hand`);
    // Imported under another name: only trusted if it is the ONLY new report, after a
    // second look (so a report created alongside can't be mistaken for it).
    if (fresh.length === 1 && attempt >= 1) return { id: fresh[0].id, renamed: fresh[0].name };
    if (Date.now() >= deadline) {
      throw new Error(fresh.length
        ? `the import did not produce one recognisable report (${fresh.length} new: ${fresh.map((r) => `"${r.name}"`).join(', ')})`
        : `the imported report did not appear within ${Math.round(importWaitMs() / 1000)}s`);
    }
    await sleep(pollMs());
  }
}

// Re-exports the imported copy and compares it with the original's .ptrac. Waits for
// the findings to arrive, as an import may still be adding them.
async function verifyImported({ clientId, reportId, entry }) {
  const deadline = Date.now() + importWaitMs();
  let last;
  for (;;) {
    const { ptrac } = await api.exportReportPtrac(clientId, reportId);
    const info = ptrac.report_info;
    last = {
      name: info.name, status: info.status, cuid: info.cuid ?? null,
      findings: ptrac.flaws_array.length, media: Object.keys(ptrac.summary?.ReportMedia || {}).length,
    };
    if (last.findings >= entry.findings && last.media >= entry.media) break;
    if (Date.now() >= deadline) break;
    await sleep(pollMs());
  }
  const problems = [];
  if (last.findings !== entry.findings) problems.push(`${last.findings} finding(s), original has ${entry.findings}`);
  if (last.media !== entry.media) problems.push(`${last.media} screenshot(s), original has ${entry.media}`);
  return { ...last, problems };
}

async function moveReport(job, entry, event, save) {
  const keepId = job.keep_client.id;
  const m = entry.move;
  const step = async (state, message, data) => {
    m.state = state;
    event('info', message, { report_id: entry.report_id, ...data });
    await save();
  };

  // Suppress the webhook for this report under the kept client for the whole move:
  // by name now, and by cuid once the copy's is known.
  const quiet = (cuid) => suppression.suppress({
    cuid, clientName: job.keep_client.name, reportName: entry.name, reason: `client merge ${job.merge_id}`,
  });
  await quiet();

  try {
    // a. The backed-up .ptrac, read back from Drive.
    const ptracFile = entry.backup.files.find((f) => f.kind === 'ptrac');
    const fromDrive = await drive.downloadFileById(ptracFile.file_id);
    if (md5(fromDrive.buffer) !== ptracFile.md5) throw new Error(`the .ptrac read back from Drive does not match its backup MD5`);

    // b. Import, and find the new report.
    const before = new Set((await loadReports(keepId)).map((r) => r.id));
    const reply = await api.importReportPtrac(keepId, fromDrive.buffer, ptracFile.name);
    m.import_reply = JSON.stringify(reply ?? null).slice(0, 500);
    const found = await findImported({ clientId: keepId, before, name: entry.name, reply });
    m.new_report_id = found.id;
    m.new_report_url = reportUrl(keepId, found.id);
    await step('imported', `Imported "${entry.name}" as report ${found.id}`, { new_report_id: found.id });

    // c. Verify the copy; put back a name or status the import didn't keep.
    const copy = await verifyImported({ clientId: keepId, reportId: found.id, entry });
    m.new_cuid = copy.cuid;
    await quiet(copy.cuid);
    if (copy.problems.length) {
      throw new Error(`the imported copy (report ${found.id}) does not match the original: ${copy.problems.join('; ')}. Both are kept`);
    }
    const restore = {};
    if (copy.name !== entry.name) restore.name = entry.name;
    if (entry.status && copy.status !== entry.status) restore.status = entry.status;
    if (Object.keys(restore).length) {
      await api.updateReport(keepId, found.id, restore);
      event('warn', `Import changed ${Object.keys(restore).join(' and ')} of "${entry.name}" — put back`, { new_report_id: found.id, ...restore });
    }
    await step('verified', `Verified copy of "${entry.name}": ${copy.findings} finding(s), ${copy.media} screenshot(s)`, { new_report_id: found.id });

    // d. The Artifacts tab, from the backed-up copies.
    const artifacts = entry.backup.files.filter((f) => f.kind === 'artifact');
    for (const a of artifacts) {
      const { buffer } = await drive.downloadFileById(a.file_id);
      if (md5(buffer) !== a.md5) throw new Error(`artifact "${a.filename}" read back from Drive does not match its backup`);
      await api.uploadReportArtifact(keepId, found.id, {
        buffer, filename: a.filename, contentType: a.content_type, description: a.description || a.filename,
      });
    }
    if (artifacts.length) {
      const listed = await api.listReportArtifacts(keepId, found.id);
      if (listed.length < artifacts.length) throw new Error(`only ${listed.length} of ${artifacts.length} artifact(s) list on the copy`);
      m.artifacts_copied = artifacts.length;
      await step('artifacts', `Copied ${artifacts.length} artifact(s) to the copy of "${entry.name}"`);
    }

    // e. Was the original edited after it was backed up? Then its edits aren't in the
    // copy: keep it, and stop.
    if (await fingerprint(entry.client_id, entry.report_id) !== entry.fingerprint) {
      throw new Error(`"${entry.name}" was edited during the merge, so its edits are not in the copy (report ${found.id}). The original was NOT deleted — check both, delete one, and re-run`);
    }

    // f. Point this service's records at the copy, and tell DeliveryFlow its new link.
    const repointed = await store.repointReport({
      oldClientId: entry.client_id, oldReportId: entry.report_id, oldCuid: entry.cuid,
      newClientId: keepId, newReportId: found.id, newCuid: copy.cuid, newReportUrl: m.new_report_url, mergeId: job.merge_id,
    });
    m.repointed = repointed.counts;
    m.deliveryflow = await notifyDeliveryFlow(repointed.engagements, { entry, reportId: found.id, url: m.new_report_url, status: entry.status });
    await step('repointed', `Records for "${entry.name}" now point at report ${found.id}`, { ...repointed.counts });

    // g. Delete the original, and confirm it is gone.
    await api.deleteReport(entry.client_id, entry.report_id);
    const still = (await loadReports(entry.client_id)).some((r) => r.id === entry.report_id);
    if (still) throw new Error(`Plextrac accepted the delete of "${entry.name}" (${entry.report_id}) but it is still listed`);
    await step('deleted', `Moved "${entry.name}": ${entry.report_id} → ${found.id}, original deleted`, { new_report_id: found.id });
  } catch (err) {
    m.error = err.message;
    m.failed_at = m.state;
    m.state = 'failed';
    throw new Error(`moving "${entry.name}": ${err.message}`);
  }
}

// The engagement's report moved: send DeliveryFlow the report_status event it already
// handles, carrying the unchanged status and the NEW report id and link. Best-effort.
async function notifyDeliveryFlow(engagements, { entry, reportId, url, status }) {
  if (!engagements.length) return [];
  if (!deliveryflow.isConfigured()) return engagements.map((e) => ({ ...e, sent: false, reason: 'not configured' }));
  return Promise.all(engagements.map(async (e) => {
    try {
      await deliveryflow.sendEvent('report_status', { engagementId: e.engagementId, dealId: e.dealId }, {
        status, reportId: String(reportId), reportName: entry.name, reportUrl: url,
      });
      return { ...e, sent: true };
    } catch (err) {
      return { ...e, sent: false, reason: err.message };
    }
  }));
}

// ── Delete the client ─────────────────────────────────────────────────────────

async function removeClient(job, event) {
  const { id, name } = job.merge_client;
  const left = await loadReports(id);
  if (left.length) {
    throw new Error(`"${name}" still has ${left.length} report(s) (${left.map((r) => `"${r.name}"`).join(', ')}) — created during the merge? The client was NOT deleted`);
  }

  // Future work under this name goes to the kept client, and anything that still names
  // this client (an engagement whose report was never created) follows it.
  const repointedRecords = await store.repointClient({ oldClientId: id, newClientId: job.keep_client.id });
  await store.repointAliases({ oldClientId: id, newClientId: job.keep_client.id, newClientName: job.keep_client.name });
  await store.saveAlias({ aliasName: name, clientId: job.keep_client.id, clientName: job.keep_client.name, mergeId: job.merge_id });
  job.alias_saved = true;
  event('info', `"${name}" recorded as an alias of "${job.keep_client.name}"`, repointedRecords);

  await api.deleteClient(id);
  const still = (await listClients()).some((c) => c.id === id);
  if (still) throw new Error(`Plextrac accepted the delete of client "${name}" (${id}) but it is still listed`);
  job.client_deleted = true;
  event('info', `Deleted client "${name}" (${id})`);
}

function notifySlack(job) {
  const moved = job.reports.filter((r) => r.move?.state === 'deleted').length;
  const total = job.reports.filter((r) => r.role === 'move').length;
  const backup = job.drive_folder ? ` Backup: <${job.drive_folder.url}|${job.drive_folder.name}>` : '';
  const by = job.requested_by ? ` (by ${job.requested_by})` : '';
  if (job.status === 'completed') {
    log.notify(`:white_check_mark: Plextrac client merge${by}: "${job.merge_client.name}" merged into <${clientUrl(job.keep_client.id)}|${job.keep_client.name}> — ${moved} report(s) moved, old client deleted.${backup}`);
  } else {
    log.notify(`:warning: Plextrac client merge${by} of "${job.merge_client.name}" into "${job.keep_client.name}" FAILED at ${job.stage} (${moved}/${total} report(s) moved): ${job.error}.${backup}`);
  }
}

module.exports = {
  MergeError,
  listClients,
  preview,
  startMerge,
  runMerge,
  mergeFolderName,
  // exposed for tests
  findImported,
  fingerprint,
};
