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
  engagementId, dealId, lineId, lineLabel, clientName, testType, plextracType, scope,
  plextracClientId, plextracReportId, plextracReportCuid, reportName, startDatePending,
}) {
  await upsert(engagementId, {
    deal_id:              String(dealId),
    ...(lineId ? { line_id: String(lineId) } : {}),
    ...(lineLabel ? { line_label: lineLabel } : {}),
    client_name:          clientName,
    test_type:            testType,
    // The name the report is built from (config/portal-test-types.js); test_type is
    // the portal's name for the engagement.
    plextrac_type:        plextracType ?? testType,
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
//
// Two fields DeliveryFlow is the system of record for are written even when empty, but
// only when DeliveryFlow actually sent them:
//   • replaceDates — DeliveryFlow sent the engagement's dates as it now holds them, so
//     a date it cleared is cleared here too (otherwise the availability cache keeps
//     the consultant busy on dates the engagement no longer has);
//   • consultantEmails as an array (even []) — DeliveryFlow's consultants replace the
//     ones on record, and the name the portal booked is dropped: DeliveryFlow already
//     took that name from the booking, and now says who is actually on the work.
// lineId / lineLabel are the DealFlow line item the engagement was sold as; the report
// namer uses them to tell apart two engagements that would otherwise share a name.
async function saveAuthForm({
  engagementId, dealId, lineId, lineLabel, engagementUrl, clientName, testType, scope, consultantEmails,
  engagementCost, startDate, endDate, replaceDates = false, formUrl, formToken, testFilesUrl, testFilesToken,
  formClientName = clientName, formTestType = testType,
}) {
  await upsert(engagementId, {
    deal_id:        String(dealId),
    ...(lineId ? { line_id: String(lineId) } : {}),
    ...(lineLabel ? { line_label: lineLabel } : {}),
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
    // What decided a Black Box's tier (routes/deliveryflow.js).
    ...(engagementCost != null ? { engagement_cost: engagementCost } : {}),
    ...(replaceDates
      ? { start_date: startDate ?? null, end_date: endDate ?? null }
      : {
        ...(startDate != null ? { start_date: startDate } : {}),
        ...(endDate != null ? { end_date: endDate } : {}),
      }),
    // The availability cache maps these to consultants (lib/availability-cache.js).
    ...(Array.isArray(consultantEmails) ? { consultant_emails: consultantEmails, consultant: null } : {}),
    // A missing test-files link means the portal couldn't mint one this time;
    // keep any link recorded on an earlier call rather than blanking it.
    ...(testFilesUrl ? { test_files_url: testFilesUrl, test_files_token: testFilesToken ?? null } : {}),
  });
}

// A PM linked this engagement to a form by hand in the portal. Creates the record when
// break.services never set the engagement up, which is what routes the portal's later
// updates for it (booking, signed form, test files) to DeliveryFlow. `form_source`
// marks the form as the portal's: the auth-form endpoint reuses it rather than
// creating or re-scoping one of its own (see routes/deliveryflow.js).
async function linkAuthForm(engagementId, { formUrl, formToken, engagementUrl, clientName }) {
  await upsert(engagementId, {
    form_url:            formUrl,
    form_token:          formToken ?? null,
    form_source:         'portal',
    linked_in_portal_at: new Date(),
    ...(engagementUrl ? { engagement_url: engagementUrl } : {}),
    ...(clientName ? { form_client_name: clientName } : {}),
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

// The engagement behind a Plextrac report, by the report's cuid (what the Plextrac
// webhook sends) or its numeric id (what the name-based fallback resolves). null when
// the report isn't a DeliveryFlow engagement's.
async function findByReportCuid(cuid) {
  if (!cuid) return null;
  const c = await col();
  return c.findOne({ plextrac_report_cuid: String(cuid) });
}

async function findByReportId(reportId) {
  if (reportId == null || reportId === '') return null;
  const c = await col();
  // Stored as Plextrac returned it, which is usually a number but not always.
  const asNumber = Number(reportId);
  const ids = Number.isFinite(asNumber) ? [asNumber, String(reportId)] : [String(reportId)];
  return c.findOne({ plextrac_report_id: { $in: ids } });
}

// The engagements recorded under one deal — the other pentests the deal sold, whose
// authorisation forms the portal combines into one.
async function findByDealId(dealId) {
  if (!dealId) return [];
  const c = await col();
  return c.find(
    { deal_id: String(dealId) },
    {
      projection: {
        engagement_id: 1, form_url: 1, form_token: 1, test_type: 1, test_files_url: 1, test_files_token: 1,
      },
    },
  ).toArray();
}

module.exports = {
  findByEngagementId, findEngagementIds, findBookings, saveReport, saveAuthForm, linkAuthForm, updateEngagement,
  findByReportCuid, findByReportId, findByDealId,
};
