// Usage: node scripts/inspect-report.js
// Fetches the most recent MongoDB mapping and dumps the full Plextrac report JSON.
// Run this to discover whether the v1 report object contains a CUID field.
require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../lib/mongodb');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

(async () => {
  // Authenticate
  const { data: auth } = await axios.post(`${BASE}/api/v1/authenticate`, {
    username: process.env.PLEXTRAC_USERNAME,
    password: process.env.PLEXTRAC_PASSWORD,
  });
  const headers = { Authorization: auth.token, 'Content-Type': 'application/json' };

  // Get most-recent mapping from MongoDB
  const db = await getDb();
  const mapping = await db.collection('task_mappings').findOne({}, { sort: { created_at: -1 } });
  if (!mapping) {
    console.error('No mappings found in MongoDB');
    process.exit(1);
  }
  console.log('Using mapping:', {
    task: mapping.task_name,
    plextrac_client_id: mapping.plextrac_client_id,
    plextrac_report_id: mapping.plextrac_report_id,
  });

  // Fetch the full report
  const { data: report } = await axios.get(
    `${BASE}/api/v1/client/${mapping.plextrac_client_id}/report/${mapping.plextrac_report_id}`,
    { headers }
  );
  console.log('\nFull report response:\n', JSON.stringify(report, null, 2));

  process.exit(0);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
