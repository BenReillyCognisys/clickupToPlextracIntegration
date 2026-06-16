/**
 * Prints the names of all report templates, findings layouts, and users.
 * Use this to confirm the exact values for PLEXTRAC_REPORT_TEMPLATE and
 * PLEXTRAC_FINDINGS_LAYOUT in your .env.
 *
 * Run: node scripts/list-plextrac-config.js
 */
require('dotenv').config();
const api = require('../lib/plextrac-api');

(async () => {
  console.log('\n── Report Templates ──────────────────────────────────');
  const templates = await api.listReportTemplates();
  (templates || []).forEach(t => console.log(' ', t.data?.template_name || t.data?.name || JSON.stringify(t)));

  console.log('\n── Findings Layouts ──────────────────────────────────');
  const layouts = await api.listFieldTemplates();
  (layouts || []).forEach(l => console.log(' ', l.data?.name || l.data?.template_name || JSON.stringify(l)));

  console.log('\n── Users ─────────────────────────────────────────────');
  const users = await api.listUsers();
  (users || []).forEach(u => console.log(' ', u.email || u.data?.email || JSON.stringify(u)));

  console.log('');
})().catch(err => { console.error(err.message); process.exit(1); });
