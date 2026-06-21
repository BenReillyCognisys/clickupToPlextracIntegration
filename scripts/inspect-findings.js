// Usage: node scripts/inspect-findings.js
// Fetches the most recent MongoDB mapping and dumps the report's findings
// ("flaws") JSON, so you can confirm the real field shapes the QA pipeline edits
// (description / recommendations / etc.) against your Plextrac instance.
require('dotenv').config();
const api = require('../lib/plextrac-api');
const { getDb } = require('../lib/mongodb');

(async () => {
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

  const list = await api.listReportFindings(mapping.plextrac_client_id, mapping.plextrac_report_id);
  console.log('\nFindings list response:\n', JSON.stringify(list, null, 2));

  const first = Array.isArray(list) ? list[0] : list?.data?.[0];
  const id = first?.id ?? first?.flaw_id ?? (Array.isArray(first?.data) ? first.data[0] : undefined);
  if (id != null) {
    const full = await api.getFinding(mapping.plextrac_client_id, mapping.plextrac_report_id, id);
    console.log(`\nFull finding ${id}:\n`, JSON.stringify(full, null, 2));
  }

  process.exit(0);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
