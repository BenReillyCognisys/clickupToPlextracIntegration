// Canonical testing types, and the wording real deals actually arrive with.
//
// `type` is the canonical name. It's what ends up in the Plextrac report name, in
// the ClickUp → Plextrac mapping and in the client authorisation form, and it's
// what config/template-map.js matches against to choose a report template.
//
// `aliases` are the phrases HubSpot deal names use for that service. Aliases (and
// the canonical name itself) are matched case-insensitively, on word boundaries,
// ANYWHERE in the task name — deal names arrive as "Client - Deal name - Service",
// so the service can't be found by splitting on a separator. The match that ENDS
// last wins, since the service is the tail of the name; ties go to the longer
// phrase, so "Mobile Device Application Penetration Testing" beats the
// "Application Penetration Testing" sitting inside it.
//
// `bareNotFollowedBy` guards the canonical name on its own, so that "Internal"
// isn't harvested from "Internal Audit" in a deal like
// "Vanta Renewal, Internal Audit, VM Scanning & Pen Testing - Black Box Pen Test".
// It does not apply to that type's aliases.
//
// To support a new service, add it here — nothing else needs to change. A task
// name that matches nothing here parses as "Unknown", which aborts the create
// pipeline with a Slack notice rather than inventing a testing type from whatever
// text happened to follow the first hyphen (see pipeline/index.js).
module.exports = [
  {
    type: 'Secure Build Review',
    aliases: ['secure build review', 'build review', 'build configuration review'],
  },
  {
    type: 'Cloud Assessment',
    aliases: ['cloud security assessment', 'cloud security review', 'cloud review', 'cloud configuration review'],
  },
  {
    type: 'Code Review',
    aliases: ['source code review', 'secure code review', 'code security review'],
  },
  {
    type: 'Mobile App',
    aliases: [
      'mobile device application penetration testing',
      'mobile device application penetration test',
      'mobile application penetration testing',
      'mobile application penetration test',
      'mobile app penetration testing',
      'mobile app penetration test',
      'mobile device application',
      'mobile application testing',
      'mobile app testing',
      'mobile application',
      'mobile pentest',
      'mobile pen test',
    ],
  },
  {
    type: 'Web App',
    aliases: [
      'web application penetration testing',
      'web application penetration test',
      'web app penetration testing',
      'web app penetration test',
      'application penetration testing',
      'application penetration test',
      'web application testing',
      'web application review',
      'web app testing',
      'web application',
      'web app pentest',
      'web app pen test',
      'webapp',
    ],
  },
  {
    type: 'Grey Box',
    aliases: [
      'grey box penetration testing', 'grey box penetration test', 'grey box pentest', 'grey box pen test',
      'gray box penetration testing', 'gray box penetration test', 'gray box pentest', 'gray box pen test',
      'greybox', 'graybox', 'gray box',
    ],
  },
  {
    type: 'Black Box',
    aliases: [
      'black box penetration testing', 'black box penetration test', 'black box pentest', 'black box pen test',
      'blackbox',
    ],
  },
  {
    type: 'Internal',
    aliases: [
      'internal penetration testing', 'internal penetration test', 'internal pentest', 'internal pen test',
      'internal infrastructure testing', 'internal infrastructure',
    ],
    // "Internal Audit" is a compliance deliverable, not a testing type.
    bareNotFollowedBy: /^\s*audit\b/i,
  },
  {
    type: 'External',
    aliases: [
      'external penetration testing', 'external penetration test', 'external pentest', 'external pen test',
      'external infrastructure testing', 'external infrastructure',
    ],
    // Symmetry with Internal — "External Audit" is not a testing type either.
    bareNotFollowedBy: /^\s*audit\b/i,
  },
  {
    type: 'CIS',
    aliases: ['cis benchmark', 'cis benchmarking'],
  },
];
