// Plextrac webhook events to ignore for a while, because this service caused them.
//
// A client merge imports each report into the kept client as a NEW report, and may
// put its name or status back afterwards. If Plextrac fires ReportStatusChanged for
// that, the webhook (routes/plextrac-webhook.js) would treat it as real work: an AI QA
// review, a second-round QA post, release exports and a release announcement, KPI
// credit — for a report that was only moved. So while a merge is importing a report,
// that report is suppressed here and the webhook drops its events.
//
// A report is matched by its cuid (known once the import has landed) or by its client
// and report names (all an event carries before then, in the "<client>||<report>"
// text).
//
// Shared through MongoDB (webhook_suppressions, expired by a TTL index), so a
// suppression made by another process — scripts/live-test-client-merge.js running
// beside the server — reaches the server's webhook handler too. Also held in memory,
// so the process that made it never depends on Mongo to honour it. Mongo failures are
// logged and never thrown: a merge doesn't stop over it, and a webhook goes through.

const { getDb } = require('./mongodb');
const log = require('./logger');

const entries = new Map(); // key -> expiry (ms since epoch)

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const cuidKey = (cuid) => `cuid:${cuid}`;
const nameKey = (clientName, reportName) => `name:${norm(clientName)}||${norm(reportName)}`;

let collection = null;
async function col() {
  if (!collection) {
    collection = (async () => {
      const c = (await getDb()).collection('webhook_suppressions');
      await c.createIndex({ key: 1 }, { unique: true, background: true });
      await c.createIndex({ until: 1 }, { expireAfterSeconds: 0, background: true });
      return c;
    })().catch((err) => { collection = null; throw err; });
  }
  return collection;
}

function keysFor({ cuid, clientName, reportName }) {
  return [cuid && cuidKey(cuid), clientName && reportName && nameKey(clientName, reportName)].filter(Boolean);
}

/** Suppress events for a report, by cuid and/or names, for `ms`. */
async function suppress({ cuid, clientName, reportName, reason }, ms = 15 * 60 * 1000) {
  const keys = keysFor({ cuid, clientName, reportName });
  const until = Date.now() + ms;
  for (const key of keys) entries.set(key, Math.max(entries.get(key) || 0, until));
  try {
    const c = await col();
    await Promise.all(keys.map((key) => c.updateOne(
      { key },
      { $max: { until: new Date(until) }, $set: { reason: reason || null, updated_at: new Date() } },
      { upsert: true },
    )));
  } catch (err) {
    log.warn('Webhook suppression not shared — only this process will ignore the events', { keys, reason: err.message });
  }
}

/** Lifts a suppression early (both here and for other processes). */
async function release({ cuid, clientName, reportName }) {
  const keys = keysFor({ cuid, clientName, reportName });
  for (const key of keys) entries.delete(key);
  try {
    await (await col()).deleteMany({ key: { $in: keys } });
  } catch (err) {
    log.warn('Webhook suppression could not be lifted in MongoDB — it expires on its own', { keys, reason: err.message });
  }
}

// The webhook's "<client name>||<report name>" text, when it is in that form.
function namesFromText(text) {
  const [clientName, reportName] = String(text ?? '').split('||');
  return reportName != null ? { clientName, reportName } : null;
}

/** Is this webhook event about a report being moved (here or by another process)? */
async function isSuppressed({ cuid, text }) {
  const names = namesFromText(text);
  const keys = keysFor({ cuid, ...(names || {}) });
  const now = Date.now();
  for (const [key, until] of entries) if (until <= now) entries.delete(key);
  if (keys.some((key) => entries.has(key))) return true;
  if (!keys.length) return false;
  try {
    // The TTL index removes expired rows only once a minute, so check `until` too.
    return Boolean(await (await col()).findOne({ key: { $in: keys }, until: { $gt: new Date() } }, { projection: { _id: 1 } }));
  } catch (err) {
    log.warn('Webhook suppression check failed — handling the event', { reason: err.message });
    return false;
  }
}

function clear() {
  entries.clear();
}

module.exports = { suppress, release, isSuppressed, clear, nameKey };
