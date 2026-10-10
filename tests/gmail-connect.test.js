// PMs connecting their own Gmail for the report email: token encryption
// (lib/secret-box.js), the OAuth connect flow (lib/gmail-oauth.js) and its routes
// (routes/report-email.js), with Google and MongoDB stubbed.

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');

const KEY = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  WEBHOOK_URL: 'https://api.break.services/',
  REPORT_EMAIL_TOKEN_KEY: KEY,
  SECURE_PORTAL_URL: 'https://portal.cognisys.group',
  BREAK_SERVICES_API_KEY: 'portal-key',
});
delete process.env.REPORT_EMAIL_OAUTH_REDIRECT_URI;

const { google } = require('googleapis');
const box = require('../lib/secret-box');
const connections = require('../lib/gmail-connections');
const oauth = require('../lib/gmail-oauth');
const routes = require('../routes/report-email');

let passed = 0;
let failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);
async function rejects(promise, check) {
  try { await promise; } catch (err) { check(err); return; }
  throw new Error('expected a rejection');
}

// ── Stubs ────────────────────────────────────────────────────────────────────
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
let g; // what Google and the store saw / will answer
function reset({ tokens = { refresh_token: 'refresh-1', access_token: 'access-1', scope: `${READONLY} ${COMPOSE}` }, profile = 'Ben@cognisys.group', state = null } = {}) {
  g = { clients: [], authOpts: null, exchanges: [], revoked: [], saved: [], states: [], removed: null, tokens, profile, state };
}
class FakeOAuth2 {
  constructor(id, secret, redirect) { g.clients.push({ id, secret, redirect }); }
  async generateCodeVerifierAsync() { return { codeVerifier: 'verifier-1', codeChallenge: 'challenge-1' }; }
  generateAuthUrl(opts) { g.authOpts = opts; return `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`; }
  async getToken(args) { g.exchanges.push(args); return { tokens: g.tokens }; }
  setCredentials(t) { this.credentials = t; }
  async revokeToken(t) { g.revoked.push(t); }
}
google.auth.OAuth2 = FakeOAuth2;
google.gmail = () => ({ users: { getProfile: async () => ({ data: { emailAddress: g.profile } }) } });
connections.createState = async (s) => { g.states.push(s); };
connections.takeState = async (state) => (state && g.state && state === g.state.state ? g.state.pending : null);
connections.save = async (c) => { g.saved.push(c); };
connections.forPortalUser = async (id) => (id === 'u-ben'
  ? { email: 'ben@cognisys.group', status: 'ok', connected_at: new Date('2026-10-09T10:00:00Z') } : null);
connections.remove = async (id) => { g.removed = id; return id === 'u-ben' ? { email: 'ben@cognisys.group', refreshToken: 'refresh-1' } : null; };

const PENDING = { codeVerifier: 'verifier-1', portalUserId: 'u-ben', portalUsername: 'ben@cognisys.group', portalEmail: 'ben@cognisys.group' };
const withState = (pending = PENDING) => ({ state: 'state-1', pending });

