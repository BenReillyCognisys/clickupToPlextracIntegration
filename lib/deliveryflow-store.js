// DeliveryFlow engagement records.
//
// One document per DeliveryFlow engagement (engagement_id is unique), written by
// POST /api/deliveryflow/auth-form. It is the DeliveryFlow counterpart of the
// ClickUp task_mappings collection: it records which deal the engagement belongs to
// (so a client's forms can later be grouped by deal_id for merging), the Plextrac
// client and report created for it, and the form and test-files links the portal
// returned.

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
  engagementId, dealId, clientName, testType,
  plextracClientId, plextracReportId, plextracReportCuid, reportName, startDatePending,
}) {
  await upsert(engagementId, {
    deal_id:              String(dealId),
    client_name:          clientName,
    test_type:            testType,
    plextrac_client_id:   plextracClientId,
    plextrac_report_id:   plextracReportId,
    plextrac_report_cuid: plextracReportCuid ?? null,
    report_name:          reportName,
    // The report name fell back to the current month because no start date was
    // sent; it needs renaming once one arrives.
    start_date_pending:   Boolean(startDatePending),
  });
}

async function saveAuthForm({
  engagementId, dealId, engagementUrl, clientName, testType, startDate, endDate,
  formUrl, formToken, testFilesUrl, testFilesToken,
}) {
  await upsert(engagementId, {
    deal_id:        String(dealId),
    engagement_url: engagementUrl ?? null,
    client_name:    clientName,
    test_type:      testType,
    start_date:     startDate ?? null,
    end_date:       endDate ?? null,
    form_url:       formUrl,
    form_token:     formToken ?? null,
    // A missing test-files link means the portal couldn't mint one this time;
    // keep any link recorded on an earlier call rather than blanking it.
    ...(testFilesUrl ? { test_files_url: testFilesUrl, test_files_token: testFilesToken ?? null } : {}),
  });
}

module.exports = { findByEngagementId, saveReport, saveAuthForm };
