// Weekly backup of the whole Plextrac tenant to Google Drive.
//
// Every client and every report, the same way a client merge backs reports up
// (pipeline/report-backup.js), into a numbered folder per run:
//
//   <PLEXTRAC_BACKUP_DRIVE_FOLDER_ID>/
//     0001. 2026-10-09 22-00-00/
//       changes.md                       what's new / changed / gone since the last run
//       manifest.json                    this run: totals, and every report's record
//       <Client> (<id>)/client.json      client record + report list
//       <Client> (<id>)/<Report> (<id>)/
//         <Report>.ptrac                 restorable copy (Plextrac → Import Report)
//         Full-Pentest-Report-Tech-Details <timestamp>.pdf
//         Executive Summary Report <timestamp>.pdf
//         Letter of Attestation <timestamp>.pdf
//         Artifacts/…
//     0002. 2026-10-16 22-00-00/
//       …
//
// The number counts up from the highest one already in the folder (or on record), so
// the folder reads as a running log of what ran when.
//
// Runs on PLEXTRAC_BACKUP_CRON (default Fridays 22:00 Europe/London — BST in summer,
// GMT in winter). Only READS from Plextrac. A report that fails is recorded and listed
// in changes.md; the run carries on with the rest.
//
// Resumable: each report's record is saved as it finishes. If the server restarts
// mid-run, it picks the run up again on startup, in the same folder, and skips the
// reports already done.
//
// Test runs (scripts/plextrac-backup.js --clients=…) go in a "TEST <timestamp>" folder,
// take no number, and are never what a later run compares itself with.

const crypto = require('crypto');
const os = require('os');
const cron = require('node-cron');
const api = require('../lib/plextrac-api');
const drive = require('../lib/google-drive');
const store = require('../lib/plextrac-backup-store');
const backup = require('./report-backup');
const DOCUMENTS = require('../config/client-documents');
const { exportTimestamp, formatSize } = require('./report-export');
const { limiter } = require('../lib/concurrency');
const log = require('../lib/logger');

const rootFolder = () => process.env.PLEXTRAC_BACKUP_DRIVE_FOLDER_ID || '1B9zPyVhLH7AvFdnHFIK-37v8M06COy5V';
const CRON = process.env.PLEXTRAC_BACKUP_CRON ?? '0 22 * * 5';
const TZ = process.env.PLEXTRAC_BACKUP_TZ || 'Europe/London';
const concurrency = () => Number(process.env.PLEXTRAC_BACKUP_CONCURRENCY) || 3;
const LIST_CONCURRENCY = 5;
// A run whose process stopped saying it's alive this long ago is dead.
const STALE_MS = 20 * 60 * 1000;
// A dead run older than this isn't resumed — it would no longer be "this week's".
const RESUME_WITHIN_MS = 36 * 60 * 60 * 1000;

