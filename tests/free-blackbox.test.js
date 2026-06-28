const assert = require('assert');
const http   = require('http');
const express = require('express');

// Endpoint requires this before the router is imported (middleware reads it).
process.env.AVAILABILITY_API_KEY = 'test-key';

const { cache, taskDaysBalance } = require('../lib/availability-cache');
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

// ── Effort-field resolution (taskDaysBalance) ─────────────────────────────────
console.log('taskDaysBalance (Days / Days Balance field):');

test('reads a "Days" custom field (half day)', () => {
  assert.strictEqual(taskDaysBalance({ custom_fields: [{ name: 'Days', value: '0.5' }] }), 0.5);
});

test('tolerates surrounding whitespace in the field name', () => {
  assert.strictEqual(taskDaysBalance({ custom_fields: [{ name: ' Days ', value: 1 }] }), 1);
});

test('falls back to "Days Balance" when "Days" is absent', () => {
  assert.strictEqual(taskDaysBalance({ custom_fields: [{ name: 'Days Balance', value: '2' }] }), 2);
});

test('prefers "Days" over "Days Balance" when both present', () => {
  assert.strictEqual(taskDaysBalance({
    custom_fields: [{ name: 'Days Balance', value: '5' }, { name: 'Days', value: '0.5' }],
  }), 0.5);
});

test('returns null when no effort field is set', () => {
  assert.strictEqual(taskDaysBalance({ custom_fields: [{ name: 'R', value: '100' }] }), null);
  assert.strictEqual(taskDaysBalance({}), null);
});

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
    // Within 2 weeks. Only a partial booking (0 < load <= 0.5) counts; a fully
    // free consultant (load 0) or a (near-)full day (load > 0.5) does not.
    day('2026-06-29', 'Monday',    { 'Chahat Mundra': 0.5, 'Jane Doe': 0, 'Akshay Dandekar': 0, 'Siddharth Johri': 1 }),   // only Chahat (half-booked)
    day('2026-06-30', 'Tuesday',   { 'Akshay Dandekar': 0.5, 'Chahat Mundra': 0, 'Siddharth Johri': 0, 'Jane Doe': 1 }),   // only Akshay (half-booked)
    day('2026-07-01', 'Wednesday', { 'Chahat Mundra': 0, 'Akshay Dandekar': 0, 'Siddharth Johri': 0, 'Jane Doe': 0 }),     // everyone fully free → excluded
    // After 2 weeks (> 2026-07-12), priority consultants only.
    day('2026-07-13', 'Monday',    { 'Akshay Dandekar': 0.5 }),
    day('2026-07-14', 'Tuesday',   { 'Siddharth Johri': 0.5 }),
    day('2026-07-15', 'Wednesday', { 'Chahat Mundra': 0.5 }),
    day('2026-07-16', 'Thursday',  { 'Chahat Mundra': 0, 'Akshay Dandekar': 0, 'Siddharth Johri': 0 }),                    // all free → excluded
    day('2026-07-17', 'Friday',    { 'Akshay Dandekar': 0.5 }),
    day('2026-07-20', 'Monday',    { 'Siddharth Johri': 0.5 }),
    day('2026-07-21', 'Tuesday',   { 'Chahat Mundra': 0.5 }),
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

  test('within 2 weeks surfaces only consultants with a half-day GAP (already half-booked)', () => {
    const dates = json.within_two_weeks.map((d) => d.date);
    assert.deepStrictEqual(dates, ['2026-06-29', '2026-06-30']);
    assert.deepStrictEqual(json.within_two_weeks[0].consultants, ['Chahat Mundra']);
    assert.deepStrictEqual(json.within_two_weeks[1].consultants, ['Akshay Dandekar']);
  });

  test('within 2 weeks excludes fully-free days (no work assigned)', () => {
    const dates = json.within_two_weeks.map((d) => d.date);
    assert.ok(!dates.includes('2026-07-01'), '2026-07-01 (everyone fully free) must be excluded');
  });

  test('after 2 weeks is capped at 5 distinct dates', () => {
    assert.strictEqual(json.after_two_weeks.options.length, 5);
    const dates = json.after_two_weeks.options.map((o) => o.date);
    assert.deepStrictEqual(dates, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-17', '2026-07-20']);
  });

  test('after 2 weeks excludes fully-free days', () => {
    const dates = json.after_two_weeks.options.map((o) => o.date);
    assert.ok(!dates.includes('2026-07-16'), '2026-07-16 (all priority consultants fully free) must be excluded');
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
