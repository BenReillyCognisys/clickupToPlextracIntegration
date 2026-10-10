const assert = require('assert');
const http = require('http');
const express = require('express');

// Plextrac access for auth-form contacts (pipeline/plextrac-client-users.js): users are
// created only when missing, only ever given the Client role, authorised on the right
// client, and checked afterwards. Plextrac, the stores and Slack are stubbed.
process.env.PLEXTRAC_INSTANCE = 'test.plextrac.com';
process.env.BREAK_SERVICES_API_KEY = 'portal-key';
process.env.SLACK_AUTH_FORM_CHANNEL = 'CAUTH';

const api = require('../lib/plextrac-api');
const taskStore = require('../lib/task-store');
const dfStore = require('../lib/deliveryflow-store');
const slack = require('../lib/slack');
const log = require('../lib/logger');

const ROLE = 'TENANT_0_ROLE_CLIENT';

// ── A tiny Plextrac ───────────────────────────────────────────────────────────
let pt;    // { users: Map<email, { roles, disabled }>, clients: { id: { name, users: { email: { role } } } } }
let calls;
let hooks;

function reset() {
  pt = {
    users: new Map([
      ['ben.reilly@cognisys.group', { roles: ['ADMIN'], disabled: false }],
      ['existing@acme.com', { roles: [ROLE], disabled: false }],
      ['staffish@acme.com', { roles: ['STD_USER'], disabled: false }],
      ['gone@acme.com', { roles: [ROLE], disabled: true }],
    ]),
    clients: {
      10: { name: 'Acme Ltd', users: { 'ben.reilly@cognisys.group': { role: 'ADMIN' }, 'onalready@acme.com': { role: ROLE } } },
      20: { name: 'Other Co', users: {} },
    },
  };
  pt.users.set('onalready@acme.com', { roles: [ROLE], disabled: false });
  calls = { created: [], assigned: [], slack: [] };
  hooks = {};
  delete process.env.PLEXTRAC_CLIENT_ROLE;
  process.env.PLEXTRAC_CLIENT_ACCESS = 'on';
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

api.tenantId = async () => 0;
api.listSecurityRoles = async () => {
  if (hooks.rolesForbidden) throw new Error('Plextrac API GET … failed (403)');
  return { status: 'success', data: [
    { key: 'ADMIN', name: 'Administrator' }, { key: 'STD_USER', name: 'Standard User' },
    { key: 'ANALYST', name: 'Analyst' }, ...(hooks.noClientRole ? [] : [{ key: ROLE, name: 'Client' }]),
  ] };
};
// The v1 user/list shape: { id, doc_id, data: { email, roles, disabled, … } }.
api.listTenantUsers = async () => [...pt.users].map(([email, u]) => ({
  id: email, doc_id: [0], data: { email, roles: u.roles, disabled: u.disabled, name: { first: 'X', last: 'Y' } },
}));
api.getClient = async (id) => {
  const c = pt.clients[id];
  return c ? { client_id: id, name: c.name, users: JSON.parse(JSON.stringify(c.users)) } : null;
};
api.bulkCreateUsers = async (users) => {
  await delay(5); // long enough for a second run to overlap, if it weren't serialised
  calls.created.push(...users);
  for (const u of users) {
    if (hooks.createSilentlyFails) continue;
    if (pt.users.has(u.email)) throw new Error('Plextrac API POST … failed (400): user exists');
    pt.users.set(u.email, { roles: [hooks.createWithRole || u.role], disabled: false });
  }
  return { status: 'success', message: 'Users created.' };
};
api.assignClientUsers = async (clientId, users) => {
  calls.assigned.push({ clientId, users });
  const assigned = [];
  for (const u of users) {
    if (!pt.users.has(u.username)) continue;
    pt.clients[clientId].users[u.username] = { role: hooks.assignWithRole || u.role };
    assigned.push(u.username);
  }
  return { status: 'complete', users_assigned: assigned, users_rejected: [] };
};
taskStore.findByTaskId = async (id) => ({ 'cu-1': { plextrac_client_id: 10 }, 'cu-2': { plextrac_client_id: 20 } }[id] || null);
dfStore.findByEngagementId = async (id) => (id === 'df-1' ? { plextrac_client_id: 10 } : null);
slack.postMessage = async (channel, text) => { calls.slack.push({ channel, text }); return {}; };
log.info = () => {}; log.warn = () => {}; log.error = () => {};

const users = require('../pipeline/plextrac-client-users');

let passed = 0, failed = 0;
async function test(description, fn) {
  reset();
  try {
    await fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}\n       ${err.stack || err.message}`);
    failed++;
  }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
const outcomes = (result) => Object.fromEntries(result.users.map((u) => [u.email, u.outcome]));
const grant = (people, extra = {}) => users.grantClientAccess({ plextracClientId: 10, clientName: 'Acme Ltd', formToken: 'tok', users: people, ...extra });

(async () => {
  console.log('\nPlextrac client access:');

  await test('off by default: nothing is read or changed', async () => {
    delete process.env.PLEXTRAC_CLIENT_ACCESS;
    const r = await grant([{ email: 'new@acme.com', firstName: 'New', lastName: 'Person' }]);
    eq(r, { state: 'off' });
    eq([calls.created, calls.assigned, calls.slack], [[], [], []]);
  });

  await test('a new contact gets a user with the Client role, and is authorised on the client as Client', async () => {
    const r = await grant([{ email: 'New@Acme.com', firstName: 'New', lastName: 'Person' }]);
    eq(r.state, 'done');
    eq(outcomes(r), { 'new@acme.com': 'created' });
    eq(calls.created, [{ email: 'new@acme.com', name: { first: 'New', last: 'Person' }, role: ROLE, default_group: true }]);
    eq(calls.assigned, [{ clientId: 10, users: [{ username: 'new@acme.com', role: ROLE }] }]);
    eq(pt.clients[10].users['new@acme.com'], { role: ROLE });
    eq(calls.slack.length, 1);
    assert.ok(/new@acme\.com — new Plextrac user, added/.test(calls.slack[0].text), calls.slack[0].text);
  });

  await test('the same email twice on a form (any case) is created once', async () => {
    const r = await grant([{ email: 'dup@acme.com', firstName: 'A' }, { email: ' DUP@acme.com ', firstName: 'B' }]);
    eq(outcomes(r), { 'dup@acme.com': 'created' });
    eq(calls.created.length, 1);
  });

  await test('an existing client user is reused, not created again', async () => {
    const r = await grant([{ email: 'EXISTING@acme.com' }]);
    eq(outcomes(r), { 'existing@acme.com': 'added' });
    eq(calls.created, []);
    eq(calls.assigned[0].users, [{ username: 'existing@acme.com', role: ROLE }]);
  });

  await test('someone already on the client: nothing changed, no Slack noise', async () => {
    const r = await grant([{ email: 'onalready@acme.com' }]);
    eq(outcomes(r), { 'onalready@acme.com': 'already_on_client' });
    eq([calls.created, calls.assigned, calls.slack], [[], [], []]);
  });

  await test('an existing user with another role is left alone and flagged — never given client access as-is', async () => {
    const r = await grant([{ email: 'staffish@acme.com' }]);
    eq(outcomes(r), { 'staffish@acme.com': 'other_role' });
    eq([calls.created, calls.assigned], [[], []]);
    assert.ok(/some need checking/.test(calls.slack[0].text));
  });

  await test('Cognisys addresses, non-emails and disabled users are skipped', async () => {
    const r = await grant([
      { email: 'ben.reilly@cognisys.group' }, { email: 'someone@cognisys.co.uk' }, { email: 'first.last' }, { email: 'gone@acme.com' }, { email: '' },
    ]);
    eq(outcomes(r), {
      'ben.reilly@cognisys.group': 'internal', 'someone@cognisys.co.uk': 'internal', 'first.last': 'invalid_email', 'gone@acme.com': 'disabled',
    });
    eq([calls.created, calls.assigned], [[], []]);
  });

  await test('a built-in role in PLEXTRAC_CLIENT_ROLE is refused before anything is made', async () => {
    for (const bad of ['ADMIN', 'std_user', 'ANALYST', 'Client']) {
      reset();
      process.env.PLEXTRAC_CLIENT_ROLE = bad;
      const r = await grant([{ email: 'new@acme.com' }]);
      eq(r.state, 'failed');
      eq([calls.created, calls.assigned], [[], []]);
    }
  });

  await test('a Client role Plextrac doesn\'t have stops the run', async () => {
    hooks.noClientRole = true;
    const r = await grant([{ email: 'new@acme.com' }]);
    eq(r.state, 'failed');
    assert.ok(/doesn't exist in Plextrac/.test(r.reason), r.reason);
    eq(calls.created, []);
    assert.ok(/nobody was added/.test(calls.slack[0].text));
  });

  await test('roles that can\'t be listed (403) don\'t block it — the read-back still checks', async () => {
    hooks.rolesForbidden = true;
    const r = await grant([{ email: 'new@acme.com' }]);
    eq(outcomes(r), { 'new@acme.com': 'created' });
  });

  await test('a user Plextrac said it made but didn\'t is failed, and not authorised', async () => {
    hooks.createSilentlyFails = true;
    const r = await grant([{ email: 'new@acme.com' }]);
    eq(r.users, [{ email: 'new@acme.com', outcome: 'failed', detail: 'user was not created' }]);
    eq(calls.assigned, []);
  });

  await test('a user created with the wrong role is failed, and not authorised', async () => {
    hooks.createWithRole = 'STD_USER';
    const r = await grant([{ email: 'new@acme.com' }]);
    eq(outcomes(r), { 'new@acme.com': 'failed' });
    eq(calls.assigned, []);
  });

  await test('a client authorisation that ends up with another role is caught by the read-back', async () => {
    hooks.assignWithRole = 'STD_USER';
    const r = await grant([{ email: 'new@acme.com' }]);
    eq(r.users, [{ email: 'new@acme.com', outcome: 'failed', detail: `on the client as STD_USER, not ${ROLE}` }]);
  });

  await test('two submissions at once can\'t both create the same user', async () => {
    const [a, b] = await Promise.all([
      grant([{ email: 'race@acme.com' }]),
      grant([{ email: 'race@acme.com' }], { plextracClientId: 20, clientName: 'Other Co' }),
    ]);
    eq(calls.created.length, 1);
    eq([outcomes(a)['race@acme.com'], outcomes(b)['race@acme.com']], ['created', 'added']);
    eq([pt.clients[10].users['race@acme.com'], pt.clients[20].users['race@acme.com']], [{ role: ROLE }, { role: ROLE }]);
  });

  await test('the client comes from the form\'s tasks when the form has no client id', async () => {
    const r = await grant([{ email: 'new@acme.com' }], { plextracClientId: null, taskIds: ['cu-1', 'df-1'] });
    eq(r.clientId, 10);
    eq(outcomes(r), { 'new@acme.com': 'created' });
  });

  await test('no client, or tasks on different clients: nobody is added, and Slack says so', async () => {
    const none = await grant([{ email: 'new@acme.com' }], { plextracClientId: null, taskIds: ['cu-x'] });
    eq(none.state, 'no_client');
    const two = await grant([{ email: 'new@acme.com' }], { plextracClientId: null, taskIds: ['cu-1', 'cu-2'] });
    eq(two.state, 'ambiguous_client');
    eq([calls.created, calls.assigned], [[], []]);
    eq(calls.slack.length, 2);
  });

  await test('POST /api/plextrac/client-users needs the portal key', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/plextrac', require('../routes/plextrac-client-users'));
    const server = app.listen(0);
    const port = server.address().port;
    const post = (key, body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ port, method: 'POST', path: '/api/plextrac/client-users', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(key ? { 'X-API-Key': key } : {}),
      } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
      req.on('error', reject);
      req.end(data);
    });
    try {
      eq((await post(null, {})).status, 401);
      eq((await post('wrong', {})).status, 401);
      const ok = await post('portal-key', { plextracClientId: 10, users: [{ email: 'route@acme.com', firstName: 'R', lastName: 'T' }] });
      eq(ok.status, 200);
      eq(outcomes(ok.body), { 'route@acme.com': 'created' });
    } finally {
      server.close();
    }
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
