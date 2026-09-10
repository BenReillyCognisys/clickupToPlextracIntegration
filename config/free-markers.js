// Wording that marks an engagement as the FREE offering rather than a paid test.
//
// The free product is a half-day black box, sold on its own ("Free Black Box
// Pentest") and bundled into the onboarding programmes ("30-Day Fast Start",
// "Vanta Fast Start"). None of that wording is part of the SERVICE phrase, so
// config/testing-types.js can't see it: "… | 30-Day Fast Start Programme | SOC 2 |
// Black Box Pentest" matched the alias `black box pentest` and resolved to the
// paid canonical type `Black Box`, which is what the SFE was told to bill for.
//
// A marker here overrides that: pipeline/parse-task.js re-maps the recognised
// testing type to FREE_TYPE, and because every downstream step (report name,
// template choice, the SFE auth-form payload, the stored mapping) derives from
// that one string, the engagement is free everywhere at once.
//
// Matching is case-insensitive and on whole-phrase word boundaries, ANYWHERE in
// the task name EXCEPT the client-name segment — otherwise a client called
// "Freedom Finance" or "Fast Start Labs" would have its paid tests written off.
//
// Two deliberate limits:
//   • a name with no recognised service at all stays `Unknown` and still aborts
//     the create pipeline. A marker says how the work is PAID FOR, not what the
//     work IS, so "Acme | Vanta Fast Start | SOC 2" is still a name a human has
//     to fix rather than a report we invent;
//   • a marker on a service that isn't Black Box (an External, a Web App) still
//     maps free, per the rule, but carries a warning to Slack — that combination
//     is either a mis-named task or a paid test inside a free programme.
module.exports = {
  // The canonical testing type every free engagement resolves to.
  //
  // This exact string is sent to the SFE as `testType` on POST /api/clickup/auth-form,
  // so it has to be the SFE's own name for the product. It is: the portal uses
  // "Free Black Box Test" when it calls US back on POST /clickup/schedule-task
  // (see docs/task-admin.md). It also satisfies the `/free\s*black\s*box/i` test in
  // routes/clickup-actions.js, so a repeat submission still won't move a booking.
  FREE_TYPE: 'Free Black Box Test',

  // Extend this list to cover a new free programme — nothing else needs to change.
  // Keep entries unambiguous: anything that could plausibly appear in a paid deal
  // name will write that deal off. Redundant entries are harmless but pointless
  // ("vanta free" and "free of charge" are already covered by "free").
  MARKERS: [
    'free',
    '30-day', '30 day',
    'fast start', 'fast-start',
    'no charge', 'complimentary',
  ],
};
