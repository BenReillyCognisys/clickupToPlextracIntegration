// Usage: node scripts/inspect-users.js
//
// Confirms the Plextrac users endpoint used by the /report-kpis leaderboard to map a
// webhook's `actorCuid` back to a real consultant. Prints the raw response and, for
// each user, the fields we key on (cuid / id / name / email) after normalisation.
//
// If the default path is wrong for your instance, set PLEXTRAC_USERS_PATH (use the
// literal `{tenantId}` token where the id belongs) and re-run.
require('dotenv').config();
const api = require('../lib/plextrac-api');
const { rowsOf, normaliseUser } = require('../lib/plextrac-users');

(async () => {
  const res = await api.listTenantUsers();

  const rows = rowsOf(res);
  console.log(`\nEndpoint returned ${rows.length} row(s).`);

  // Show one raw row so the field names are visible if normalisation misses.
  if (rows.length) {
    console.log('\n── First raw row ─────────────────────────────────────');
    console.log(JSON.stringify(rows[0], null, 2));
  }

  console.log('\n── Normalised users (cuid → name / email) ────────────');
  let matched = 0;
  for (const row of rows) {
    const u = normaliseUser(row);
    if (!u) continue;
    matched++;
    console.log(`  ${u.cuid}  ${u.name || '(no name)'}${u.email ? `  <${u.email}>` : ''}`);
  }
  console.log(`\n${matched} of ${rows.length} row(s) had a usable cuid.`);
  if (!matched) {
    console.log('\n⚠  No rows had a cuid — the cross-reference for /report-kpis will not work.');
    console.log('   Inspect the raw row above and adjust normaliseUser() / PLEXTRAC_USERS_PATH.');
  }

  process.exit(0);
})().catch(err => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
