const assert = require('assert');
const http   = require('http');
const express = require('express');

// Endpoint requires this before the router is imported (middleware reads it).
process.env.AVAILABILITY_API_KEY = 'test-key';

const { cache } = require('../lib/availability-cache');
const availabilityRouter = require('../routes/availability');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

// ── Fake cache ────────────────────────────────────────────────────────────────
// today = Sun 2026-06-28 → 2-week boundary = 2026-07-12.
// load[name] is the consultant's committed days that day; <= 0.5 ⇒ half-day free.
const day = (date, weekday, load) => ({ date, weekday, load });

cache.serviceTypes = {
  service_types: [{
    service_type: 'Black Box Web App',
    independent:  ['Chahat Mundra', 'Akshay Dandekar', 'Siddharth Johri', 'Jane Doe'],
  }],
};
cache.lastRefresh  = '2026-06-28T00:00:00.000Z';
cache.availability = {
  generated_at: '2026-06-28T00:00:00.000Z',
  today:        '2026-06-28',
  window:       { start: '2026-06-22', end: '2026-07-17', weeks: 4 },
  roster:       ['Chahat Mundra', 'Akshay Dandekar', 'Siddharth Johri', 'Jane Doe'],
  days: [
    // Within 2 weeks
    day('2026-06-29', 'Monday',    { 'Jane Doe': 0,   'Chahat Mundra': 1, 'Akshay Dandekar': 1, 'Siddharth Johri': 1 }), // only Jane half-free
    day('2026-06-30', 'Tuesday',   { 'Chahat Mundra': 0.5, 'Akshay Dandekar': 1, 'Siddharth Johri': 1, 'Jane Doe': 1 }), // only Chahat half-free
    // After 2 weeks (> 2026-07-12)
    day('2026-07-13', 'Monday',    { 'Akshay Dandekar': 0.5 }),
    day('2026-07-14', 'Tuesday',   { 'Siddharth Johri': 0 }),
    day('2026-07-15', 'Wednesday', { 'Chahat Mundra': 0.5 }),
    day('2026-07-16', 'Thursday',  { 'Jane Doe': 0, 'Chahat Mundra': 1, 'Akshay Dandekar': 1, 'Siddharth Johri': 1 }), // only Jane → excluded after-window
    day('2026-07-17', 'Friday',    { 'Akshay Dandekar': 0 }),
    day('2026-07-20', 'Monday',    { 'Siddharth Johri': 0 }),
    day('2026-07-21', 'Tuesday',   { 'Chahat Mundra': 0 }),
  ],
};

// ── Spin up a throwaway server and call the endpoint ──────────────────────────
function get(path, headers) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use('/availability', availabilityRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get({ port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

(async () => {
  console.log('\nGET /availability/freeblackbox:');

  const unauth = await get('/availability/freeblackbox', {});
  test('rejects missing API key', () => {
    assert.strictEqual(unauth.status, 401);
  });

  const { status, json } = await get('/availability/freeblackbox', { 'X-API-Key': 'test-key' });

  test('returns 200 with the API key', () => {
    assert.strictEqual(status, 200);
  });

  test('request echoes Free Black Box Test @ 0.5 days', () => {
    assert.deepStrictEqual(json.request, {
      testType: 'Free Black Box Test', based_on: 'Black Box Web App', days: 0.5,
    });
  });

  test('priority window is the next 14 days from today', () => {
    assert.deepStrictEqual(json.priority_window, { start: '2026-06-28', end: '2026-07-12', days: 14 });
  });

  test('within 2 weeks surfaces ANY qualified consultant with a half-day free', () => {
    const dates = json.within_two_weeks.map((d) => d.date);
    assert.deepStrictEqual(dates, ['2026-06-29', '2026-06-30']);
    assert.deepStrictEqual(json.within_two_weeks[0].consultants, ['Jane Doe']);   // Chahat busy that day
    assert.deepStrictEqual(json.within_two_weeks[1].consultants, ['Chahat Mundra']);
  });

  test('after 2 weeks is capped at 5 distinct dates', () => {
    assert.strictEqual(json.after_two_weeks.options.length, 5);
    const dates = json.after_two_weeks.options.map((o) => o.date);
    assert.deepStrictEqual(dates, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-17', '2026-07-20']);
  });

  test('after 2 weeks excludes dates where only a non-priority consultant is free', () => {
    const dates = json.after_two_weeks.options.map((o) => o.date);
    assert.ok(!dates.includes('2026-07-16'), '2026-07-16 (Jane only) must be excluded');
  });

  test('after 2 weeks only lists the 3 priority consultants', () => {
    const names = new Set(json.after_two_weeks.options.flatMap((o) => o.consultants));
    for (const n of names) {
      assert.ok(['Chahat Mundra', 'Akshay Dandekar', 'Siddharth Johri'].includes(n), `${n} should not appear`);
    }
  });

  test('next_available is the soonest within-2-weeks slot', () => {
    assert.strictEqual(json.next_available.date, '2026-06-29');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
