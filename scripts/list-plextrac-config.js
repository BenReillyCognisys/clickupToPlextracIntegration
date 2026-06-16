/**
 * Diagnostic: prints all report templates, findings layouts, and users
 * from your Plextrac instance so you can confirm the exact names to set
 * in PLEXTRAC_REPORT_TEMPLATE and PLEXTRAC_FINDINGS_LAYOUT.
 *
 * Run: node scripts/list-plextrac-config.js
 */
require('dotenv').config();
const api = require('../lib/plextrac-api');

async function section(title, fn) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
  try {
    const raw = await fn();
    console.log('Raw response:');
    console.log(JSON.stringify(raw, null, 2));
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }
}

(async () => {
  await section('Report Templates  (PLEXTRAC_REPORT_TEMPLATE)', () => api.listReportTemplates());
  await section('Findings Layouts  (PLEXTRAC_FINDINGS_LAYOUT)', () => api.listFieldTemplates());
  await section('Users  (operator/reviewer email mapping)', () => api.listUsers());
})();
