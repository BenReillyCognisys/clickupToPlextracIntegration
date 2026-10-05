// Usage: node scripts/seed-report-statuses.js
//
// Records the current status of every Plextrac report in plextrac_report_status
// (lib/report-status-store.js), so the status guard (pipeline/status-guard.js) knows
// what to put a report back to from the first webhook onwards. Run once on deploy.
//
// Only reads from Plextrac. Never overwrites a status the webhook has already recorded,
// so it is safe to re-run.
require('dotenv').config();
const api = require('../lib/plextrac-api');
const statusStore = require('../lib/report-status-store');
const { limiter } = require('../lib/concurrency');

(async () => {
  const clients = (await api.listClients()).map((c) => ({ id: Number(c.data[0]), name: String(c.data[1] ?? '') }));
  console.log(`${clients.length} clients — listing their reports…`);
  const slots = limiter(5);
  const rows = [];
  let failed = 0;
  await Promise.all(clients.map((c) => slots(async () => {
    try {
      for (const r of await api.listClientReports(c.id)) {
        if (Array.isArray(r.data) && r.data[3]) rows.push({ clientId: c.id, reportId: Number(r.data[0]), status: r.data[3] });
      }
    } catch (err) {
      failed++;
      console.log(`  could not list reports of ${c.name} (${c.id}): ${err.message}`);
    }
  })));
  const counts = rows.reduce((m, r) => m.set(r.status, (m.get(r.status) || 0) + 1), new Map());
  console.log(`${rows.length} reports: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}`);
  const added = await statusStore.seed(rows);
  console.log(`Recorded ${added} report status(es); ${rows.length - added} already known.${failed ? ` ${failed} client(s) could not be listed.` : ''}`);
  process.exit(0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
