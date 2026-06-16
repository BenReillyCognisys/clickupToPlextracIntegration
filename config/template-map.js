// Maps parsed testing types to their Plextrac report template names.
// Keys must match the canonical spellings in config/testing-types.js (case-insensitive match is applied at runtime).
// Any type not listed here falls back to PLEXTRAC_REPORT_TEMPLATE in .env.
module.exports = {
  'Grey Box':           'Cognisys Web Application Grey Box',
  'Black Box':          'Cognisys Web Application Black Box',
  'Internal':           'Cognisys Internal Security Assessment',
  'External':           'Cognisys External Security Assessment',
  'Code Review':        'Cognisys Code Review Assessment',
};
