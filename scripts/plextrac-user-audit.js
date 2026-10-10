// Usage: node scripts/plextrac-user-audit.js [--slack]
//
// Read-only. Runs the Plextrac user audit (pipeline/plextrac-user-audit.js) and prints
// every flagged user with all their clients. Posts nothing unless --slack is given.
require('dotenv').config();
const { auditUsers, runUserAudit } = require('../pipeline/plextrac-user-audit');

(async () => {
  if (process.argv.includes('--slack')) {
    const result = await runUserAudit();
    console.log(result ? `Posted: ${result.flagged.length} flagged.` : 'Audit failed — see the log above.');
    return;
  }
  const r = await auditUsers();
  console.log(`${r.checked} users · ${r.exempt} Cognisys (not checked) · ${r.clients} clients · ${r.flagged.length} flagged\n`);
  for (const u of r.flagged) {
    console.log(`${u.email}${u.disabled ? ' (disabled)' : ''}${u.name ? ` — ${u.name}` : ''}`);
    console.log(`   ${u.reasons.join('; ')}`);
    console.log(`   roles: ${u.roles.join(', ') || '(none)'}`);
    if (u.clients.length) console.log(`   clients (${u.clients.length}): ${u.clients.join(', ')}`);
  }
  if (r.clientErrors.length) {
    console.log(`\n${r.clientErrors.length} client(s) couldn't be read (counts may be low):`);
    r.clientErrors.forEach((e) => console.log(`   ${e}`));
  }
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
});
