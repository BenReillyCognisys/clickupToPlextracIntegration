// Client names for QA queue entries that were queued without one (a DeliveryFlow
// engagement recorded without its client name, or an older report), looked up from
// Plextrac. A name found is kept on the queue entry, so each is looked up once; Plextrac
// clients are also remembered for the life of the process.

const api = require('./plextrac-api');
const fields = require('../pipeline/qa-review/report-fields');
const log = require('./logger');

const CONCURRENCY = 4;
const names = new Map(); // String(client id) -> name

// The entry's Plextrac client id: as recorded, else from its report link
// (…/client/<id>/report/<id>).
function clientIdOf(entry) {
  if (entry.client_id != null && entry.client_id !== '') return entry.client_id;
  const m = String(entry.report_url || '').match(/\/client\/(\d+)\/report\//);
  return m ? Number(m[1]) : null;
}

/** The client's name in Plextrac, or null when it can't be read. Never throws. */
async function clientNameFor(clientId) {
  if (clientId == null || clientId === '') return null;
  const key = String(clientId);
  if (names.has(key)) return names.get(key);
  try {
    const name = fields.clientNameFromRecord(await api.getClient(clientId), null);
    if (name) names.set(key, name);
    return name || null;
  } catch (err) {
    log.warn('QA queue: could not read the client name from Plextrac', { client_id: clientId, reason: err.message });
    return null;
  }
}

/**
 * Fills in client_name on the entries that lack one, in place, and saves each name
 * found with `save(reportId, name, clientId)`. Resolves once every lookup is done.
 */
async function fillClientNames(entries, save) {
  const missing = entries.filter((e) => !e.client_name && clientIdOf(e) != null);
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const e = missing[i++];
      const clientId = clientIdOf(e);
      const name = await clientNameFor(clientId);
      if (!name) continue;
      e.client_name = name;
      if (e.client_id == null) e.client_id = clientId;
      await Promise.resolve(save(e.report_id, name, clientId)).catch((err) =>
        log.warn('QA queue: could not save the client name', { report_id: e.report_id, reason: err.message }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return entries;
}

module.exports = { fillClientNames, clientNameFor, clientIdOf };
