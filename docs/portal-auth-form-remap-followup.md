# Follow-up prompt — wire break.services into the new portal remap endpoints

Hand this back to Claude Code **in this repo** (`clickupToPlextracIntegration`) once the
portal side of `docs/portal-auth-form-remap-spec.md` is deployed. Paste from the line
below; fill in the two answers at the top first.

---

The portal now implements `POST /api/clickup/auth-form/remap` and
`POST /api/clickup/auth-form/withdraw` as specified in
`docs/portal-auth-form-remap-spec.md`. Wire `POST /tasks/remap` into them so a remap
moves the authorisation form instead of minting a fresh one and leaving the old one live.

Before starting, confirm against the deployed portal (and tell me if either differs from
the spec, rather than coding around it):

- Does the transfer preserve the form token, or mint a new URL?
- Does the portal re-fire `/clickup/finalised-auth-form` for the target itself, or does
  it only return `finalisedDriveUrl` for us to attach?

## What to change

**1. `lib/secure-portal-api.js`** — add two thin clients alongside `createAuthForm` /
`updateAuthForm`, same `portalPost` helper so they inherit the shared-secret header, the
timeout and the `portalError` wrapping (which attaches `.status`, needed for the branching
below):

- `remapAuthForm(payload)` → `POST /api/clickup/auth-form/remap`
- `withdrawAuthForm(payload)` → `POST /api/clickup/auth-form/withdraw`

**2. New `pipeline/auth-form-remap.js`** — the form half of a remap, in the shape of the
existing `pipeline/auth-form-rename.js`: best-effort, never throws, logs its own failures,
Slack-notifies only what a human must act on. Export something like
`transferAuthFormForRemap(fromTaskId, toTask, { clientName, testType, previousClientName, previousTestType, clientId, reportId })`
returning `{ formUrl, transferred, signed, rescoped, withdrewSource }` or `null`.

Branching, mirroring how `auth-form-rename.js` handles portal status codes:

- **200** → write `formUrl` to the target task's `authformlink` field via the existing
  `setAuthFormLink` from `pipeline/auth-form-create.js`.
- **404** (no form on the source) → fall back to today's behaviour:
  `createAuthFormForTask(toTask, …)`. This is the normal path for a task whose form was
  never generated, so it must stay silent-and-working, not warn.
- **409** (target already has its own form) → don't touch either form; return null and
  Slack-notify with both form references so a human can resolve it.
- **422 / anything else** → log, Slack the portal's `reason` verbatim, return null.

If the portal does **not** re-fire the finalised form itself, and the response carries
`signed: true` with a `finalisedDriveUrl`, attach it to the target task here. Reuse the
attach path rather than duplicating it — `routes/clickup-actions.js` currently has that
logic inline in the `/clickup/finalised-auth-form` handler, so extract it into a
`lib/`-level helper (e.g. `attachFinalisedAuthForm(taskId, { driveUrl, clientName })`)
and call it from both places. Don't copy-paste it.

**3. `pipeline/task-admin.js`** — in `remapTask`, replace the unconditional
`createAuthFormForTask(toTask, …)` with the transfer above, passing the pre-move
mapping's parsed name as `previous*` (`mapping.task_name` → `parseTaskName`, and
`mapping.testing_type` for the type, same precedence as `handleTaskRename` uses).

Then withdraw the source's form **only when there was nothing to transfer** — i.e. the
404-fallback path created a separate form for the target and the source still has its
own. When the form was transferred, the source no longer has one and a withdraw would be
a spurious 404.

Update the returned result and the Slack notice:

- Add `auth_form_transferred`, `auth_form_signed`, `source_form_withdrawn` to the response.
- **Drop `manual_followup` when the form was transferred or the source's was withdrawn** —
  there is no longer any manual tidy-up, and leaving that string in would be misleading.
  Keep it for the paths where the source really does keep a live form.
- Same for the Slack notice: the "withdraw it in the portal if that task is a duplicate"
  sentence should only appear when that's actually still true.

**4. Clear the source task's `authformlink` field** when its form was transferred or
withdrawn — otherwise the abandoned task keeps advertising a dead link. Add a small
helper next to `setAuthFormLink` (which is already exported from
`pipeline/auth-form-create.js`) rather than inlining another `setTaskCustomField` call.

## Tests

Extend `tests/task-admin.test.js`; it already stubs the portal via `portal.createAuthForm`
/ `portal.updateAuthForm` on the module object and drives real HTTP against the router, so
add `portal.remapAuthForm` / `portal.withdrawAuthForm` stubs to the same fake portal and
keep asserting through the endpoint. Cover:

- transfer succeeds → target's `authformlink` gets the returned URL, source's is cleared,
  no `manual_followup`, no "withdraw it in the portal" in the notice
- transfer of a signed form → the signed PDF ends up attached to the target and
  `auth_form_signed: true` is reported
- portal 404 → falls back to creating the target's form, then withdraws the source's, and
  says so
- portal 409 → neither form touched, the remap still reports the mapping move (the
  mapping move must not be rolled back by a form failure — it's the source of truth for
  the status sync)
- portal 500 → remap still succeeds and reports the form step as failed

Then run the whole suite (`npm test`), not just this file.

## Docs

Update `docs/task-admin.md`:

- "What follows the remap, and what doesn't" — the auth-form family now *does* follow it.
  Keep the distinction between mapping-keyed and portal-keyed automations, since it still
  explains why the two behave differently, but correct the consequences.
- "What remap deliberately leaves alone" — the manual portal tidy-up is gone; say what
  remains (the two self-healing Slack messages).
- The signed-form timing caveat ("nothing back-fills the signed PDF onto the target") is
  now wrong. Replace it with what actually happens.

Also add a line to `docs/portal-auth-form-remap-spec.md` marking it as implemented, with
the date, so nobody re-specs it.

## Constraints

- Don't change the mapping-move ordering in `remapTask`: the `task_mappings` update must
  land before the form work, and a form failure must never roll it back. Everything
  Plextrac-facing keys off that document.
- No new env vars — reuse `SECURE_PORTAL_URL` and `BREAK_SERVICES_API_KEY`.
- Keep every portal call best-effort. A portal outage must leave the remap itself
  successful, with the form step reported as failed.
