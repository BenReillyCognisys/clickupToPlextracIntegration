const assert = require('assert');
const axios = require('axios');
const wd = require('../lib/working-days');

let passed = 0, failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}\n       ${err.message}`);
    failed++;
  }
}

(async () => {
  console.log('Working days:');

  await test('20 working days from a Monday is the Monday four weeks later', async () => {
    assert.strictEqual(wd.addWorkingDays('2026-10-05', 20), '2026-11-02');
  });

  await test('the start day is not counted and weekends are skipped', async () => {
    assert.strictEqual(wd.addWorkingDays('2026-10-09', 1), '2026-10-12'); // Fri → Mon
    assert.strictEqual(wd.addWorkingDays('2026-10-10', 1), '2026-10-12'); // Sat → Mon
  });

  await test('bank holidays are skipped', async () => {
    const xmas = new Set(['2026-12-25', '2026-12-28']);
    // Thu 24 Dec + 1 working day: Fri 25 (holiday), Mon 28 (substitute holiday) → Tue 29
    assert.strictEqual(wd.addWorkingDays('2026-12-24', 1, xmas), '2026-12-29');
  });

  await test('London today is a plain date', async () => {
    // 23:30 UTC on 10 Oct during BST is already 11 Oct in London.
    assert.strictEqual(wd.londonToday(new Date('2026-10-10T23:30:00Z')), '2026-10-11');
  });

  await test('holidays come from the England and Wales feed and are cached', async () => {
    wd.resetCache();
    const original = axios.get;
    let calls = 0;
    axios.get = async () => {
      calls++;
      return { data: { 'england-and-wales': { events: [{ date: '2026-12-25' }] }, scotland: { events: [{ date: '2026-11-30' }] } } };
    };
    try {
      const a = await wd.ukBankHolidays();
      const b = await wd.ukBankHolidays();
      assert.ok(a.has('2026-12-25'));
      assert.ok(!a.has('2026-11-30'));
      assert.strictEqual(a, b);
      assert.strictEqual(calls, 1);
    } finally {
      axios.get = original;
      wd.resetCache();
    }
  });

  await test('an unreachable feed falls back to weekends only', async () => {
    wd.resetCache();
    const original = axios.get;
    axios.get = async () => { throw new Error('offline'); };
    try {
      assert.strictEqual((await wd.ukBankHolidays()).size, 0);
    } finally {
      axios.get = original;
      wd.resetCache();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
