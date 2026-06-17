// One-time migration: fetches the CUID for every existing MongoDB mapping that
// was created before CUID storage was added, and backfills the field.
// Run once: node scripts/backfill-report-cuids.js
require('dotenv').config();
const axios = require('axios');
const { getDb } = require('../lib/mongodb');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

(async () => {
  const { data: auth } = await axios.post(`${BASE}/api/v1/authenticate`, {
    username: process.env.PLEXTRAC_USERNAME,
    password: process.env.PLEXTRAC_PASSWORD,
  });
  const headers = { Authorization: auth.token, 'Content-Type': 'application/json' };

  const db = await getDb();
  const col = db.collection('task_mappings');

  const missing = await col.find({ plextrac_report_cuid: { $exists: false } }).toArray();
  console.log(`Found ${missing.length} mapping(s) without a CUID.`);

  for (const doc of missing) {
    try {
      const { data: report } = await axios.get(
        `${BASE}/api/v1/client/${doc.plextrac_client_id}/report/${doc.plextrac_report_id}`,
        { headers }
      );
      const cuid = report?.cuid;
      if (!cuid) {
        console.warn(`  [SKIP] No CUID in response for report ${doc.plextrac_report_id} (${doc.task_name})`);
        continue;
      }
      await col.updateOne(
        { _id: doc._id },
        { $set: { plextrac_report_cuid: cuid, updated_at: new Date() } }
      );
      console.log(`  [OK]   ${doc.task_name} → cuid=${cuid}`);
    } catch (err) {
      console.error(`  [ERR]  ${doc.task_name}: ${err.response?.data?.message ?? err.message}`);
    }
  }

  console.log('\nBackfill complete.');
  process.exit(0);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