(async () => {
  console.log('\nsecret-box:');

  await test('seal → open round-trips, with a fresh IV each time', () => {
    const a = box.seal('1//refresh-token');
    const b = box.seal('1//refresh-token');
    assert.notStrictEqual(a, b);
    assert.ok(!a.includes('refresh-token'), 'the token is not in the sealed value');
    eq(box.open(a), '1//refresh-token');
  });

  await test('a tampered value is refused', () => {
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other!').toString('base64url');
    assert.throws(() => box.open(parts.join('.')));
  });

  await test('the wrong key is refused, and no key means not configured', () => {
    const sealed = box.seal('secret');
    process.env.REPORT_EMAIL_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
    assert.throws(() => box.open(sealed));
    process.env.REPORT_EMAIL_TOKEN_KEY = 'short';
    eq(box.isConfigured(), false);
    process.env.REPORT_EMAIL_TOKEN_KEY = KEY;
    eq(box.isConfigured(), true);
  });

  console.log('\nstartConnect:');

  await test('builds Google\'s consent URL: offline, both Gmail scopes, PKCE, state, the PM\'s email as hint', async () => {
    reset();
    const { url } = await oauth.startConnect({ portalUserId: 'u-ben', portalUsername: 'Ben@Cognisys.group', portalEmail: '' });
    assert.ok(url.startsWith('https://accounts.google.com/'));
    eq(g.clients[0], { id: 'client-id', secret: 'client-secret', redirect: 'https://api.break.services/report-email/oauth/callback' });
    eq(g.authOpts.access_type, 'offline');
    eq(g.authOpts.prompt, 'consent');
    eq(g.authOpts.scope, [READONLY, COMPOSE]);
    eq(g.authOpts.code_challenge_method, 'S256');
    eq(g.authOpts.code_challenge, 'challenge-1');
    eq(g.authOpts.login_hint, 'ben@cognisys.group');
    assert.ok(g.authOpts.state.length >= 40, 'a long random state');
    eq(g.states[0].state, g.authOpts.state);
    eq(g.states[0].codeVerifier, 'verifier-1');
    eq(g.states[0].portalEmail, 'ben@cognisys.group');
  });

  await test('refuses when not set up (503) or when the portal user has no email (400)', async () => {
    reset();
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = '';
    await rejects(oauth.startConnect({ portalUserId: 'u-ben', portalEmail: 'ben@cognisys.group' }), (e) => eq(e.status, 503));
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    await rejects(oauth.startConnect({ portalUserId: 'u-ben', portalUsername: 'ben' }), (e) => eq(e.status, 400));
    eq(g.states, []);
  });

  console.log('\nfinishConnect:');

  await test('connects: exchanges the code with the PKCE verifier and saves the token for the portal user', async () => {
    reset({ state: withState() });
    eq(await oauth.finishConnect({ code: 'code-1', state: 'state-1' }), { result: 'connected', account: 'ben@cognisys.group' });
    eq(g.exchanges, [{ code: 'code-1', codeVerifier: 'verifier-1' }]);
    eq(g.saved.length, 1);
    eq(g.saved[0].email, 'ben@cognisys.group');
    eq(g.saved[0].portalUserId, 'u-ben');
    eq(g.saved[0].refreshToken, 'refresh-1');
    eq(g.revoked, []);
  });

  await test('the same mailbox on the other Cognisys domain is the PM\'s own', async () => {
    reset({ state: withState({ ...PENDING, portalEmail: 'ben@cognisys.co.uk' }) });
    eq((await oauth.finishConnect({ code: 'c', state: 'state-1' })).result, 'connected');
  });

  await test('an unknown, used or expired state never reaches Google', async () => {
    reset({ state: withState() });
    eq(await oauth.finishConnect({ code: 'c', state: 'forged' }), { result: 'expired' });
    eq(await oauth.finishConnect({ code: 'c', state: null }), { result: 'expired' });
    eq(g.exchanges, []);
  });

  await test('the PM pressing Cancel on Google\'s screen', async () => {
    reset({ state: withState() });
    eq(await oauth.finishConnect({ state: 'state-1', error: 'access_denied' }), { result: 'denied' });
    eq(g.saved, []);
  });

  await test('a Gmail permission unticked: refused, and the partial grant handed back', async () => {
    reset({ state: withState(), tokens: { refresh_token: 'refresh-1', scope: READONLY } });
    eq(await oauth.finishConnect({ code: 'c', state: 'state-1' }), { result: 'missing_scopes' });
    eq(g.saved, []);
    eq(g.revoked, ['refresh-1']);
  });

  await test('someone else\'s Google account: refused and revoked', async () => {
    reset({ state: withState(), profile: 'alice@cognisys.group' });
    eq(await oauth.finishConnect({ code: 'c', state: 'state-1' }), { result: 'wrong_account', account: 'alice@cognisys.group' });
    eq(g.saved, []);
    eq(g.revoked, ['refresh-1']);
  });

  await test('a non-Cognisys account is refused even when it matches the portal email', async () => {
    reset({ state: withState({ ...PENDING, portalEmail: 'ben@gmail.com' }), profile: 'ben@gmail.com' });
    eq((await oauth.finishConnect({ code: 'c', state: 'state-1' })).result, 'wrong_account');
    eq(g.saved, []);
  });

  await test('no refresh token from Google: an error, nothing saved', async () => {
    reset({ state: withState(), tokens: { access_token: 'a', scope: `${READONLY} ${COMPOSE}` } });
    eq(await oauth.finishConnect({ code: 'c', state: 'state-1' }), { result: 'error' });
    eq(g.saved, []);
  });

  console.log('\nstatus, disconnect, return URL:');

  await test('status for a connected and an unconnected portal user', async () => {
    reset();
    const ben = await oauth.status('u-ben');
    eq([ben.configured, ben.connected, ben.email, ben.status], [true, true, 'ben@cognisys.group', 'ok']);
    eq((await oauth.status('u-other')).connected, false);
  });

  await test('disconnect removes the connection and revokes it at Google', async () => {
    reset();
    eq(await oauth.disconnect('u-ben'), { disconnected: true, email: 'ben@cognisys.group' });
    eq(g.revoked, ['refresh-1']);
    eq(await oauth.disconnect('u-none'), { disconnected: false });
  });

  await test('portalReturnUrl: the portal\'s Gmail page with the outcome', () => {
    eq(oauth.portalReturnUrl({ result: 'connected', account: 'ben@cognisys.group' }),
      'https://portal.cognisys.group/dashboard/settings/gmail?gmail=connected');
    eq(oauth.portalReturnUrl({ result: 'wrong_account', account: 'alice@cognisys.group' }),
      'https://portal.cognisys.group/dashboard/settings/gmail?gmail=wrong_account&account=alice%40cognisys.group');
  });

  console.log('\nroutes:');

  const app = express();
  app.use(express.json());
  app.use('/api/report-email', routes.portal);
  app.use('/report-email', routes.callback);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = { 'X-API-Key': 'portal-key', 'Content-Type': 'application/json' };

  await test('the portal endpoints need the portal key', async () => {
    eq((await fetch(`${base}/api/report-email/connection?portalUserId=u-ben`)).status, 401);
    eq((await fetch(`${base}/api/report-email/connection?portalUserId=u-ben`, { headers: { 'X-API-Key': 'wrong-key!' } })).status, 401);
  });

  await test('GET /connection and POST /connect with the key', async () => {
    reset();
    const status = await (await fetch(`${base}/api/report-email/connection?portalUserId=u-ben`, { headers: key })).json();
    eq([status.ok, status.connected, status.email], [true, true, 'ben@cognisys.group']);
    const res = await fetch(`${base}/api/report-email/connect`, {
      method: 'POST', headers: key, body: JSON.stringify({ portalUserId: 'u-ben', portalEmail: 'ben@cognisys.group' }),
    });
    const body = await res.json();
    eq(res.status, 200);
    assert.ok(body.url.startsWith('https://accounts.google.com/'));
  });

  await test('the callback sends the browser back to the portal, never caching', async () => {
    reset({ state: withState() });
    const res = await fetch(`${base}/report-email/oauth/callback?code=code-1&state=state-1`, { redirect: 'manual' });
    eq(res.status, 302);
    eq(res.headers.get('location'), 'https://portal.cognisys.group/dashboard/settings/gmail?gmail=connected');
    eq(res.headers.get('cache-control'), 'no-store');
    const again = await fetch(`${base}/report-email/oauth/callback?code=code-1&state=forged`, { redirect: 'manual' });
    eq(again.headers.get('location'), 'https://portal.cognisys.group/dashboard/settings/gmail?gmail=expired');
  });

  await test('a failure inside the callback still lands back on the portal, as an error', async () => {
    reset({ state: withState() });
    const real = FakeOAuth2.prototype.getToken;
    FakeOAuth2.prototype.getToken = async () => { throw new Error('invalid_grant'); };
    try {
      const res = await fetch(`${base}/report-email/oauth/callback?code=c&state=state-1`, { redirect: 'manual' });
      eq(res.headers.get('location'), 'https://portal.cognisys.group/dashboard/settings/gmail?gmail=error');
    } finally {
      FakeOAuth2.prototype.getToken = real;
    }
  });

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  // Not process.exit(): exiting while the test server's sockets close trips libuv on Windows.
  process.exitCode = failed > 0 ? 1 : 0;
})();
