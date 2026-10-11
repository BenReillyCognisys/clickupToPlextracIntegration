// The PMs' Gmail connections (lib/gmail-connections.js): a new connection starts on the
// "draft" report email mode, and reconnecting keeps the PM's choice.

const assert = require('assert');

process.env.REPORT_EMAIL_TOKEN_KEY = 'a'.repeat(64);

// ── A small in-memory stand-in for the gmail_connections collection ───────────
const docs = [];
const matches = (doc, filter) => Object.entries(filter).every(([k, want]) => {
  if (want && typeof want === 'object' && '$ne' in want) return doc[k] !== want.$ne;
  if (want && typeof want === 'object' && '$in' in want) return want.$in.includes(doc[k]);
  return doc[k] === want;
});
const collection = {
  createIndex: async () => {},
  deleteMany: async (filter) => {
    for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], filter)) docs.splice(i, 1);
  },
  updateOne: async (filter, update, opts = {}) => {
    let doc = docs.find((d) => matches(d, filter));
    const inserting = !doc;
    if (inserting) {
      if (!opts.upsert) return { matchedCount: 0 };
      doc = { ...filter };
      docs.push(doc);
    }
    Object.assign(doc, update.$set || {});
    if (inserting) Object.assign(doc, update.$setOnInsert || {});
    return { matchedCount: inserting ? 0 : 1 };
  },
  findOne: async (filter) => docs.find((d) => matches(d, filter)) || null,
  findOneAndUpdate: async (filter, update) => {
    const doc = docs.find((d) => matches(d, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set || {});
    return { ...doc };
  },
};
require('../lib/mongodb').getDb = async () => ({ collection: () => collection });

const connections = require('../lib/gmail-connections');

let passed = 0, failed = 0;
async function test(description, fn) {
  try { await fn(); console.log(`  ✓ ${description}`); passed++; }
  catch (err) { console.log(`  ✗ ${description}\n    ${err.stack}`); failed++; }
}

const BEN = { email: 'ben@cognisys.group', portalUserId: 'u-ben', portalUsername: 'ben', refreshToken: 'r1', scopes: [] };

(async () => {
  console.log('\nGmail connections:');

  await test('a first connection starts on draft', async () => {
    await connections.save(BEN);
    eq(await connections.modeFor('ben@cognisys.group'), 'draft');
  });

  await test('reconnecting the same mailbox keeps the PM\'s choice', async () => {
    await connections.setMode('u-ben', 'send');
    await connections.save({ ...BEN, refreshToken: 'r2' });
    eq(await connections.modeFor('ben@cognisys.group'), 'send');
  });

  await test('a connection from before the choice existed counts as off', async () => {
    docs.push({ email: 'old@cognisys.group', portal_user_id: 'u-old', status: 'ok' });
    eq(await connections.modeFor('old@cognisys.group'), 'off');
  });

  await test('a new connection counts as opted in', async () => {
    docs.length = 0;
    eq(await connections.anyOptedIn(), false);
    await connections.save({ ...BEN, email: 'alice@cognisys.group', portalUserId: 'u-alice' });
    eq(await connections.anyOptedIn(), true);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();

function eq(actual, expected) { assert.deepStrictEqual(actual, expected); }