const PLEXTRAC_BASE = () => `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

let scheduled = null; // the cron task, for its next run time
let current = null; // run_id of the run in this process

const owner = (role) => ({ host: os.hostname(), pid: process.pid, role });

const clientRows = (raw) => (raw || []).map((c) => (Array.isArray(c.data)
  ? { id: Number(c.data[0]), name: String(c.data[1] ?? '') }
  : { id: Number(c.client_id ?? c.id), name: String(c.name ?? '') }));
const reportRows = (raw) => (raw || []).map((r) => (Array.isArray(r.data)
  ? { id: Number(r.data[0]), name: String(r.data[1] ?? ''), status: r.data[3] ?? null }
  : { id: Number(r.id ?? r.report_id), name: String(r.name ?? ''), status: r.status ?? null }));

const pad = (n) => String(n).padStart(4, '0');

// The next run number: one past the highest already used, in Drive or on record.
async function nextSequence() {
  const d = await drive.driveClient(drive.WRITE_SCOPES);
  const folders = await drive.listSubfolders(d, rootFolder());
  const inDrive = Math.max(0, ...folders.map((f) => Number((/^(\d+)\.\s/.exec(f.name || '') || [])[1]) || 0));
  return Math.max(inDrive, await store.maxSequence()) + 1;
}

const isFresh = (run) => run.heartbeat_at && Date.now() - new Date(run.heartbeat_at).getTime() < STALE_MS;

// ── Run ───────────────────────────────────────────────────────────────────────

/**
 * Runs a backup and resolves with its final record (or { skipped } when another is
 * already running).
 *
 * @param {object} [args]
 * @param {'scheduled'|'manual'|'test'} [args.kind='scheduled']
 * @param {number[]} [args.clientIds]  test runs only: just these clients
 * @param {string} [args.requestedBy]
 * @param {string} [args.resumeRunId]  carry on with this run
 * @param {'server'|'script'} [args.role='server']
 */
async function runBackup({ kind = 'scheduled', clientIds = null, requestedBy = null, resumeRunId = null, role = 'server' } = {}) {
  if (current) {
    log.warn('Plextrac backup not started — one is already running in this process', { run_id: current });
    return { skipped: `run ${current} is already running` };
  }
  const elsewhere = (await store.runningRuns()).find((r) => r.run_id !== resumeRunId && isFresh(r));
  if (elsewhere) {
    log.warn('Plextrac backup not started — another is running', { run_id: elsewhere.run_id, owner: elsewhere.owner });
    return { skipped: `run ${elsewhere.run_id} is already running` };
  }

  const runId = resumeRunId || crypto.randomUUID();
  current = runId;
  let run;
  try {
    run = resumeRunId ? await store.getRun(resumeRunId) : await startRun({ runId, kind, clientIds, requestedBy, role });
    if (resumeRunId) {
      await store.updateRun(runId, { set: { owner: owner(role), resumed_at: new Date(), resumes: (run.resumes || 0) + 1 } });
      log.info('Plextrac backup RESUMED', { run_id: runId, folder: run.folder?.name });
    }
    await backupEverything(run);
    return await finishRun(run);
  } catch (err) {
    log.error('Plextrac backup FAILED', { run_id: runId, reason: err.message });
    await store.updateRun(runId, { set: { status: 'failed', error: err.message, finished_at: new Date() } }).catch(() => {});
    log.notify(`:x: Plextrac weekly backup ${run?.folder?.name ? `"${run.folder.name}" ` : ''}FAILED: ${err.message}`);
    return store.getRun(runId).catch(() => null);
  } finally {
    current = null;
  }
}

async function startRun({ runId, kind, clientIds, requestedBy, role }) {
  const startedAt = new Date();
  const sequence = kind === 'test' ? null : await nextSequence();
  const name = kind === 'test' ? `TEST ${exportTimestamp(startedAt, TZ)}` : `${pad(sequence)}. ${exportTimestamp(startedAt, TZ)}`;
  const run = {
    run_id: runId, kind, status: 'running', sequence,
    folder: { id: null, name, url: null },
    client_filter: clientIds ? clientIds.map(Number) : null,
    started_at: startedAt, finished_at: null, duration_ms: null,
    requested_by: requestedBy, owner: owner(role),
    progress: { stage: 'starting', clients_total: 0, clients_done: 0, reports_total: 0, reports_done: 0, reports_failed: 0 },
    totals: null, changes: null, error: null,
  };
  await store.createRun(run);
  const folderId = await backup.folderUnder(rootFolder(), name);
  run.folder = { id: folderId, name, url: drive.driveFolderUrl(folderId) };
  await store.updateRun(runId, { set: { folder: run.folder } });
  log.info('Plextrac backup STARTED', { run_id: runId, kind, folder: name, drive: run.folder.url });
  return run;
}

// Lists the tenant, then backs every client and report up. Skips what this run already
// did (a resumed run).
async function backupEverything(run) {
  const progress = (set) => store.updateRun(run.run_id, { set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`progress.${k}`, v])) });

  // 1. Every client and its reports.
  await progress({ stage: 'listing' });
  let clients = clientRows(await api.listClients());
  if (run.client_filter) clients = clients.filter((c) => run.client_filter.includes(c.id));
  const lists = limiter(LIST_CONCURRENCY);
  const listErrors = [];
  await Promise.all(clients.map((c) => lists(async () => {
    try {
      c.reports = reportRows(await api.listClientReports(c.id));
    } catch (err) {
      c.reports = [];
      c.list_error = err.message;
      listErrors.push(`${c.name} (${c.id}): its reports could not be listed: ${err.message}`);
    }
  })));
  clients.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const reportsTotal = clients.reduce((n, c) => n + c.reports.length, 0);
  run.clients = clients.map((c) => ({ id: c.id, name: c.name, report_count: c.reports.length, ...(c.list_error ? { list_error: c.list_error } : {}) }));
  run.list_errors = listErrors;
  await store.updateRun(run.run_id, {
    set: { clients: run.clients, list_errors: listErrors, 'progress.clients_total': clients.length, 'progress.reports_total': reportsTotal },
  });
  log.info('Plextrac backup: tenant listed', { run_id: run.run_id, clients: clients.length, reports: reportsTotal });

  // 2. A folder per client, with its client.json.
  await progress({ stage: 'clients' });
  const records = limiter(LIST_CONCURRENCY);
  const clientFolders = new Map();
  let clientsDone = 0;
  await Promise.all(clients.map((c) => records(async () => {
    try {
      const folderId = await backup.folderUnder(run.folder.id, backup.clientFolderName(c));
      clientFolders.set(c.id, folderId);
      const record = await api.getClient(c.id);
      await backup.backupClientRecord({ record, reports: c.reports, folderId, at: run.started_at, overwrite: true });
    } catch (err) {
      listErrors.push(`${c.name} (${c.id}): client folder / client.json failed: ${err.message}`);
    }
    if (++clientsDone % 25 === 0 || clientsDone === clients.length) await progress({ clients_done: clientsDone });
  })));

  // 3. Every report — skipping the ones a resumed run already filed.
  await progress({ stage: 'reports' });
  const done = new Set((await store.itemsFor(run.run_id)).filter((i) => i.ok).map((i) => i.report_id));
  const slots = limiter(concurrency());
  let reportsDone = done.size;
  let failed = 0;
  await store.updateRun(run.run_id, { set: { 'progress.reports_done': reportsDone, 'progress.reports_failed': 0 } });
  await Promise.all(clients.flatMap((c) => c.reports.filter((r) => !done.has(r.id)).map((r) => slots(async () => {
    const folderId = clientFolders.get(c.id);
    const result = folderId
      ? await backup.backupReport({ clientId: c.id, report: r, parentFolderId: folderId, exportedAt: run.started_at })
      : { ok: false, error: 'the client folder could not be made', files: [], warnings: [], bytes: 0, report: null, artifacts: 0 };
    const item = itemFrom(run, c, r, result);
    await store.saveItem(item);
    reportsDone++;
    if (!item.ok) {
      failed++;
      log.error('Plextrac backup: report FAILED', { run_id: run.run_id, client: c.name, report: r.name, report_id: r.id, reason: item.error });
    }
    await store.updateRun(run.run_id, { set: { 'progress.reports_done': reportsDone, 'progress.reports_failed': failed } });
    if (reportsDone % 25 === 0) log.info('Plextrac backup: progress', { run_id: run.run_id, done: reportsDone, of: reportsTotal, failed });
  }))));
}

function itemFrom(run, client, report, result) {
  const count = (kind) => result.files.filter((f) => f.kind === kind).length;
  return {
    run_id: run.run_id,
    client_id: client.id,
    client_name: client.name,
    report_id: report.id,
    name: result.report?.name ?? report.name,
    status: result.report?.status ?? report.status,
    ok: result.ok,
    error: result.error,
    warnings: result.warnings,
    folder_url: result.folder_url,
    ptrac: count('ptrac'),
    pdfs: count('document'),
    artifacts: count('artifact'),
    artifacts_listed: result.artifacts,
    files: result.files.length,
    bytes: result.bytes,
    cuid: result.report?.cuid ?? null,
    hash: result.report?.hash ?? null,
    findings: result.report?.findings ?? null,
  };
}

async function finishRun(run) {
  await store.updateRun(run.run_id, { set: { 'progress.stage': 'finishing' } });
  const items = await store.itemsFor(run.run_id);
  const sum = (k) => items.reduce((n, i) => n + (i[k] || 0), 0);
  const totals = {
    clients: run.clients.length,
    reports: items.length,
    reports_ok: items.filter((i) => i.ok).length,
    reports_failed: items.filter((i) => !i.ok).length,
    ptrac: sum('ptrac'),
    pdfs: sum('pdfs'),
    artifacts: sum('artifacts'),
    files: sum('files') + run.clients.length, // + each client.json
    bytes: sum('bytes'),
    list_errors: (run.list_errors || []).length,
  };

  // What changed since the last finished run.
  const previous = await store.lastFinishedRun({ before: run.started_at });
  const previousItems = previous ? await store.itemsFor(previous.run_id) : [];
  const changes = diffRuns({
    previous, previousItems, clients: run.clients, items,
    scope: run.client_filter ? new Set(run.client_filter) : null,
  });

  const finishedAt = new Date();
  const durationMs = finishedAt - new Date(run.started_at);
  const status = totals.reports_failed || totals.list_errors ? 'completed_with_errors' : 'completed';
  const summary = { ...run, status, totals, finished_at: finishedAt, duration_ms: durationMs };

  const text = renderChanges({ run: summary, previous, changes, items, listErrors: run.list_errors || [] });
  const files = {};
  try {
    const changesFile = await drive.uploadFile({
      buffer: Buffer.from(text), filename: 'changes.md', mimeType: 'text/markdown', folderId: run.folder.id, overwrite: true,
    });
    files.changes_file = { id: changesFile.fileId, url: changesFile.url };
    const { clients, ...head } = summary;
    const manifest = await drive.uploadFile({
      buffer: Buffer.from(JSON.stringify({ ...head, changes: changes.counts, clients, reports: items }, null, 2)),
      filename: 'manifest.json', mimeType: backup.JSON_MIME, folderId: run.folder.id, overwrite: true,
    });
    files.manifest_file = { id: manifest.fileId, url: manifest.url };
  } catch (err) {
    log.error('Plextrac backup: changes.md / manifest.json could not be written', { run_id: run.run_id, reason: err.message });
  }

  await store.updateRun(run.run_id, {
    set: {
      status, totals, finished_at: finishedAt, duration_ms: durationMs, ...files,
      changes: changes.counts,
      compared_with: previous ? { run_id: previous.run_id, sequence: previous.sequence, name: previous.folder?.name } : null,
      'progress.stage': 'done',
    },
  });
  await store.pruneItems().catch((err) => log.warn('Plextrac backup: old report records not pruned', { reason: err.message }));

  const line = `${totals.clients} clients, ${totals.reports} reports, ${totals.pdfs} PDFs, ${totals.ptrac} .ptrac, `
    + `${totals.artifacts} artifacts, ${formatSize(totals.bytes)} in ${formatDuration(durationMs)}`;
  log.info(`Plextrac backup FINISHED${status === 'completed' ? '' : ' WITH PROBLEMS'}`, {
    run_id: run.run_id, folder: run.folder.name, ...totals, took: formatDuration(durationMs),
  });
  if (run.kind !== 'test') {
    const c = changes.counts;
    const changed = changes.first ? 'first backup' : `${c.reports_new} new, ${c.reports_changed} changed, ${c.reports_removed} removed`;
    log.notify(`${status === 'completed' ? ':floppy_disk:' : ':warning:'} Plextrac weekly backup <${run.folder.url}|${run.folder.name}>: ${line}. `
      + `Since last week: ${changed}.${totals.reports_failed ? ` *${totals.reports_failed} report(s) failed* — see changes.md.` : ''}`);
  }
  return store.getRun(run.run_id);
}

// ── Change log ────────────────────────────────────────────────────────────────

/**
 * What changed between the previous run and this one. `scope` limits the comparison to
 * those client ids (a test run backs up only a few).
 */
function diffRuns({ previous, previousItems, clients, items, scope = null }) {
  const inScope = (clientId) => !scope || scope.has(Number(clientId));
  const out = {
    first: !previous,
    clientsNew: [], clientsRemoved: [], clientsRenamed: [],
    reportsNew: [], reportsRemoved: [], reportsChanged: [], reportsUnchanged: 0, reportsNotCompared: [],
    failed: items.filter((i) => !i.ok),
  };
  if (previous) {
    const prevClients = new Map((previous.clients || []).filter((c) => inScope(c.id)).map((c) => [c.id, c]));
    const curClients = new Map(clients.map((c) => [c.id, c]));
    for (const c of clients) {
      const p = prevClients.get(c.id);
      if (!p) out.clientsNew.push(c);
      else if (p.name !== c.name) out.clientsRenamed.push({ id: c.id, from: p.name, to: c.name });
    }
    for (const p of prevClients.values()) if (!curClients.has(p.id)) out.clientsRemoved.push(p);

    const prev = new Map(previousItems.filter((i) => inScope(i.client_id)).map((i) => [i.report_id, i]));
    const cur = new Map(items.map((i) => [i.report_id, i]));
    for (const i of items) {
      const p = prev.get(i.report_id);
      if (!p) { out.reportsNew.push(i); continue; }
      if (!i.hash || !p.hash) { out.reportsNotCompared.push(i); continue; }
      const details = describeChange(p, i);
      if (details.length) out.reportsChanged.push({ item: i, details });
      else out.reportsUnchanged++;
    }
    for (const p of prev.values()) if (!cur.has(p.report_id)) out.reportsRemoved.push(p);
  }
  out.counts = {
    first: out.first,
    clients_new: out.clientsNew.length,
    clients_removed: out.clientsRemoved.length,
    clients_renamed: out.clientsRenamed.length,
    reports_new: out.first ? items.length : out.reportsNew.length,
    reports_removed: out.reportsRemoved.length,
    reports_changed: out.reportsChanged.length,
    reports_unchanged: out.reportsUnchanged,
    reports_failed: out.failed.length,
  };
  return out;
}

// The differences between two records of one report, in words. Empty when unchanged.
function describeChange(p, i) {
  const details = [];
  if (p.name !== i.name) details.push(`renamed from "${p.name}"`);
  if (p.client_id !== i.client_id) details.push(`moved from client "${p.client_name}"`);
  if (p.status !== i.status) details.push(`status ${p.status || '—'} → ${i.status || '—'}`);

  const before = new Map((p.findings || []).map((f) => [String(f.id), f]));
  const after = new Map((i.findings || []).map((f) => [String(f.id), f]));
  const added = [...after.values()].filter((f) => !before.has(String(f.id)));
  const removed = [...before.values()].filter((f) => !after.has(String(f.id)));
  const updated = [...after.values()].filter((f) => {
    const o = before.get(String(f.id));
    return o && (o.last_update !== f.last_update || o.title !== f.title || o.severity !== f.severity || o.status !== f.status);
  });
  const titles = (list) => list.slice(0, 5).map((f) => `"${f.title}"`).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');
  if (added.length) details.push(`${added.length} finding(s) added: ${titles(added)}`);
  if (removed.length) details.push(`${removed.length} finding(s) removed: ${titles(removed)}`);
  if (updated.length) details.push(`${updated.length} finding(s) updated: ${titles(updated)}`);
  if ((p.artifacts_listed ?? 0) !== (i.artifacts_listed ?? 0)) details.push(`artifacts ${p.artifacts_listed ?? 0} → ${i.artifacts_listed ?? 0}`);
  if (!details.length && p.hash !== i.hash) details.push('content edited (narratives, assets or screenshots)');
  return details;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function renderChanges({ run, previous, changes, items, listErrors }) {
  const t = run.totals;
  const c = changes.counts;
  const lines = [];
  const where = (i) => `${i.client_name} / ${i.name}`;
  const section = (title, list, fmt) => {
    if (!list.length) return;
    lines.push('', `## ${title} (${list.length})`, '');
    for (const x of list) lines.push(`- ${fmt(x)}`);
  };

  lines.push(`# Plextrac backup ${run.folder.name}${run.kind === 'test' ? ' (test run)' : ''}`, '');
  lines.push(`Started ${new Date(run.started_at).toLocaleString('en-GB', { timeZone: TZ })}, took ${formatDuration(run.duration_ms)}.`);
  lines.push(`Backed up ${t.clients} clients, ${t.reports} reports: ${t.ptrac} .ptrac, ${t.pdfs} PDFs, ${t.artifacts} artifacts — ${formatSize(t.bytes)}.`);
  if (t.reports_failed || t.list_errors) lines.push(`**${t.reports_failed} report(s) failed${t.list_errors ? `, ${t.list_errors} client problem(s)` : ''}** — listed below.`);
  lines.push('');
  if (changes.first) {
    lines.push('First backup — there is no earlier run to compare with.');
  } else {
    lines.push(`Compared with ${previous.folder?.name}${run.client_filter ? ' (only the clients in this test run)' : ''}:`);
    lines.push(`- Clients: ${c.clients_new} new, ${c.clients_removed} removed, ${c.clients_renamed} renamed`);
    lines.push(`- Reports: ${c.reports_new} new, ${c.reports_changed} changed, ${c.reports_removed} removed, ${c.reports_unchanged} unchanged`);
  }

  section('Failed', changes.failed, (i) => `${where(i)} — ${i.error}`);
  section('Client problems', listErrors, (e) => e);
  section('New clients', changes.clientsNew, (cl) => `${cl.name} (${cl.id}) — ${cl.report_count} report(s)`);
  section('Removed clients', changes.clientsRemoved, (cl) => `${cl.name} (${cl.id})`);
  section('Renamed clients', changes.clientsRenamed, (cl) => `"${cl.from}" → "${cl.to}" (${cl.id})`);
  section('New reports', changes.reportsNew, (i) => `${where(i)} — ${i.status || 'no status'}, ${(i.findings || []).length} finding(s)`);
  section('Removed reports', changes.reportsRemoved, (i) => `${where(i)} (was ${i.status || 'no status'}) — last copy in ${previous?.folder?.name}`);
  section('Changed reports', changes.reportsChanged, ({ item, details }) => `${where(item)} — ${details.join('; ')}`);
  section('Not compared (a backup failed last time or this time)', changes.reportsNotCompared, (i) => where(i));
  if (changes.first) section('Reports', items, (i) => `${where(i)} — ${i.status || 'no status'}, ${(i.findings || []).length} finding(s)`);
  lines.push('');
  return lines.join('\n');
}

