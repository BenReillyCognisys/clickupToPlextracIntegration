// DeliveryFlow engagement records.
//
// One document per DeliveryFlow engagement (engagement_id is unique), created by
// POST /api/deliveryflow/auth-form. It is the DeliveryFlow counterpart of the
// ClickUp task_mappings collection: it records which deal the engagement belongs to
// (so a client's forms can later be grouped by deal_id for merging), the Plextrac
// client and report created for it, and the form and test-files links the portal
// returned. The portal callbacks (routes/deliveryflow-portal.js) then keep a mirror
// of what they forwarded to DeliveryFlow — the booked dates, the signed and merged
// form links — which the Free Black Box repeat guard and the report rename read.

const { getDb } = require('./mongodb');

async function col() {
  const db = await getDb();
  const c = db.collection('deliveryflow_auth_forms');
  await c.createIndex({ engagement_id: 1 }, { unique: true, background: true });
  // Not unique — one deal carries several engagements (e.g. Black Box + External).
  await c.createIndex({ deal_id: 1 }, { background: true });
  // The Plextrac webhook identifies reports by cuid; this lets it find the engagement.
  await c.createIndex({ plextrac_report_cuid: 1 }, { sparse: true, background: true });
  return c;
}

async function upsert(engagementId, set) {
  const c = await col();
  await c.updateOne(
    { engagement_id: String(engagementId) },
    { $set: { ...set, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  );
}

async function findByEngagementId(engagementId) {
  const c = await col();
  return c.findOne({ engagement_id: String(engagementId) });
}

// Links the engagement to the Plextrac report created for it. Written as soon as the
// report exists — before the auth form is requested — so a retry after a portal
// failure finds the link and never creates a second report.
async function saveReport({
  engagementId, dealId, clientName, testType, scope,
  plextracClientId, plextracReportId, plextracReportCuid, reportName, startDatePending,
}) {
  await upsert(engagementId, {
    deal_id:              String(dealId),
    client_name:          clientName,
    test_type:            testType,
    // Kept so the report name can be rebuilt the same way when the dates arrive.
    scope:                scope ?? null,
    plextrac_client_id:   plextracClientId,
    plextrac_report_id:   plextracReportId,
    plextrac_report_cuid: plextracReportCuid ?? null,
    report_name:          reportName,
    // The report name fell back to the current month because no start date was
    // sent; it needs renaming once one arrives.
    start_date_pending:   Boolean(startDatePending),
  });
}

// Records the engagement as DeliveryFlow last described it, with the form the portal
// returned. DeliveryFlow calls again whenever the engagement changes, so a field it
// leaves out keeps its value: dates booked through the portal aren't wiped by a call
// that doesn't carry them.
async function saveAuthForm({
  engagementId, dealId, engagementUrl, clientName, testType, scope, consultantEmails,
  startDate, endDate, formUrl, formToken, testFilesUrl, testFilesToken,
  formClientName = clientName, formTestType = testType,
}) {
  await upsert(engagementId, {
    deal_id:        String(dealId),
    client_name:    clientName,
    test_type:      testType,
    scope:          scope ?? null,
    form_url:       formUrl,
    form_token:     formToken ?? null,
    // What the portal's form was last generated or re-scoped for. Usually the same as
    // client_name / test_type, but a signed form can't be re-scoped, so they can
    // differ; the next change is diffed against these.
    form_client_name: formClientName,
    form_test_type:   formTestType,
    ...(engagementUrl ? { engagement_url: engagementUrl } : {}),
    ...(startDate != null ? { start_date: startDate } : {}),
    ...(endDate != null ? { end_date: endDate } : {}),
    // The availability cache maps these to consultants (lib/availability-cache.js).
    ...(consultantEmails?.length ? { consultant_emails: consultantEmails } : {}),
    // A missing test-files link means the portal couldn't mint one this time;
    // keep any link recorded on an earlier call rather than blanking it.
    ...(testFilesUrl ? { test_files_url: testFilesUrl, test_files_token: testFilesToken ?? null } : {}),
  });
}

// Sets fields on an existing engagement record; never creates one (the callbacks
// only act on engagements the auth-form endpoint set up). Returns whether a record
// matched.
async function updateEngagement(engagementId, set) {
  const c = await col();
  const result = await c.updateOne(
    { engagement_id: String(engagementId) },
    { $set: { ...set, updated_at: new Date() } },
  );
  return result.matchedCount > 0;
}

// Which of `ids` are DeliveryFlow engagements. The portal's /clickup/* callbacks use
// this to send DeliveryFlow ids on to DeliveryFlow and the rest to ClickUp.
async function findEngagementIds(ids) {
  if (!ids.length) return new Set();
  const c = await col();
  const docs = await c.find(
    { engagement_id: { $in: ids.map(String) } },
    { projection: { engagement_id: 1 } },
  ).toArray();
  return new Set(docs.map((d) => d.engagement_id));
}

// Engagements with dates that end on or after `fromMs` — what the availability cache
// adds to the ClickUp bookings so a consultant on a DeliveryFlow engagement isn't
// offered to another client.
async function findBookings(fromMs) {
  const c = await col();
  return c.find(
    {
      start_date: { $ne: null },
      $or: [{ end_date: { $gte: fromMs } }, { end_date: null, start_date: { $gte: fromMs } }],
    },
    {
      projection: {
        engagement_id: 1, start_date: 1, end_date: 1, days: 1, consultant: 1, consultant_emails: 1,
      },
    },
  ).toArray();
}

module.exports = {
  findByEngagementId, findEngagementIds, findBookings, saveReport, saveAuthForm, updateEngagement,
};
