// MFA (2-Step Verification) enforcement check.
//
// Uses the Google Workspace Admin SDK Directory API to list every user in the
// domain and reports those who do NOT have 2-Step Verification enforced. The
// list is printed to the console (and mirrored to the log file via the shared
// logger). It runs on a daily 14:00 cron and can be triggered early via
// POST /jobs/mfa-check.
//
// The Directory API only exposes 2SV status to a domain admin, so the service
// account must have domain-wide delegation and impersonate an admin user
// (GOOGLE_ADMIN_SUBJECT). The service-account key defaults to the production
// path but can be overridden with GOOGLE_SERVICE_ACCOUNT_KEY.

const { google } = require('googleapis');
const log = require('../lib/logger');
const slack = require('../lib/slack');

// Path to the service-account JSON key. Defaults to the production location.
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  || '/var/app/api/sfe-app-gdrive-integration-1780a21efebe.json';

// The admin user the service account impersonates via domain-wide delegation.
// The Directory API returns 2SV status only to a domain admin.
const ADMIN_SUBJECT = process.env.GOOGLE_ADMIN_SUBJECT || 'ben.reilly@cognisys.group';

// Slack channel the results are posted to. Requires SLACK_BOT_TOKEN (see
// lib/slack.js) and the bot to be a member of the channel.
const SLACK_CHANNEL = process.env.MFA_SLACK_CHANNEL || 'C08PPV2D2TY';

// Read-only Directory scope is enough to list users and read their 2SV status.
const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.readonly'];

// Builds an authorised Admin SDK Directory client impersonating ADMIN_SUBJECT.
async function directoryClient() {
  if (!ADMIN_SUBJECT) {
    throw new Error('GOOGLE_ADMIN_SUBJECT is not set (admin user to impersonate)');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: SCOPES,
    clientOptions: { subject: ADMIN_SUBJECT },
  });
  const client = await auth.getClient();
  return google.admin({ version: 'directory_v1', auth: client });
}

// Fetches every user in the domain, following pagination.
async function listAllUsers(admin) {
  const users = [];
  let pageToken;
  do {
    const res = await admin.users.list({
      customer: 'my_customer',
      maxResults: 500,
      orderBy: 'email',
      // Only fields we need; keeps the response small.
      fields: 'nextPageToken,users(primaryEmail,name/fullName,suspended,archived,isEnforcedIn2Sv,isEnrolledIn2Sv)',
      pageToken,
    });
    if (res.data.users) users.push(...res.data.users);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return users;
}

// Runs the check: lists users, filters those without 2SV enforced, prints them.
// Returns the array of affected users so callers/tests can inspect the result.
async function runMfaCheck() {
  const admin = await directoryClient();
  const users = await listAllUsers(admin);

  // "Without MFA enforced" — 2-Step Verification is not enforced for the user.
  // Suspended and archived accounts are exempt; they can't sign in anyway.
  const withoutMfa = users.filter(u =>
    !u.suspended && !u.archived && u.isEnforcedIn2Sv !== true);

  console.log(`[mfa-check] ${withoutMfa.length} of ${users.length} user(s) do not have MFA enforced:`);
  for (const u of withoutMfa) {
    const name = u.name && u.name.fullName ? u.name.fullName : '';
    const enrolled = u.isEnrolledIn2Sv ? 'enrolled-not-enforced' : 'not-enrolled';
    console.log(`[mfa-check]  - ${u.primaryEmail}${name ? ` (${name})` : ''} [${enrolled}]`);
  }

  await postToSlack(withoutMfa, users.length);

  log.info('MFA check complete', { total: users.length, without_mfa: withoutMfa.length });
  return withoutMfa;
}

// Posts the results to Slack. A Slack failure is logged but never propagated —
// the check itself has already succeeded and printed to the console/logs.
async function postToSlack(withoutMfa, total) {
  const header = withoutMfa.length === 0
    ? `:white_check_mark: MFA check: all ${total} user(s) have MFA enforced.`
    : `:warning: MFA check: ${withoutMfa.length} of ${total} user(s) do *not* have MFA enforced:`;
  const lines = withoutMfa.map(u => {
    const name = u.name && u.name.fullName ? u.name.fullName : '';
    const enrolled = u.isEnrolledIn2Sv ? 'enrolled, not enforced' : 'not enrolled';
    return `• ${u.primaryEmail}${name ? ` (${name})` : ''} — ${enrolled}`;
  });
  const text = [header, ...lines].join('\n');
  try {
    await slack.postMessage(SLACK_CHANNEL, text);
  } catch (err) {
    log.error('MFA check: Slack post failed', { reason: err.message });
  }
}

module.exports = { runMfaCheck };
