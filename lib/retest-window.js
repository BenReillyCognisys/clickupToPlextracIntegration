// The free retest offer on a published pentest report, for DeliveryFlow's Retest step.
//
// Free retests cover Critical and High findings. When a report is Published, this
// counts them and works out the last day the retest can take place: RETEST_WORKING_DAYS
// (20) working days after the publish date (lib/working-days.js). The publish date is
// the day the report reached Published, which is the day this runs.

const api = require('./plextrac-api');
const { normaliseFindings } = require('../pipeline/client-documents/data');
const workingDays = require('./working-days');

const RETEST_WORKING_DAYS = Number(process.env.RETEST_WORKING_DAYS) || 20;

const severityOf = (f) => String(f?.severity ?? '').trim().toLowerCase();

/**
 * { critical, high, publishedOn, availableUntil, workingDays } for one report.
 * Throws if Plextrac's findings can't be read, so a wrong "no findings" is never sent.
 */
async function retestWindow({ clientId, reportId, now = new Date() }) {
  const findings = normaliseFindings(await api.listReportFindings(clientId, reportId));
  const critical = findings.filter((f) => severityOf(f) === 'critical').length;
  const high = findings.filter((f) => severityOf(f) === 'high').length;
  const publishedOn = workingDays.londonToday(now);
  const holidays = await workingDays.ukBankHolidays();
  return {
    critical,
    high,
    publishedOn,
    availableUntil: workingDays.addWorkingDays(publishedOn, RETEST_WORKING_DAYS, holidays),
    workingDays: RETEST_WORKING_DAYS,
  };
}

module.exports = { retestWindow, RETEST_WORKING_DAYS };
