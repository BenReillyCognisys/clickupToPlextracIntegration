// MFA (2-Step Verification) enforcement check.
//
// Uses the Google Workspace Admin SDK Directory API to list every user in the
// domain and reports those who do NOT have 2-Step Verification enforced. The
// list is printed to the console (and mirrored to the log file via the shared
// logger). It runs on a daily 14:00 cron and can be triggered early via
// POST /jobs/mfa-check.
//
// Each run posts a single Slack message and then deletes the one from the
// previous run (best-effort), so the channel only ever shows the latest status.
// We persist the previous run's flagged users (in MongoDB), so any user who was
// flagged last run but has since enrolled is called out in a ":white_check_mark:
// Fixed since last run" section — making it obvious at a glance who's resolved.
//
// The Directory API only exposes 2SV status to a domain admin, so the service
// account must have domain-wide delegation and impersonate an admin user
// (GOOGLE_ADMIN_SUBJECT). The service-account key defaults to the production
// path but can be overridden with GOOGLE_SERVICE_ACCOUNT_KEY.

const { google } = require('googleapis');
const log = require('../lib/logger');
const slack = require('../lib/slack');
const store = require('../lib/mfa-check-store');

// Path to the service-account JSON key. Defaults to the production location.
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  || '/var/app/api/sfe-app-gdrive-integration-1780a21efebe.json';

// The admin user the service account impersonates via domain-wide delegation.
// The Directory API returns 2SV status only to a domain admin.
const ADMIN_SUBJECT = process.env.GOOGLE_ADMIN_SUBJECT || 'ben.reilly@cognisys.group';

// Slack channel the results are posted to. Requires SLACK_BOT_TOKEN (see
// lib/slack.js) and the bot to be a member of the channel.
const SLACK_CHANNEL = process.env.MFA_SLACK_CHANNEL || 'C0BGHRNU22X';

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

  // "Without MFA" — the account has no active second factor right now.
  // isEnrolledIn2Sv reflects whether the user has actually completed setup;
  // isEnforcedIn2Sv only reflects whether the admin *policy* requires it,
  // which can be true for users who are still in a grace period or simply
  // haven't complied yet — those users still have zero protection, so
  // enrollment (not enforcement) is the field that determines risk here.
  // Suspended and archived accounts are exempt; they can't sign in anyway.
  const withoutMfa = users.filter(u =>
    !u.suspended && !u.archived && u.isEnrolledIn2Sv !== true);

  console.log(`[mfa-check] ${withoutMfa.length} of ${users.length} user(s) do not have MFA enrolled:`);
  for (const u of withoutMfa) {
    const name = u.name && u.name.fullName ? u.name.fullName : '';
    // Distinguish *why* they're unprotected: no policy requiring it at all
    // (a config gap) vs. policy requires it but they haven't complied yet
    // (a user/grace-period gap). Both are flagged, but they need different
    // follow-up (fix the OU policy vs. chase the individual).
    const reason = u.isEnforcedIn2Sv ? 'enforced-but-not-enrolled' : 'not-enforced-not-enrolled';
    console.log(`[mfa-check]  - ${u.primaryEmail}${name ? ` (${name})` : ''} [${reason}]`);
  }

  await postToSlack(withoutMfa, users);

  log.info('MFA check complete', { total: users.length, without_mfa: withoutMfa.length });
  return withoutMfa;
}

// Posts the results to Slack, deletes the previous run's message, and records the
// new one so the next run can delete it in turn and work out who's since been
// fixed. A Slack/store failure is logged but never propagated — the check itself
// has already succeeded and printed to the console/logs.
async function postToSlack(withoutMfa, users) {
  const total = users.length;

  // Read the previous run's state up front: we need its flagged-user list to
  // work out the "fixed" set, and its message ts to delete after we repost.
  let previous = null;
  try {
    previous = await store.getLastMessage();
  } catch (err) {
    log.error('MFA check: could not read previous run state', { reason: err.message });
  }

  // "Fixed" = users who were flagged last run and, in this run, are present and
  // now enrolled in 2SV. Requiring enrollment (rather than merely dropping off
  // the flagged list) means a user who was suspended/archived/deleted since last
  // run isn't miscounted as having fixed their MFA.
  const byEmail = new Map(users.map(u => [u.primaryEmail, u]));
  const fixed = (previous?.users || [])
    .map(email => byEmail.get(email))
    .filter(u => u && u.isEnrolledIn2Sv === true);

  const text = renderMessage(withoutMfa, fixed, total);

  let newTs;
  try {
    newTs = await slack.postMessage(SLACK_CHANNEL, text);
  } catch (err) {
    log.error('MFA check: Slack post failed', { reason: err.message });
    return;
  }

  // New message is up — delete the previous run's one (exactly one, best-effort).
  if (previous?.ts && previous.ts !== newTs) {
    try {
      await slack.deleteMessage(previous.channel || SLACK_CHANNEL, previous.ts);
    } catch (err) {
      log.error('MFA check: failed to delete previous message', { reason: err.message, ts: previous.ts });
    }
  }

  // Record this run's message + flagged users so the next run can delete it and
  // compute its own "fixed" list.
  try {
    await store.setLastMessage(SLACK_CHANNEL, newTs, withoutMfa.map(u => u.primaryEmail));
  } catch (err) {
    log.error('MFA check: failed to record new message id (next run may leave it in place)', { reason: err.message });
  }
}

// Renders the Slack message: the warning/all-clear header and the flagged users,
// followed (when any) by a green-tick "Fixed since last run" section so resolved
// users are easy to spot at a glance.
function renderMessage(withoutMfa, fixed, total) {
  const header = withoutMfa.length === 0
    ? `:white_check_mark: MFA check: all ${total} user(s) have MFA enrolled.`
    : `:warning: MFA check: ${withoutMfa.length} of ${total} user(s) do *not* have MFA enrolled:`;
  const lines = withoutMfa.map(u => {
    const name = u.name && u.name.fullName ? u.name.fullName : '';
    const reason = u.isEnforcedIn2Sv ? 'policy enforced, user has not completed setup' : 'not enforced by policy, and not enrolled';
    return `• ${u.primaryEmail}${name ? ` (${name})` : ''} — ${reason}`;
  });

  const out = [header, ...lines];

  if (fixed.length) {
    out.push('');
    out.push(`:white_check_mark: *Fixed since last run — ${fixed.length} user(s) now have MFA enrolled:*`);
    for (const u of fixed) {
      const name = u.name && u.name.fullName ? u.name.fullName : '';
      out.push(`• :white_check_mark: ${u.primaryEmail}${name ? ` (${name})` : ''}`);
    }
  }

  return out.join('\n');
}

module.exports = { runMfaCheck };
