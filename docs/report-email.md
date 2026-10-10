# Report email on release

When a Plextrac report is **released** (moved to `Published`), the service writes the
client's "your report is ready" email as a reply in their existing onboarding email chain.
The draft goes in the Gmail of the PM who sent that onboarding email. The code is in
`pipeline/report-email.js`.

Onboarding emails are still sent by hand, by PMs from their own inboxes. This feature only
handles the final report email.

## What happens on release

```
Plextrac: report → Published
   └ release announcement in Slack (existing)
       ├ PDFs filed in Drive / Plextrac (existing, pipeline/release-exports.js)
       └ report email (this feature)
            1. find the client's portal links (auth form, test-files upload)
            2. search the CONNECTED PMs' mailboxes for the chain holding them
            3. reply-all to it as a Gmail DRAFT in the mailbox of the PM running it, signed with their Gmail signature
               (no chain holds the links → nothing drafted; Slack says the thread couldn't be found)
            4. reply in the Slack release thread: "drafted in your Drafts, @PM please check and send"
```

The Slack reply looks like this:

```
📧 Report email for Acme Corp drafted in ben@cognisys.group's Drafts, from ben@cognisys.group,
   as a reply in "RE: Acme Corp – Penetration Test Onboarding". @Ben please check it and press send.
   To: jane@acme.com, bob@acme.com · Cc: pentestpm@cognisys.group, alice@cognisys.group
   Open the email chain
```

**Draft mode is the only mode right now.** The service never sends a client email itself.
The PM opens their Drafts, checks the email, and presses send.

## Access: each PM connects their own Gmail

There is **no domain-wide access**. The service can only reach a mailbox whose owner has
connected it themselves:

1. A PM or admin opens **Gmail** in the SFE portal sidebar and clicks **Connect Gmail**.
2. Google's normal consent screen asks them to allow two things:
   - **Read** (`gmail.readonly`): search their mailbox for a client's portal links, and read that chain's senders, recipients and subject.
   - **Compose** (`gmail.compose`): create the draft.
3. They're sent back to the portal's Gmail page: "Connected as ben@cognisys.group".

Safeguards on the way back (`lib/gmail-oauth.js`):

- **Their own account only.** The Google account must be the portal user's own: the same mailbox, on either Cognisys domain. Signing in as anyone else is refused, and that grant is revoked straight away.
- **Both permissions needed.** Google lets people untick boxes; a partial grant is refused and revoked.
- **No replayed callbacks.** The link between the portal and Google's callback is single-use, expires after 10 minutes, and uses PKCE.
- **Tokens encrypted at rest.** The stored token is encrypted with `REPORT_EMAIL_TOKEN_KEY` (AES-256-GCM). The portal never sees it.

Disconnecting from the portal deletes the token and revokes it at Google. A PM can also
remove access from their Google account (Security → Third-party connections). The next
release then finds their connection refused, marks it **needs reconnecting** (shown on
their portal Gmail page), and skips their mailbox.

The portal logs **Gmail Connect Started** and **Gmail Disconnected** in its audit log.

**What this access still means:** break.services holds a token that can read each
connected PM's mailbox. If the server were compromised, those mailboxes would be exposed,
and only those. Keep `REPORT_EMAIL_TOKEN_KEY` out of the database's reach (it lives in
`.env`), and PMs who don't want the feature simply don't connect.

## One-off setup

### 1. Google Cloud: an OAuth client (a Google Workspace admin)

1. Go to console.cloud.google.com and choose (or create) a project in the **Cognisys organisation**.
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - **User type: Internal.** Only Cognisys accounts can use it, and Google needs no app review.
   - App name: e.g. *Cognisys report emails*.
   - Support email and developer contact: yours.
   - Scopes: add `.../auth/gmail.readonly` and `.../auth/gmail.compose`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorised redirect URI: `https://api.break.services/report-email/oauth/callback`
5. Copy the client ID and secret into break.services' `.env` (step 2).
6. If admin.google.com → Security → API controls → **App access control** blocks unconfigured
   third-party apps, find this OAuth client there and mark it **Trusted**.

### 2. break.services `.env`

```
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=…
REPORT_EMAIL_TOKEN_KEY=<64 hex>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
REPORT_EMAIL_MODE=draft           # off (default) | draft
```

`SECURE_PORTAL_URL` (already set) is where the browser goes back to after connecting. Restart
the app (`pm2 restart <app>`). The startup log says who has connected:

```
[INFO] Report email on release | mode="draft" | switch="REPORT_EMAIL_MODE" | connected="ben@cognisys.group, alice@cognisys.group" | needs_reconnecting="(none)"
```

### 3. Deploy order

1. Deploy **break.services** first; its `/api/report-email/*` endpoints must exist before the portal calls them.
2. Then deploy the **SFE portal**. It needs no new settings: it reaches break.services through `BREAK_SERVICES_BASE_URL`, as the client merge does.

