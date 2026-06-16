// Each entry maps one or more keywords to a Plextrac template name.
// Keywords are matched case-insensitively against the full testing type string.
// First match wins, so put more specific entries before broader ones.
module.exports = [
  { keywords: ['grey'],         template: 'Cognisys Web Application Grey Box' },
  { keywords: ['black'],        template: 'Cognisys Web Application Black Box' },
  { keywords: ['external'],     template: 'Cognisys External Security Assessment' },
  { keywords: ['internal'],     template: 'Cognisys Internal Security Assessment' },
  { keywords: ['code review'],  template: 'Cognisys Code Review Assessment' },
];
