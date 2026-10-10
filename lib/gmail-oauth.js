// Connecting a PM's own Gmail for the report email — Google's normal OAuth consent, so
// each PM grants access to their own mailbox only, and can take it back at any time
// (in the SFE portal, or at myaccount.google.com → Security → Third-party connections).
//
//   portal "Connect" ─► POST /api/report-email/connect  ─► startConnect → Google consent URL
//   Google consent   ─► GET  /report-email/oauth/callback ─► finishConnect → back to the portal
//
// Guards on the way back:
//   • the state is single-use and expires after 10 minutes, and the code exchange uses
//     PKCE, so a callback can only finish the connect it was started for;
//   • both Gmail permissions must have been granted (Google lets people untick them);
//   • the Google account must be the portal user's own (same mailbox, either Cognisys
//     domain), so nobody can attach someone else's mailbox to their portal account.
//
// Needs an OAuth client of the "Web application" type in a Google Cloud project whose
// consent screen is Internal (Cognisys accounts only) — docs/report-email.md:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
//   REPORT_EMAIL_OAUTH_REDIRECT_URI  default {WEBHOOK_URL}/report-email/oauth/callback
//   REPORT_EMAIL_TOKEN_KEY           encrypts the stored tokens (lib/secret-box.js)

const crypto = require('crypto');
const { google } = require('googleapis');
const connections = require('./gmail-connections');
const box = require('./secret-box');
const { samePerson } = require('./slack-people');
const EMAIL = require('../config/report-email');
const log = require('./logger');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', // search for the client's chain, read its headers
  'https://www.googleapis.com/auth/gmail.compose', // create the draft
];

class ConnectError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function settings() {
  const base = String(process.env.WEBHOOK_URL || '').replace(/\/+$/, '');
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: process.env.REPORT_EMAIL_OAUTH_REDIRECT_URI || (base ? `${base}/report-email/oauth/callback` : ''),
  };
}

/** Everything a connection needs is set: the OAuth client and the token key. */
function isConfigured() {
  const s = settings();
  return Boolean(s.clientId && s.clientSecret && s.redirectUri && box.isConfigured());
}

function oauthClient() {
  const s = settings();
  return new google.auth.OAuth2(s.clientId, s.clientSecret, s.redirectUri);
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1);

/**
 * Starts a connect for a portal user (the portal has checked they are a PM or admin).
 * Returns { url } — Google's consent screen, to send their browser to.
 */
async function startConnect({ portalUserId, portalUsername, portalEmail }) {
  if (!isConfigured()) throw new ConnectError('Gmail connections are not set up on break.services yet', 503);
  if (!portalUserId) throw new ConnectError('portalUserId is required', 400);
  const email = norm(portalEmail) || norm(portalUsername);
  if (!looksLikeEmail(email)) {
    throw new ConnectError('Your portal account has no email address, so it can\'t be matched to a Gmail account', 400);
  }

  const client = oauthClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = crypto.randomBytes(32).toString('base64url');
  await connections.createState({ state, codeVerifier, portalUserId, portalUsername, portalEmail: email });

  const url = client.generateAuthUrl({
    access_type: 'offline', // a refresh token, so drafts can be made when a report is released
    prompt: 'consent', // always issue one, even for someone reconnecting
    scope: GMAIL_SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    login_hint: email,
  });
  return { url };
}

// Best-effort: a grant that won't be used is handed back to Google.
async function revoke(token) {
  if (!token) return;
  try {
    await oauthClient().revokeToken(token);
  } catch (err) {
    log.warn('Gmail token revoke failed', { reason: err.message });
  }
}

/**
 * Finishes a connect from Google's callback query ({ code, state, error }). Returns
 * { result, account? } where result is one of
 *   connected | denied | expired | missing_scopes | wrong_account | error
 */
async function finishConnect({ code, state, error }) {
  const pending = await connections.takeState(state);
  if (!pending) return { result: 'expired' };
  if (error) return { result: error === 'access_denied' ? 'denied' : 'error' };
  if (!code) return { result: 'error' };

  const client = oauthClient();
  const { tokens } = await client.getToken({ code, codeVerifier: pending.codeVerifier });
  const granted = String(tokens.scope || '').split(/\s+/).filter(Boolean);
  if (!GMAIL_SCOPES.every((s) => granted.includes(s))) {
    await revoke(tokens.refresh_token || tokens.access_token);
    log.warn('Gmail connect refused — not every permission was granted', { portal_user: pending.portalUsername, granted });
    return { result: 'missing_scopes' };
  }
  if (!tokens.refresh_token) {
    log.error('Gmail connect failed — Google returned no refresh token', { portal_user: pending.portalUsername });
    return { result: 'error' };
  }

  client.setCredentials(tokens);
  const { data } = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
  const mailbox = norm(data.emailAddress);
  const internal = EMAIL.internalDomains();
  if (!internal.includes(domainOf(mailbox)) || !samePerson(pending.portalEmail, mailbox)) {
    await revoke(tokens.refresh_token);
    log.warn('Gmail connect refused — not the portal user\'s own mailbox', {
      portal_user: pending.portalUsername, portal_email: pending.portalEmail, google_account: mailbox,
    });
    return { result: 'wrong_account', account: mailbox };
  }

  await connections.save({
    email: mailbox,
    portalUserId: pending.portalUserId,
    portalUsername: pending.portalUsername,
    refreshToken: tokens.refresh_token,
    scopes: granted,
  });
  log.info('Gmail connected for report emails', { mailbox, portal_user: pending.portalUsername });
  return { result: 'connected', account: mailbox };
}

/** A portal user's connection, for the portal's Gmail page. */
async function status(portalUserId) {
  const doc = portalUserId ? await connections.forPortalUser(portalUserId) : null;
  return {
    configured: isConfigured(),
    connected: Boolean(doc),
    email: doc?.email || null,
    status: doc?.status || null,
    connectedAt: doc?.connected_at || null,
    brokenReason: doc?.status === 'broken' ? doc.broken_reason : null,
  };
}

/** Removes a portal user's connection and revokes it at Google. */
async function disconnect(portalUserId) {
  if (!portalUserId) throw new ConnectError('portalUserId is required', 400);
  const removed = await connections.remove(portalUserId);
  if (!removed) return { disconnected: false };
  await revoke(removed.refreshToken);
  log.info('Gmail disconnected for report emails', { mailbox: removed.email });
  return { disconnected: true, email: removed.email };
}

/** Where the callback sends the browser: the portal's Gmail page, with the outcome. */
function portalReturnUrl({ result, account }) {
  const base = String(process.env.SECURE_PORTAL_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  const url = new URL(`${base}/dashboard/settings/gmail`);
  url.searchParams.set('gmail', result);
  if (account && result === 'wrong_account') url.searchParams.set('account', account);
  return url.toString();
}

module.exports = {
  startConnect, finishConnect, status, disconnect, portalReturnUrl, isConfigured, oauthClient,
  ConnectError, GMAIL_SCOPES,
};
