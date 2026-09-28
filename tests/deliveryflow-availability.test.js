// AVAILABILITY_SOURCE picks where consultants' bookings come from: ClickUp tasks or
// the DeliveryFlow engagement records, never both (lib/availability-cache.js).

const assert = require('assert');
const axios = require('axios');

// ClickUp's task search: one dated task for Raj, counted so the DeliveryFlow source
// can be shown never to read ClickUp tasks.
let taskReads = 0;
let clickupTask = null;
axios.get = async () => {
  taskReads++;
  return { data: { tasks: clickupTask ? [clickupTask] : [], last_page: true } };
};

const { computeAvailability, bookingNames, availabilitySource } = require('../lib/availability-cache');

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

const roster = { 1: 'Jane Smith', 2: 'Raj Patel' };
const membersMap = {
  1: { id: 1, name: 'Jane Smith', email: 'jane@cognisys.group' },
  2: { id: 2, name: 'Raj Patel', email: 'raj@cognisys.group' },
};

// A weekday a week or so out, so it is always inside the window and in the future.
function weekdayFromNow(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const ymd = (d) => d.toISOString().slice(0, 10);

const DF = { source: 'deliveryflow' };

(async () => {
  console.log('Availability booking source:');

  await test('AVAILABILITY_SOURCE defaults to clickup, accepts either value, and refuses anything else', async () => {
    const saved = process.env.AVAILABILITY_SOURCE;
    try {
      delete process.env.AVAILABILITY_SOURCE;
      assert.strictEqual(availabilitySource(), 'clickup');
      process.env.AVAILABILITY_SOURCE = ' DeliveryFlow ';
      assert.strictEqual(availabilitySource(), 'deliveryflow');
      process.env.AVAILABILITY_SOURCE = 'both';
      assert.throws(() => availabilitySource(), /must be one of clickup, deliveryflow/);
    } finally {
      if (saved === undefined) delete process.env.AVAILABILITY_SOURCE;
      else process.env.AVAILABILITY_SOURCE = saved;
    }
  });

  await test('clickup source: ClickUp tasks count, DeliveryFlow bookings are ignored', async () => {
    const start = weekdayFromNow(8);
    clickupTask = { id: 't1', assignees: [{ id: 2 }], start_date: String(start.getTime()), due_date: String(start.getTime()) };
    taskReads = 0;
    const result = await computeAvailability(roster, membersMap, {
      source: 'clickup',
      bookings: [{ engagement_id: 'eng-1', start_date: start.getTime(), end_date: start.getTime(), consultant: 'Jane Smith' }],
    });
    clickupTask = null;
    const day = result.days.find((d) => d.date === ymd(start));
    assert.deepStrictEqual(day.busy, ['Raj Patel']);
    assert.ok(taskReads > 0);
    assert.strictEqual(result.loadStats.deliveryflow_bookings, 0);
    assert.strictEqual(result.loadStats.source, 'clickup');
  });

  await test('deliveryflow source: bookings count and no ClickUp task is read', async () => {
    const start = weekdayFromNow(8);
    clickupTask = { id: 't1', assignees: [{ id: 2 }], start_date: String(start.getTime()), due_date: String(start.getTime()) };
    taskReads = 0;
    const result = await computeAvailability(roster, membersMap, {
      ...DF,
      bookings: [{ engagement_id: 'eng-1', start_date: start.getTime(), end_date: start.getTime(), consultant: 'Jane Smith' }],
    });
    clickupTask = null;
    const day = result.days.find((d) => d.date === ymd(start));
    assert.deepStrictEqual(day.busy, ['Jane Smith'], 'Raj\'s ClickUp task is not consulted');
    assert.strictEqual(taskReads, 0);
    assert.strictEqual(result.loadStats.source, 'deliveryflow');
  });

  console.log('\nDeliveryFlow bookings:');

  await test('the portal\'s consultant name matches the roster exactly or by first name/surname', async () => {
    assert.deepStrictEqual(bookingNames({ consultant: 'jane smith' }, roster, membersMap), ['Jane Smith']);
    assert.deepStrictEqual(bookingNames({ consultant: 'Raj Patel' }, roster, membersMap), ['Raj Patel']);
    assert.deepStrictEqual(bookingNames({ consultant: 'Nobody Here' }, roster, membersMap), []);
  });

  await test('consultant emails from DeliveryFlow map through the ClickUp members', async () => {
    const names = bookingNames({ consultant_emails: ['JANE@cognisys.group', 'raj@cognisys.group'] }, roster, membersMap);
    assert.deepStrictEqual(names.sort(), ['Jane Smith', 'Raj Patel']);
  });

  await test('a booked consultant is busy on each day of the engagement and nobody else is', async () => {
    const start = weekdayFromNow(8);
    const end = new Date(start);
    const result = await computeAvailability(roster, membersMap, { ...DF, bookings: [
      { engagement_id: 'eng-1', start_date: start.getTime(), end_date: end.getTime(), consultant: 'Jane Smith' },
    ] });
    const day = result.days.find((d) => d.date === ymd(start));
    assert.ok(day, 'the booked day is in the window');
    assert.deepStrictEqual(day.busy, ['Jane Smith']);
    assert.deepStrictEqual(day.available, ['Raj Patel']);
    assert.strictEqual(day.load['Jane Smith'], 1);
    assert.strictEqual(result.loadStats.deliveryflow_bookings, 1);
  });

  await test('a half-day Free Black Box booking leaves half a day of load', async () => {
    const start = weekdayFromNow(9);
    const result = await computeAvailability(roster, membersMap, { ...DF, bookings: [
      { engagement_id: 'eng-free', start_date: start.getTime(), end_date: start.getTime(), consultant: 'Raj Patel', days: 0.5 },
    ] });
    const day = result.days.find((d) => d.date === ymd(start));
    assert.strictEqual(day.load['Raj Patel'], 0.5);
  });

  await test('a booking with nobody on the roster is counted as unmatched, not guessed', async () => {
    const start = weekdayFromNow(8);
    const result = await computeAvailability(roster, membersMap, { ...DF, bookings: [
      { engagement_id: 'eng-x', start_date: start.getTime(), end_date: start.getTime(), consultant: 'Contractor Bob' },
    ] });
    assert.strictEqual(result.loadStats.deliveryflow_unmatched, 1);
    assert.ok(result.days.every((d) => d.busy.length === 0));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
