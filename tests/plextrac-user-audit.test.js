const assert = require('assert');

// The weekly Plextrac user audit (pipeline/plextrac-user-audit.js): read-only, and flags
// non-Cognisys users with another role, more than one client, or the Default Group.
process.env.PLEXTRAC_INSTANCE = 'test.plextrac.com';
process.env.PLEXTRAC_USER_AUDIT_CHANNEL = 'CAUDIT';

const api = require('../lib/plextrac-api');
const slack = require('../lib/slack');
const log = require('../lib/logger');

const CLIENT = 'TENANT_0_ROLE_CLIENT';
const CLIENT_STATUS = 'TENANT_0_ROLE_CLIENT__CHANGE_STATUS_ENABLED';

let users;
let clients;
let unreadable;
let posts;

// Anything that writes to Plextrac fails the test.
for (const name of ['createClient', 'updateClient', 'deleteClient', 'createReport', 'updateReport', 'deleteReport',
  'bulkCreateUsers', 'assignClientUsers', 'updateFinding', 'uploadReportArtifact', 'deleteArtifact', 'importReportPtrac', 'call']) {
  api[name] = async () => { throw new Error(`audit must be read-only, but called api.${name}`); };
}
api.listTenantUsers = async () => users.map(([email, roles, extra = {}]) => ({
  id: email, doc_id: [0], data: { email, roles, disabled: false, default_group: false, name: { first: 'F', last: 'L' }, ...extra },
}));
api.listClients = async () => Object.entries(clients).map(([id, c]) => ({ id: `client_${id}`, data: [Number(id), c.name, null] }));
api.getClient = async (id) => {
  if (unreadable.includes(Number(id))) throw new Error('Plextrac 500');
  const c = clients[id];
  return { client_id: Number(id), name: c.name, users: Object.fromEntries(c.users.map((e) => [e, { role: CLIENT }])) };
};
slack.postMessage = async (channel, text) => { posts.push({ channel, text }); return {}; };
log.info = () => {}; log.warn = () => {}; log.error = () => {};

const audit = require('../pipeline/plextrac-user-audit');

function reset() {
  users = [
    ['ben.reilly@cognisys.group', ['ADMIN'], { default_group: true }],
    ['karan@cognisys.co.uk', ['STD_USER']],
    ['good@acme.com', [CLIENT]],
    ['status@acme.com', [CLIENT_STATUS]],
    ['Two@Acme.com', [CLIENT]],
    ['analyst@acme.com', ['ANALYST']],
    ['nobody@acme.com', []],
    ['everywhere@acme.com', [CLIENT], { default_group: true }],
    ['global_admin', ['ADMIN']],
  ];
  clients = {
    1: { name: 'Acme', users: ['ben.reilly@cognisys.group', 'good@acme.com', 'status@acme.com', 'two@acme.com', 'everywhere@acme.com'] },
    2: { name: 'Beta', users: ['ben.reilly@cognisys.group', 'TWO@acme.com', 'everywhere@acme.com'] },
    3: { name: 'Gamma', users: ['ben.reilly@cognisys.group', 'everywhere@acme.com'] },
  };
  unreadable = [];
  posts = [];
}

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
const byEmail = (r) => Object.fromEntries(r.flagged.map((u) => [u.email, u.reasons]));

(async () => {
  console.log('\nPlextrac user audit:');

  await test('flags other roles, more than one client and the Default Group — nobody else', async () => {
    const r = await audit.auditUsers();
    eq(byEmail(r), {
      'analyst@acme.com': ['role ANALYST'],
      'everywhere@acme.com': ['authorised on 3 clients', 'in the Default Group (sees every client)'],
      global_admin: ['role ADMIN'],
      'karan@cognisys.co.uk': ['role STD_USER'],
      'nobody@acme.com': ['no role'],
      'two@acme.com': ['authorised on 2 clients'],
    });
    eq([r.checked, r.exempt, r.clients], [9, 1, 3]);
  });

  await test('both client roles pass; emails are matched to clients regardless of case', async () => {
    const r = await audit.auditUsers();
    eq(['good@acme.com', 'status@acme.com'].filter((e) => byEmail(r)[e]), []);
    eq(r.flagged.find((u) => u.email === 'two@acme.com').clients, ['Acme', 'Beta']);
  });

  await test('only cognisys.group is exempt by default; the domains are configurable', async () => {
    process.env.PLEXTRAC_USER_AUDIT_EXEMPT_DOMAINS = 'cognisys.group, cognisys.co.uk';
    try {
      const r = await audit.auditUsers();
      assert.ok(!byEmail(r)['karan@cognisys.co.uk']);
      eq(r.exempt, 2);
    } finally {
      delete process.env.PLEXTRAC_USER_AUDIT_EXEMPT_DOMAINS;
    }
  });

  await test('a client that can\'t be read is reported, and the rest still counted', async () => {
    unreadable = [3];
    const r = await audit.auditUsers();
    eq(r.clientErrors.length, 1);
    eq(byEmail(r)['everywhere@acme.com'], ['authorised on 2 clients', 'in the Default Group (sees every client)']);
  });

  await test('findings are posted to the audit channel', async () => {
    await audit.runUserAudit();
    eq(posts.length, 1);
    eq(posts[0].channel, 'CAUDIT');
    assert.ok(/6 of 8 non-Cognisys user\(s\) flagged/.test(posts[0].text), posts[0].text);
    assert.ok(/two@acme\.com — authorised on 2 clients\n {6}on: Acme, Beta/.test(posts[0].text), posts[0].text);
  });

  await test('a clean run posts nothing', async () => {
    users = [['good@acme.com', [CLIENT]], ['ben.reilly@cognisys.group', ['ADMIN']]];
    const r = await audit.runUserAudit();
    eq(r.flagged, []);
    eq(posts, []);
  });

  await test('a failed run says so in Slack and never throws', async () => {
    const real = api.listTenantUsers;
    api.listTenantUsers = async () => { throw new Error('Plextrac API GET … failed (HTTP 403)'); };
    try {
      eq(await audit.runUserAudit(), null);
      assert.ok(/user audit failed/.test(posts[0].text));
    } finally {
      api.listTenantUsers = real;
    }
  });

  await test('a second run while one is going joins it instead of starting another', async () => {
    const a = audit.runUserAudit({ notify: false });
    const b = audit.runUserAudit({ notify: false });
    assert.strictEqual(a, b);
    await a;
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
