// Usage: node scripts/inspect-client-role.js
//
// Read-only. Lists Plextrac's RBAC roles (name → code) and checks the role that auth-form
// contacts are given on their client (PLEXTRAC_CLIENT_ROLE, pipeline/plextrac-client-users.js)
// is one of them. Run it before switching PLEXTRAC_CLIENT_ACCESS on.
require('dotenv').config();
const api = require('../lib/plextrac-api');
const { clientRole } = require('../pipeline/plextrac-client-users');

(async () => {
  let role;
  try {
    role = await clientRole();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
  console.log(`Configured Client role: ${role || '(invalid)'}${process.env.PLEXTRAC_CLIENT_ROLE ? '' : ' (default — PLEXTRAC_CLIENT_ROLE not set)'}`);

  const res = await api.listSecurityRoles();
  const roles = Array.isArray(res) ? res : res?.data || [];
  console.log(`\n${roles.length} role(s):`);
  for (const r of roles) console.log(`  ${r.key === role ? '→' : ' '} ${String(r.name).padEnd(28)} ${r.key}${r.enabled === false ? '  (disabled)' : ''}`);

  if (role && !roles.some((r) => r.key === role)) {
    console.error(`\n✗ ${role} is not one of them — set PLEXTRAC_CLIENT_ROLE to the Client role's code above.`);
    process.exitCode = 1;
  } else if (role) {
    console.log(`\n✓ ${role} exists.`);
  }
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  console.error('A 403 here means the service account may not view security roles — grant it, or check the code in Plextrac → Admin → Security → Roles.');
  process.exitCode = 1;
});
