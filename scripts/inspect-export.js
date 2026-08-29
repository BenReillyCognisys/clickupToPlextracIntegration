// Usage: node scripts/inspect-export.js [clientId reportId]
//
// Confirms the Plextrac report-export endpoint against the live instance — the one
// assumption pipeline/report-export.js can't verify offline. With no arguments it uses
// the most recent MongoDB mapping.
//
// It tries the configured path (PLEXTRAC_EXPORT_PATH, or the v1 default) first, then a
// few known alternates, and reports for each: HTTP status, content-type, size, and
// whether the body actually starts with "%PDF-". Nothing is written anywhere.
//
// If a different path is the one that works, set it in .env:
//   PLEXTRAC_EXPORT_PATH=/api/v2/...{clientId}...{reportId}...{format}
require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../lib/mongodb');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;
const FORMAT = (process.env.PLEXTRAC_EXPORT_FORMAT || 'pdf').toLowerCase();

// The configured path first, then the shapes seen across Plextrac versions.
const CANDIDATES = [
  process.env.PLEXTRAC_EXPORT_PATH,
  '/api/v1/client/{clientId}/report/{reportId}/export/{format}',
  '/api/v1/client/{clientId}/report/{reportId}/export?type={format}',
  '/api/v1/client/{clientId}/report/{reportId}/export?format={format}',
  '/api/v1/client/{clientId}/report/{reportId}/export',
  '/api/v2/client/{clientId}/report/{reportId}/export/{format}',
  '/api/v1/client/{clientId}/report/{reportId}/{format}',
].filter(Boolean);

const fill = (path, clientId, reportId) => path
  .replace('{clientId}', clientId)
  .replace('{reportId}', reportId)
  .replace('{format}', FORMAT);

(async () => {
  const { data: auth } = await axios.post(`${BASE}/api/v1/authenticate`, {
    username: process.env.PLEXTRAC_USERNAME,
    password: process.env.PLEXTRAC_PASSWORD,
  });
  const headers = { Authorization: auth.token };

  let [, , clientId, reportId] = process.argv;
  if (!clientId || !reportId) {
    const db = await getDb();
    const mapping = await db.collection('task_mappings').findOne({}, { sort: { created_at: -1 } });
    if (!mapping) {
      console.error('No mappings in MongoDB — pass clientId and reportId as arguments');
      process.exit(1);
    }
    ({ plextrac_client_id: clientId, plextrac_report_id: reportId } = mapping);
    console.log(`Using most recent mapping: ${mapping.task_name}`);
  }
  console.log(`Client ${clientId}, report ${reportId}, format ${FORMAT}\n`);

  console.log(`Authenticating as: ${process.env.PLEXTRAC_USERNAME}`);
  console.log('');

  // Does this account have plain READ access to the client and report? That is what
  // separates the two causes of "User is not authorized to perform this action":
  //   reads OK + export refused -> the ROLE is missing the export permission
  //   reads refused too         -> the account has no access to this CLIENT at all
  console.log('Read access (for comparison with the export attempts below):');
  for (const [, path] of [
    ['client', `/api/v1/client/${clientId}`],
    ['report', `/api/v1/client/${clientId}/report/${reportId}`],
  ]) {
    const res = await axios.get(`${BASE}${path}`, { headers, validateStatus: () => true });
    const ok = res.status === 200;
    console.log(`  ${ok ? 'OK' : '--'}  ${res.status}  GET ${path}`);
    if (!ok) console.log(`      ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  console.log('');

  for (const candidate of CANDIDATES) {
    const path = fill(candidate, clientId, reportId);
    try {
      const res = await axios.get(`${BASE}${path}`, {
        headers, responseType: 'arraybuffer', validateStatus: () => true,
      });
      const buf = Buffer.from(res.data || []);
      const isPdf = buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
      const marker = res.status === 200 && isPdf ? 'PDF ✔' : '—';
      console.log(`${marker}  ${res.status}  ${path}`);
      console.log(`      content-type: ${res.headers['content-type'] || '(none)'}  bytes: ${buf.length}`);
      if (!isPdf && buf.length) {
        console.log(`      body: ${buf.subarray(0, 300).toString('utf8').replace(/\s+/g, ' ').trim()}`);
      }
    } catch (err) {
      console.log(`—     ERR  ${path}`);
      console.log(`      ${err.message}`);
    }
    console.log('');
  }

  console.log('Set PLEXTRAC_EXPORT_PATH to whichever line shows "PDF ✔" (keep the {token}s).');
  console.log('A 404 "Not Found" means the route does not exist. A 400/403 authorization');
  console.log('message means it DOES exist and refused the caller — the path is fine and the');
  console.log('Plextrac account needs the permission. Compare with the read-access lines above.');
  process.exit(0);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
