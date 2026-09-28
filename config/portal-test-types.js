// The secure portal's (SFE's) testing types — what DeliveryFlow's test selector
// offers and sends as `testType` to POST /api/deliveryflow/auth-form.
//
// `name` must match the portal's TEST_TYPES (sfe-portal server/models/AuthForm.js)
// exactly: it is passed to the portal as-is, so the auth form carries exactly the
// type chosen, with no fuzzy matching in between. Keep the two lists in step — a
// type added to the portal needs adding here before DeliveryFlow can send it.
//
// `plextracType` is the name used for the Plextrac side — the report name ("Black Box
// | October 2026") and the template choice (config/template-map.js). Where the portal
// type is one break.services already knows (config/testing-types.js), that canonical
// name is used, so DeliveryFlow reports are named like the ClickUp ones. Otherwise
// the portal name is used, and the template falls back to the default unless a
// template-map keyword matches it.
//
// `skipPlextrac` marks engagements with no pentest report behind them: no Plextrac
// client or report is created, only the auth form (as for VMaaS from ClickUp).

const { FREE_TYPE } = require('./free-markers');

module.exports = [
  // Web App
  { name: 'Free Black Box Web App',     plextracType: FREE_TYPE },
  { name: 'Paid Black Box Pentest',     plextracType: 'Black Box' },
  { name: 'Grey Box Web App',           plextracType: 'Grey Box' },
  { name: 'Code Review - White Box',    plextracType: 'Code Review' },
  { name: 'Thick Client' },
  { name: 'Mobile App',                 plextracType: 'Mobile App' },
  { name: 'API Testing',                plextracType: 'API' },
  { name: 'Generative AI Pentesting' },
  // A blank authorisation: details and a signature, no engagement to report on.
  { name: 'Signature Only',             skipPlextrac: true },

  // Infrastructure
  { name: 'Internal',                   plextracType: 'Internal' },
  { name: 'External',                   plextracType: 'External' },
  { name: 'Wireless' },
  { name: 'Secure/Server Build Review', plextracType: 'Secure Build Review' },
  { name: 'Firewall' },
  { name: 'Password Cracking' },
  { name: 'Attack Path Management' },
  { name: 'Assumed Breach' },
  { name: 'Lost or Stolen Device' },

  // Cloud Testing
  { name: 'M365 Review' },
  { name: 'Cloud Benchmark Review' },
  { name: 'Cloud Penetration Testing' },

  // Bespoke Work
  { name: 'Red Team' },
  { name: 'Social Engineering' },
  { name: 'Purple Team' },
  { name: 'Physical Testing' },

  // VMaaS — no Plextrac report, as for VMaaS from ClickUp.
  { name: 'VMaaS',                      skipPlextrac: true },
  { name: 'VMaaS Web App Scanning',     skipPlextrac: true },

  // AI Pentests
  { name: 'Continuous Pentest' },
  { name: 'Attack Surface Management' },
];