// ── Status, schedule, startup ─────────────────────────────────────────────────

// What the SFE scheduling page shows: the last finished run, one in progress, the
// next scheduled time.
async function getStatus() {
  const running = (await store.runningRuns()).filter((r) => r.kind !== 'test' && isFresh(r));
  const [last, recent] = await Promise.all([store.lastFinishedRun(), store.recentRuns({ limit: 6 })]);
  const lean = (r) => r && (({ clients, list_errors, owner: o, ...rest }) => rest)(r);
  return {
    schedule: {
      enabled: Boolean(CRON),
      cron: CRON || null,
      timezone: TZ,
      description: CRON === '0 22 * * 5' ? 'Every Friday at 22:00 (UK time)' : CRON ? `cron "${CRON}" (${TZ})` : 'Not scheduled',
      next_run_at: scheduled?.getNextRun() ?? null,
    },
    folder_url: drive.driveFolderUrl(rootFolder()),
    documents_per_report: DOCUMENTS.map((d) => d.name),
    running: lean(running[0] || null),
    last: lean(last),
    recent: recent.map(lean),
  };
}

// Runs found "running" at startup that this server was running before it restarted
// (or that nobody has touched for a while) are resumed if recent, else closed off.
async function recoverRuns() {
  for (const run of await store.runningRuns()) {
    if (run.kind === 'test') continue;
    const mine = run.owner?.role === 'server' && run.owner?.host === os.hostname() && run.owner?.pid !== process.pid;
    if (!mine && isFresh(run)) continue; // alive in another process
    if (Date.now() - new Date(run.started_at).getTime() < RESUME_WITHIN_MS) {
      log.warn('Plextrac backup: resuming a run the restart interrupted', { run_id: run.run_id, folder: run.folder?.name });
      runBackup({ resumeRunId: run.run_id }).catch((err) => log.error('Plextrac backup resume failed', { reason: err.message }));
      return; // one at a time
    }
    await store.updateRun(run.run_id, { set: { status: 'interrupted', finished_at: new Date(), error: 'stopped part-way and too old to resume' } });
    log.warn('Plextrac backup: an old interrupted run was closed off', { run_id: run.run_id, folder: run.folder?.name });
  }
}

/** Schedules the weekly run (unless PLEXTRAC_BACKUP_CRON is blank) and recovers an interrupted one. */
function startSchedule() {
  if (CRON) {
    scheduled = cron.schedule(CRON, () => {
      log.info('[cron] Triggering weekly Plextrac backup…', {});
      runBackup({ kind: 'scheduled' }).catch((err) => log.error('Plextrac backup failed', { reason: err.message }));
    }, { timezone: TZ, name: 'plextrac-backup' });
    log.info('Plextrac weekly backup scheduled', { cron: CRON, timezone: TZ, next_run: scheduled.getNextRun()?.toISOString() });
  } else {
    log.warn('Plextrac weekly backup NOT scheduled — PLEXTRAC_BACKUP_CRON is blank', {});
  }
  // Give the server a minute to settle before picking up a long run again.
  setTimeout(() => recoverRuns().catch((err) => log.error('Plextrac backup recovery failed', { reason: err.message })), 60 * 1000).unref();
}

module.exports = {
  runBackup,
  getStatus,
  startSchedule,
  recoverRuns,
  // exposed for tests
  diffRuns,
  describeChange,
  renderChanges,
  nextSequence,
  formatDuration,
};
