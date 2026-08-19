# VMaaS listener (SecOps space)

The server listens to two ClickUp spaces. Both webhooks POST to the same endpoint,
`/webhook/clickup`, and the fetched task decides which pipeline runs.

| Space | Scope | Pipeline |
|---|---|---|
| Penetration Test (`CLICKUP_SPACE_ID`) | whole space | Plextrac client + report, auth form, reports-due |
| SecOps (`CLICKUP_SECOPS_SPACE_ID`) | VMaaS folder only (`CLICKUP_VMAAS_FOLDER_ID`) | VMaaS auth form |

## Why two webhooks

ClickUp scopes a webhook to a single space and offers no folder-level scope, so a
second webhook is required for SecOps, and it delivers **everything** in that space —
Cyber Essentials, Templates, the lot. The VMaaS folder filter is applied server-side
in `config/monitored-spaces.js` after the task is fetched.

Each webhook is issued its own signing secret. `routes/clickup-webhook.js` accepts a
payload signed with either `CLICKUP_WEBHOOK_SECRET` or `CLICKUP_WEBHOOK_SECRET_SECOPS`.

## What runs for a VMaaS task

A VMaaS task is named after the client and nothing else — no `Client | Testing Type`
to parse, and no Plextrac report behind it (`pipeline/vmaas.js`).

- **taskCreated** — the task name is taken as the client's full name and the secure
  portal generates that client's authorisation form with the testing type `VMaaS`.
  The returned link is written to the task's `authformlink` custom field and posted
  to Slack. Tasks still carrying the template placeholder name (`Test Task`) are
  skipped until they're renamed.
- **taskUpdated (rename)** — the name *is* the client name, so a rename asks the
  portal to re-render the form under the new one, passing the previous name from the
  webhook's `history_items` so the portal knows what it's replacing. A rename away
  from the placeholder generates the form instead. A signed form comes back as a 409
  and is posted to Slack for a human to reissue.
- **taskStatusUpdated** — subscribed and logged, but **no downstream action is
  configured yet**. The pentest equivalent crosses a report off the weekly
  reports-due message, which VMaaS has no counterpart for.
  `handleVmaasStatusChange` in `pipeline/vmaas.js` is where that behaviour hangs.

Ignored in all cases: subtasks, tasks outside the VMaaS folder, and tasks in any list
whose name contains "template" (the folder holds `VMaaS Project List Template`, and
fresh copies of it carry the same name until renamed).

## Dependency on the portal

The portal must have an element registered under the exact testing type `VMaaS`,
otherwise `POST /api/clickup/auth-form` will reject or mis-scope the form. Nothing on
this side needs to change if that name differs — set `VMAAS_TEST_TYPE` in
`pipeline/vmaas.js` to whatever the portal expects.

## Setup

```bash
# 1. Configure the space + folder (already in .env.example with the real ids)
CLICKUP_SECOPS_SPACE_ID=90150758482
CLICKUP_VMAAS_FOLDER_ID=901517065720

# 2. Register the second webhook — prints the secret
node scripts/register-secops-webhook.js

# 3. Put the printed secret in the server .env, then restart
CLICKUP_WEBHOOK_SECRET_SECOPS=...
```

`node scripts/list-webhooks.js` shows both webhooks and the space each is bound to.

Re-issuing secrets is per webhook and neither script touches the other's:

- pentest: `node scripts/reset-webhook.js` (filters on `CLICKUP_SPACE_ID`)
- SecOps: `node scripts/register-secops-webhook.js --replace`

Leaving `CLICKUP_VMAAS_FOLDER_ID` blank makes the server ignore every SecOps event —
that's the safe default, so the webhook can be registered before the folder id is set
without acting on Cyber Essentials tasks.