### 4. PMs connect

Each PM opens the portal's **Gmail** page and connects. The feature only works for engagements
where the PM who sent the onboarding email, or a colleague cc'd on it, has connected.

## Checking it before switching it on

Run this against reports already released:

```
node scripts/preview-report-email.js 277397777 277398012
```

It lists who has connected. For each report it prints:
- the portal links searched for
- the chain it would reply in, and whose mailbox it's in
- whether the sender's Gmail signature was found
- the From, To and Cc lines
- the email text

It creates nothing.

## How the chain is found

Each onboarding email carries the client's portal links:
- the authorisation form: `…/form/<uuid>`
- the test-files upload link: `…/test-files/<uuid>`

Every connected mailbox is searched for those uuids:

- **DeliveryFlow engagements:** the engagement's links, plus those of every engagement on the
  same deal. One deal gets one combined form, so it has one onboarding email.
- **ClickUp tasks:** the task's `authformlink` and `testfilesstorage` fields.

One conversation can be in several mailboxes, for example when one PM cc'd another.
Copies that share a message are treated as the **same chain**. If several different chains
match, the most recently active one is used.

The draft goes in the copy belonging to **the PM who last wrote in the chain**. If that PM
hasn't connected, it goes in the copy of a connected colleague who was on the chain, and
that colleague is tagged instead.

**The chain is only ever found by a portal link in it.** Nothing else is used to guess it: not
the client's name, not the subject. If no chain holds a link, nothing is drafted, and the
release thread says:

```
⚠️ Report email not drafted — the onboarding email thread for Acme Corp couldn't be found. Please send the report email by hand.
```

It also lists any connections that need reconnecting, since that may be why.

## Who it goes to, and from

The reply is reply-all on the chain's latest message that has the client on it:

- **To:** every non-Cognisys address on that message (its sender, To and Cc)
- **Cc:** the Cognisys people on it (`cognisys.group`, `cognisys.co.uk`), including pentestpm@ if it was on the chain
- **Never included:** the PM whose mailbox it's in
- **From:** the address that PM last used in the chain. That's normally their own address. If they never wrote in it, Gmail uses their own address.

The draft carries `In-Reply-To` / `References` headers, so it threads in the client's mail client too.

## The wording

The wording lives in `config/report-email.js`: the team's standard "your report is ready"
email ("Hi team, Great news, your report is now ready! …"), ending "Best wishes,". It is the
same for every report.

Below "Best wishes," comes **the PM's own Gmail signature**: the one set in Gmail (Settings →
Signature) for the address the reply is from, or their default signature if that address has
none. It's read with the Gmail access the PM already granted. If no signature is found, the
email is still drafted without one, and the Slack message says to add it before sending.

## Once per report

Each report's email is recorded in the `report_emails` collection. Releasing a report
again, or a webhook delivered twice, makes no second draft.

| Outcome | Slack says | Can be retried |
|---|---|---|
| `drafted` | draft waiting in a PM's Drafts, @PM | only with `force` |
| `no_thread` | the thread couldn't be found (no chain holds the portal links), send by hand | yes |
| `no_client` | chain has no client address, send by hand | yes |
| `failed` | the error (and who needs to reconnect), send by hand | yes |

To make the email again (for example after a PM connects, or deleting a draft by mistake):

```
curl -X POST https://api.break.services/jobs/report-email \
  -H "X-API-Key: $AVAILABILITY_API_KEY" -H "Content-Type: application/json" \
  -d '{"reportId": 277397777}'            # add "force": true to replace a made draft
```

The outcome goes to the report's release thread in Slack.

## Log trail

Every line starts with `Report email` (or `Gmail`, for connections) and carries `report_id` where there is one:

```
[INFO] Gmail connected for report emails | mailbox="ben@cognisys.group" | portal_user="ben@cognisys.group"
[WARN] Gmail connect refused — not the portal user's own mailbox | portal_email="…" | google_account="…"
[INFO] Report email STARTED | report_id=… | client="Acme Corp" | mode="draft"
[WARN] Report email: could not search a mailbox | mailbox="alice@cognisys.group" | reason="invalid_grant: …"
[WARN] Report email: could not read the Gmail signature — drafting without it | report_id=… | mailbox="…" | reason="…"
[INFO] Report email DRAFTED | report_id=… | mailbox="ben@cognisys.group" | thread_id="…" | to="…" | cc="…" | signature=true
[WARN] Report email not drafted — no_thread | report_id=… | tokens=2 | unsearched="alice@cognisys.group"
[INFO] Report email skipped — REPORT_EMAIL_MODE is off | report_id=…
[ERROR] Report email FAILED | report_id=… | reason="…" | fix="the PM reconnects Gmail in the SFE portal"
```
