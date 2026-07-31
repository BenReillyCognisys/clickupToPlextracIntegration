// Lateness math (lib/report-lateness.js). Assertions assume the default
// Europe/London timezone and a 09:00 tracking-start hour.

const assert = require('assert');
const { trackingStartMs, hoursLate } = require('../lib/report-lateness');

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
const eq = (a, b) => assert.strictEqual(a, b);

// Winter dates are in GMT (London == UTC); summer dates are in BST (London == UTC+1).
console.log('\ntrackingStartMs:');

test('due Thursday → 09:00 Friday (GMT: 09:00 UTC)', () => {
  const dueThu = Date.UTC(2026, 0, 15, 17, 0); // Thu 15 Jan 2026, 5pm
  eq(trackingStartMs(dueThu), Date.UTC(2026, 0, 16, 9, 0)); // Fri 16 Jan 09:00 GMT
});

test('due Friday → 09:00 Monday (skips the weekend)', () => {
  const dueFri = Date.UTC(2026, 0, 16, 12, 0); // Fri 16 Jan 2026
  eq(trackingStartMs(dueFri), Date.UTC(2026, 0, 19, 9, 0)); // Mon 19 Jan 09:00 GMT
});

test('due Saturday → 09:00 Monday', () => {
  const dueSat = Date.UTC(2026, 0, 17, 10, 0); // Sat 17 Jan 2026
  eq(trackingStartMs(dueSat), Date.UTC(2026, 0, 19, 9, 0)); // Mon 19 Jan 09:00 GMT
});

test('BST: due Thursday → 09:00 Friday London == 08:00 UTC', () => {
  const dueThu = Date.UTC(2026, 6, 16, 15, 0); // Thu 16 Jul 2026 (BST)
  eq(trackingStartMs(dueThu), Date.UTC(2026, 6, 17, 8, 0)); // Fri 17 Jul 09:00 BST = 08:00 UTC
});

console.log('\nhoursLate:');

test('the due day itself is never late (Thursday due, submitted Thursday)', () => {
  const dueThu = Date.UTC(2026, 0, 15, 9, 0);
  eq(hoursLate(dueThu, Date.UTC(2026, 0, 15, 16, 0)), 0);
});

test('before the Friday 09:00 start is not late', () => {
  const dueThu = Date.UTC(2026, 0, 15, 9, 0);
  eq(hoursLate(dueThu, Date.UTC(2026, 0, 16, 8, 0)), 0); // Fri 08:00, before start
});

test('Friday 14:00 after a Thursday due is 5h late', () => {
  const dueThu = Date.UTC(2026, 0, 15, 9, 0);
  eq(hoursLate(dueThu, Date.UTC(2026, 0, 16, 14, 0)), 5); // start Fri 09:00 → 5h
});

test('wall-clock hours accumulate across the weekend', () => {
  const dueThu = Date.UTC(2026, 0, 15, 9, 0);       // start Fri 16 Jan 09:00
  eq(hoursLate(dueThu, Date.UTC(2026, 0, 19, 9, 0)), 72); // Mon 09:00 = 72h wall-clock
});

test('BST lateness measured against 08:00 UTC start', () => {
  const dueThu = Date.UTC(2026, 6, 16, 9, 0);        // start Fri 17 Jul 09:00 BST = 08:00 UTC
  eq(hoursLate(dueThu, Date.UTC(2026, 6, 17, 10, 0)), 2); // 10:00 UTC = 11:00 BST → 2h
});

test('null/invalid due date → null', () => {
  eq(hoursLate(null, Date.now()), null);
  eq(hoursLate(0, Date.now()), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
