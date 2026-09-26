// A Plextrac report / client / findings trio in the shapes the API returns, for the
// client-document tests. The finding write-ups carry a marker so tests can prove they
// never reach a client-facing document.
const SECRET = 'INTERNAL-FINDING-DETAIL-DO-NOT-SHIP';

const report = {
  id: 34,
  client_id: 12,
  name: 'Web Application Penetration Test',
  start_date: '2026-09-01T00:00:00.000Z',
  end_date: '2026-09-05T00:00:00.000Z',
  tags: ['external'],
  status: 'Published',
  reviewers: ['someone@example.com'],
  custom_field: [
    { key: 'version', label: 'Version', value: '1.2' },
    { key: 'author_1', label: 'Author 1', value: 'Jane Tester' },
    { key: 'author_1_email', label: 'Author 1 Email', value: 'jane@cognisys.example' },
  ],
  exec_summary: {
    custom_fields: [
      { id: 'n1', label: 'Overview', text: '<p>Cognisys was engaged by Acme Corp to assess its customer portal.</p>' },
      { id: 'n2', label: 'Scope', text: '<ul><li>https://portal.acme.example</li><li>Authenticated user roles</li></ul>' },
      { id: 'n3', label: 'Limitations', text: '<p>Testing was performed against staging.</p>' },
      { id: 'n4', label: 'Disclaimer', text: '<p>Point-in-time assessment.</p>' },
      { id: 'n5', label: 'Confidentiality Notice', text: '<p>Commercial in confidence.</p>' },
      { id: 'n6', label: 'Executive Summary', text: '<p>ORIGINAL EXEC SUMMARY: two high-risk issues were found (see section 4.2).</p>' },
      { id: 'n7', label: 'Methodology', text: '<p>OWASP testing guide.</p>' },
    ],
  },
};

const clientRecord = { id: 12, name: 'Acme Corp', poc: 'Bob', poc_email: 'bob@acme.example', tags: [] };

const findings = [
  { flaw_id: 1, title: 'SQL Injection in login', severity: 'High', description: `<p>${SECRET}</p>` },
  { flaw_id: 2, title: 'Stored XSS', severity: 'High', description: `<p>${SECRET}</p>` },
  { flaw_id: 3, title: 'Missing HSTS', severity: 'Low', description: `<p>${SECRET}</p>` },
  { flaw_id: 4, title: 'Server banner', severity: 'Informational', description: `<p>${SECRET}</p>` },
];

module.exports = { report, clientRecord, findings, SECRET };
