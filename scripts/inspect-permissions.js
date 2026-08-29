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
    ['field templates         ', '/api/v1/field-templates'],
  ];
  if (auth.tenant_id !== undefined) {
    probes.push(
      // Tenant-scoped, per listTenantUsers in lib/plextrac-api.js — a bare
      // /api/v1/user/list is a 404 and tells you nothing about permissions.
      ['list users (View Users) ', `/api/v1/tenant/${auth.tenant_id}/user/list`],
      ['report templates        ', `/api/v1/tenant/${auth.tenant_id}/report-templates`],
    );
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

  // PlexTrac gates export on three things beyond the role permission: per-CLIENT
  // authorization, the report's CLASSIFICATION tier vs the user's tier for that
  // client, and the export TEMPLATE bound to the report. All three are visible on
  // objects this account can already read, so print them rather than guess.
  if (clientId && reportId) {
    console.log('');
    console.log('Export gates visible on the report/client (see docs/qa-review.md):');
    const report = await axios.get(`${BASE}/api/v1/client/${clientId}/report/${reportId}`,
      { headers, validateStatus: () => true });
    const data = report.data?.data ?? report.data ?? {};
    const show = (label, ...keys) => {
      const key = keys.find((k) => data[k] !== undefined && data[k] !== null && data[k] !== '');
      console.log(`  ${label.padEnd(22)} ${key ? JSON.stringify(data[key]) : '(not set / not present)'}`);
    };
    show('classification', 'classification', 'report_classification', 'reportClassification', 'tier');
    show('export template', 'exportTemplate', 'export_template', 'template', 'template_id', 'templateId');
    show('status', 'status', 'report_status');
    show('operators/assigned', 'operators', 'assignedTo', 'users');

    const client = await axios.get(`${BASE}/api/v1/client/${clientId}`,
      { headers, validateStatus: () => true });
    const cdata = client.data?.data ?? client.data ?? {};
    const cls = cdata.classification ?? cdata.classifications ?? null;
    console.log(`  client classification  ${cls === null ? '(not set / not present)' : JSON.stringify(cls)}`);
  }

  console.log('');
  console.log('Reading everything but DENY on export  -> the role lacks export only.');
  console.log('DENY on several                        -> the grant did not reach this account.');
  console.log('If the JWT shows a role you did not edit, that is the one to change.');
  console.log('');
  console.log('If export is denied in the WEB UI too, the role permission is not the blocker:');
  console.log('check per-client authorization (Admin > Security > Authorization > this client),');
  console.log('the classification tier on the report vs this user, and the export template.');
  console.log('');
  process.exit(0);
})().catch((err) => {
  console.error(err.response?.data ?? err.message);
  process.exit(1);
});
