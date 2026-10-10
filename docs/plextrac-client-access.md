# Plextrac access for auth-form contacts

When a client submits their authorisation form, the people on its **General Information**
page get access to their report in Plextrac:

- the **primary contact**: always
- each **additional contributor**: unless the client switched off **Plextrac access** on that contributor

The page tells the client this in a notice at the bottom. The portal requires a valid email
for the primary contact, and for any contributor whose Plextrac access is left on.

```
SFE portal: form submitted
   └ POST /api/plextrac/client-users   (portal → break.services, X-API-Key = BREAK_SERVICES_API_KEY)
        pipeline/plextrac-client-users.js
          1. which Plextrac client: the form's, else the one recorded for its ClickUp task / DeliveryFlow engagement
          2. per email: create the user if missing (default role = Client)
          3. authorise them on the client with the Client role
          4. read the client back: each person must be on it as Client
          5. Slack (SLACK_AUTH_FORM_CHANNEL): who was added, and anything to check
```

## Never the Default Group

Plextrac's **Default Group** gives a user access to **every client in the tenant**, both
existing clients and any created later. Taking someone out of the group does not remove the
client access they already got.

- Users are created with `default_group: false`.
- After creating them, the user list is read again. Anyone in the Default Group is **not**
  authorised on the client, and Slack raises an alarm (`default_group`) so they can be fixed by hand.
- An existing user in the Default Group is left alone and flagged in the same way.
- If Plextrac's user list doesn't say whether a user is in the group, they're treated as in it.

## Only ever the Client role

- Users are created with the Client role as their default role, and authorised on the client with the Client role.
- `PLEXTRAC_CLIENT_ROLE` must be a custom role code (`TENANT_<id>_ROLE_<KEY>`). `ADMIN`, `STD_USER` and `ANALYST` are refused, and nothing is created.
- If the service account can list roles, the Client role must exist before anything is created.
- **Existing users with another role are left alone.** If a contributor's email already belongs to a Plextrac user whose role isn't Client (a member of staff, say), they are not changed or added. Slack flags them to check by hand.
- Cognisys addresses (`REPORT_EMAIL_INTERNAL_DOMAINS`, default `cognisys.group,cognisys.co.uk`) are always skipped.
- After authorising, the client is read back. Anyone not on it as Client is reported as **FAILED** in Slack.

## No duplicates

- Emails are compared lower-cased, and an email repeated on a form counts once.
- A user is only created when the tenant has no user with that email. Otherwise the existing user is reused.
- Someone already on the client is left as is, and Slack isn't notified.
- Runs are serialised, so two forms submitted at once can't both create the same person.
- Resubmitting a form is safe: everyone is already there, so nothing changes.

## Outcomes (Slack and logs: `Plextrac client access: <email> — <outcome>`)

| Outcome | Meaning |
|---|---|
| `created` | new Plextrac user, authorised on the client as Client |
| `added` | existing Client-role user, authorised on this client |
| `already_on_client` | already had access |
| `internal` | Cognisys address, skipped |
| `invalid_email` | not an email address, skipped |
| `other_role` | has a user with another role, left alone, check by hand |
| `disabled` | has a disabled user, skipped |
| `on_client_other_role` | already on the client with another role, left alone, check it |
| `default_group` | **in the Default Group, so can see every client.** Not authorised. Fix it in Plextrac now |
| `failed` | creating or authorising failed (detail says why) |

If the form has no Plextrac client, or its tasks are on different clients, nobody is added
and Slack says so.

## Setup

1. **Plextrac:** the Client role must exist (Admin → Security → Roles), and the break.services
   service account needs permission to create users and manage client users. It may also need
   permission to view security roles, so the role check works.
2. Check the role code (read-only):
   ```
   node scripts/inspect-client-role.js
   ```
   If the code isn't `TENANT_0_ROLE_CLIENT`, set `PLEXTRAC_CLIENT_ROLE` to the code it lists.
3. `.env`: `PLEXTRAC_CLIENT_ACCESS=on`, then restart.
4. Deploy break.services first, then the SFE portal. Until break.services has the endpoint, the
   portal's call fails harmlessly (logged as **Plextrac Access Failed** in the audit log).

New users get Plextrac's own account email to set their password.

## Weekly user audit

`pipeline/plextrac-user-audit.js` checks every Plextrac user once a week (Mondays 07:00 UK,
`PLEXTRAC_USER_AUDIT_SCHEDULE`). It is **read-only**: it lists users and clients and reads each
client's authorised users, and changes nothing.

Users on `cognisys.group` or `cognisys.co.uk` aren't checked (`PLEXTRAC_USER_AUDIT_EXEMPT_DOMAINS`). Everyone else is
flagged when they:
- have a role other than `TENANT_0_ROLE_CLIENT` or `TENANT_0_ROLE_CLIENT__CHANGE_STATUS_ENABLED` (`PLEXTRAC_USER_AUDIT_ROLES`), or no role
- are authorised on more than one client
- are in the Default Group

Findings go to `PLEXTRAC_USER_AUDIT_CHANNEL` (default: the status-violations channel), each with
the clients the user is on. A clean week posts nothing; it's only logged. Client counts only cover
clients the service account can see.

To run it now:
- `node scripts/plextrac-user-audit.js` prints the full list and posts nothing
- `POST /jobs/plextrac-user-audit` (X-API-Key) runs it like the weekly run
