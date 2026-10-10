// Working-day date maths for client-facing deadlines (the free retest window).
//
// A working day is Monday to Friday, excluding England and Wales bank holidays. The
// holidays come from GOV.UK's public feed and are kept in memory for a day. If the
// feed can't be reached, the last list fetched is used, or weekends only on a fresh
// start (logged), so a deadline is never held up waiting for GOV.UK.
//
// Dates are plain calendar days ("2026-10-10"), with "today" read in Europe/London.

const axios = require('axios');
const log = require('./logger');

const HOLIDAYS_URL = process.env.UK_BANK_HOLIDAYS_URL || 'https://www.gov.uk/bank-holidays.json';
const DIVISION = 'england-and-wales';
const TTL_MS = 24 * 60 * 60 * 1000;
const TZ = 'Europe/London';

let cache = null; // { dates: Set<string>, fetchedAt: number }

/** England and Wales bank holidays as a Set of "YYYY-MM-DD". */
async function ukBankHolidays() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.dates;
  try {
    const { data } = await axios.get(HOLIDAYS_URL, { timeout: 10000 });
    const events = data?.[DIVISION]?.events;
    if (!Array.isArray(events) || !events.length) throw new Error('no events in the feed');
    cache = { dates: new Set(events.map((e) => String(e.date))), fetchedAt: Date.now() };
    return cache.dates;
  } catch (err) {
    log.warn('UK bank holidays could not be fetched — counting weekends only', {
      reason: err.message, using: cache ? 'last fetched list' : 'no holidays',
    });
    return cache?.dates ?? new Set();
  }
}

/** Today's date in London as "YYYY-MM-DD". */
function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/**
 * The date `count` working days after `fromYmd` (the start day itself is not
 * counted). Weekends and the given holidays are skipped.
 */
function addWorkingDays(fromYmd, count, holidays = new Set()) {
  const d = new Date(`${fromYmd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${fromYmd}`);
  let left = count;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d) && !holidays.has(d.toISOString().slice(0, 10))) left--;
  }
  return d.toISOString().slice(0, 10);
}

function resetCache() {
  cache = null;
}

module.exports = { ukBankHolidays, londonToday, addWorkingDays, resetCache };
