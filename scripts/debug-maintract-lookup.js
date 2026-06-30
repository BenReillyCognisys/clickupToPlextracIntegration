/**
 * Diagnoses why the Plextrac webhook could not resolve a client/report from the
 * substituted names. Run on the server (where .env has the Plextrac creds):
 *
 *   node scripts/debug-maintract-lookup.js
 *
 * Override the names via argv if needed:
 *   node scripts/debug-maintract-lookup.js "Client" "Report name"
 */
require('dotenv').config();
const api = require('../lib/plextrac-api');

const CLIENT = process.argv[2] || 'Maintract';
const REPORT = process.argv[3] || 'Maintract | Blackbox Web app | June 2026';

const rowId   = r => (Array.isArray(r.data) ? r.data[0] : (r.client_id ?? r.id));
const rowName = r => String(Array.isArray(r.data) ? (r.data[1] ?? '') : (r.name ?? ''));
const normalise = s => String(s)
  .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();
// Show exact bytes so an nbsp / zero-width char is visible.
const show = s => JSON.stringify(s) + '  (codepoints: ' +
  [...String(s)].map(c => c.codePointAt(0)).join(',') + ')';

(async () => {
  const clients = await api.listClients();
  console.log(`\ntotal clients returned by API: ${(clients || []).length}`);

  const fuzzy = (clients || []).filter(c => /maintract/i.test(rowName(c)));
  console.log(`\n── clients matching /maintract/i ──`);
  fuzzy.forEach(c => console.log(`  id=${rowId(c)}  name=${show(rowName(c))}`));

  const matches = (clients || []).filter(c => normalise(rowName(c)) === normalise(CLIENT));
  console.log(`\nexact (normalised) client matches for ${JSON.stringify(CLIENT)}: ${matches.length}`);
  if (!matches.length) {
    console.log('  → CLIENT lookup is the failure. Name in webhook does not match any API client name.');
    return;
  }

  for (const c of matches) {
    const cid = rowId(c);
    const reports = await api.listClientReports(cid);
    console.log(`\n── reports under client ${cid} (${(reports || []).length} total) ──`);
    (reports || []).forEach(r => console.log(`  id=${rowId(r)}  name=${show(rowName(r))}`));
    const hit = (reports || []).find(r => normalise(rowName(r)) === normalise(REPORT));
    console.log(`  report match under ${cid}: ${hit ? rowId(hit) : 'NONE'}`);
  }
  console.log(`\nlooking for report: ${show(REPORT)}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
