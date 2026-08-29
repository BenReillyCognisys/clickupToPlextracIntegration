// Usage: node scripts/inspect-permissions.js [clientId reportId]
//
// Shows what Plextrac believes the API account can do, for when a permission has been
// granted in the RBAC UI but the export still returns "User is not authorized to
// perform this action".
//
// Authenticates fresh (so it never reports a stale cached session), decodes the role
// and permission claims out of the returned JWT, and probes a spread of endpoints that
// need different permissions — so you can see whether the grant landed on this account
// at all, and whether it is export specifically or a whole class of actions.
//
// Read-only: every probe is a GET, nothing is modified. The raw token is never
// printed, only its decoded claims.
require('dotenv').config();
const axios = require('axios');

const BASE = `https://${process.env.PLEXTRAC_INSTANCE || 'cognisys.plextrac.com'}`;

// Decodes a JWT payload without verifying it — this is a diagnostic, and the token
// came straight from the auth response.
function claims(jwt) {
  try {
    const part = String(jwt || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Keys worth surfacing first — whatever the instance calls the role/permission claim.
const INTERESTING = ['role', 'roles', 'permissions', 'perms', 'authorization', 'scope',
  'scopes', 'groups', 'userType', 'user_type', 'admin', 'isAdmin', 'tenantCuid'];

(async () => {
  const [, , clientId, reportId] = process.argv;

  const { data: auth } = await axios.post(`${BASE}/api/v1/authenticate`, {
    username: process.env.PLEXTRAC_USERNAME,
    password: process.env.PLEXTRAC_PASSWORD,
  });
  const headers = { Authorization: auth.token };

  console.log('');
  console.log(`Account : ${process.env.PLEXTRAC_USERNAME}`);
  console.log(`Instance: ${BASE}`);
  console.log(`Auth response fields: ${Object.keys(auth).join(', ')}`);
  console.log('');

  // The JWT is where a role/permission claim would live if the instance puts one there.
  for (const [label, jwt] of [['token', auth.token], ['cookie', auth.cookie]]) {
    const payload = claims(jwt);
    if (!payload) continue;
    console.log(`JWT claims (${label}):`);
    const keys = Object.keys(payload);
    const ordered = [...INTERESTING.filter((k) => keys.includes(k)),
      ...keys.filter((k) => !INTERESTING.includes(k))];
    for (const key of ordered) {
      // Timestamps and the signature-adjacent noise are not useful here.
      if (['iat', 'exp', 'nbf'].includes(key)) continue;
      const value = JSON.stringify(payload[key]);
      console.log(`  ${key}: ${value && value.length > 300 ? `${value.slice(0, 300)}...` : value}`);
    }
    console.log('');
  }

  // Endpoints needing different permissions. If everything reads but export refuses,
  // the role is missing export specifically; if several refuse, the grant did not
  // apply to this account at all.
  const probes = [
    ['list clients            ', '/api/v1/client/list'],
    ['list users (View Users) ', '/api/v1/user/list'],
    ['field templates         ', '/api/v1/field-templates'],
  ];
  if (auth.tenant_id !== undefined) {
    probes.push(['report templates        ', `/api/v1/tenant/${auth.tenant_id}/report-templates`]);
  }
  if (clientId && reportId) {
    probes.push(
      ['read report             ', `/api/v1/client/${clientId}/report/${reportId}`],
      ['read findings           ', `/api/v1/client/${clientId}/report/${reportId}/flaws`],
      ['EXPORT report           ', `/api/v1/client/${clientId}/report/${reportId}/export/pdf`],
    );
  }

  console.log('Permission probes (all read-only):');
  for (const [label, path] of probes) {
    const res = await axios.get(`${BASE}${path}`, { headers, validateStatus: () => true });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    const denied = body.toLowerCase().includes('not authorized');
    const mark = res.status === 200 ? 'OK  ' : (denied ? 'DENY' : '--  ');
    console.log(`  ${mark} ${res.status}  ${label} ${path}`);
    if (res.status !== 200) console.log(`         ${body.slice(0, 160)}`);
  }

  console.log('');
  console.log('Reading everything but DENY on export  -> the role lacks export only.');
  console.log('DENY on several                        -> the grant did not reach this account.');
  console.log('If the JWT shows a role you did not edit, that is the one to change.');
  console.log('');
  process.exit(0);
})().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
