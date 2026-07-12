// One-shot backfill for the QA queue (POST /jobs/qa-queue-seed).
//
// The queue is normally maintained incrementally by the Plextrac webhook, so reports
// already sitting in QA when the feature deployed never got an event and are missing.
// This walks the whole Plextrac tenant — every client, every report — reads each
// report's authoritative status (getReport().status, same signal the webhook uses)
// and seeds any that are in the first- or second-round QA stage. Reports that later
// change status are still corrected by the webhook, so re-running this is safe
// (upserts are idempotent; the incremental path owns removals on release).

const api = require('../lib/plextrac-api');
const qaQueue = require('../lib/qa-queue-store');
const log = require('../lib/logger');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// QA stage statuses — kept in step with routes/plextrac-webhook.js.
const QA_FIRST_STATUS  = process.env.PLEXTRAC_QA_FIRST_STATUS  || process.env.PLEXTRAC_QA_STATUS || 'Ready For Review';
const QA_SECOND_STATUS = process.env.PLEXTRAC_QA_SECOND_STATUS || 'In Review';

// How many reports to fetch concurrently. The token is already primed by the initial
// listClients() call, so the pool won't trigger a burst of parallel re-auths.
const CONCURRENCY = Number(process.env.QA_SEED_CONCURRENCY) || 5;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Maps a report status to its queue stage, or null when it isn't a QA stage.
function stageFor(status) {
  const s = norm(status);
  if (s === norm(QA_FIRST_STATUS)) return 'first';
  if (s === norm(QA_SECOND_STATUS)) return 'second';
  return null;
}

// Plextrac list rows come back as { id, data: [numericId, name, ...] } — same shape
// helpers used by lib/plextrac-lookup.js.
const rowId = (row) => (Array.isArray(row.data) ? row.data[0] : (row.client_id ?? row.id));
const rowName = (row) => String(Array.isArray(row.data) ? (row.data[1] ?? '') : (row.name ?? ''));
const rowsOf = (res) => (Array.isArray(res) ? res : (res?.data || []));

// Runs fn over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function seedQaQueue() {
  log.info('QA seed: starting tenant scan', {});

  let clients;
  try {
    clients = rowsOf(await api.listClients());
  } catch (err) {
    log.error('QA seed: failed to list clients — aborting', { reason: err.message });
    return { clients: 0, scanned: 0, seeded: 0, error: err.message };
  }

  // Collect every (client, report) reference first, then fetch statuses in a pool.
  const refs = [];
  for (const c of clients) {
    const clientId = rowId(c);
    const clientName = rowName(c);
    try {
      for (const r of rowsOf(await api.listClientReports(clientId))) {
        refs.push({ clientId, clientName, reportId: rowId(r), listName: rowName(r) });
      }
    } catch (err) {
      log.warn('QA seed: failed to list reports for client — skipping', { client_id: clientId, reason: err.message });
    }
  }

  let seeded = 0;
  await mapLimit(refs, CONCURRENCY, async ({ clientId, clientName, reportId, listName }) => {
    let report;
    try {
      report = await api.getReport(clientId, reportId);
    } catch (err) {
      log.warn('QA seed: failed to fetch report — skipping', { client_id: clientId, report_id: reportId, reason: err.message });
      return;
    }

    const stage = stageFor(report?.status);
    if (!stage) return;

    try {
      await qaQueue.upsert({
        reportId,
        cuid: report?.report_cuid || report?.cuid || null,
        clientId,
        clientName,
        reportName: report?.name || listName || `Report ${reportId}`,
        reportUrl: `${BASE}/client/${clientId}/report/${reportId}`,
        stage,
      });
      seeded++;
      log.info('QA seed: queued report', { client_id: clientId, report_id: reportId, stage, status: report.status });
    } catch (err) {
      log.error('QA seed: failed to upsert report', { report_id: reportId, reason: err.message });
    }
  });

  const summary = { clients: clients.length, scanned: refs.length, seeded };
  log.info('QA seed: complete', summary);
  return summary;
}

module.exports = { seedQaQueue, stageFor };
