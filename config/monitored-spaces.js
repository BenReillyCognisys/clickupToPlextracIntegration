// Which ClickUp spaces the webhook acts on, and which pipeline each one drives.
//
// Two webhooks feed the same endpoint (/webhook/clickup):
//   • Penetration Test space (CLICKUP_SPACE_ID)      → the Plextrac create pipeline
//   • SecOps space (CLICKUP_SECOPS_SPACE_ID)         → the VMaaS auth-form pipeline
//
// ClickUp scopes a webhook to a whole space — there is no folder-level scope — so
// the SecOps webhook delivers Cyber Essentials, Templates and everything else in
// the space too. The VMaaS folder filter (CLICKUP_VMAAS_FOLDER_ID) is therefore
// applied here, on the fetched task, not by ClickUp.
//
// Env is read on every call (not at module load) so tests can set it per case.

// Lists whose tasks are template scaffolding rather than real client work — the
// VMaaS folder holds "VMaaS Project List Template", and copies of it appear under
// the same name until they're renamed. Tasks in a matching list are ignored.
const TEMPLATE_LIST_PATTERN = /template/i;

const str = (v) => (v == null ? '' : String(v));
const sameId = (a, b) => str(a) !== '' && str(a) === str(b);

/**
 * Decides which pipeline (if any) a fetched ClickUp task belongs to.
 * Returns { pipeline: 'pentest' | 'vmaas' | null, reason } — `reason` explains a
 * null pipeline so the caller can log why the task was ignored.
 */
function classifyTask(task) {
  const pentestSpaceId = process.env.CLICKUP_SPACE_ID;
  const secopsSpaceId = process.env.CLICKUP_SECOPS_SPACE_ID;
  const vmaasFolderId = process.env.CLICKUP_VMAAS_FOLDER_ID;
  const spaceId = task?.space?.id;

  if (sameId(pentestSpaceId, spaceId)) return { pipeline: 'pentest', reason: null };

  if (sameId(secopsSpaceId, spaceId)) {
    // SecOps is only monitored for the VMaaS folder. Without the folder id
    // configured we'd act on every Cyber Essentials task in the space, so treat an
    // unset id as "nothing in SecOps is monitored" rather than "everything is".
    if (!str(vmaasFolderId)) {
      return { pipeline: null, reason: 'CLICKUP_VMAAS_FOLDER_ID is not set — SecOps tasks are ignored' };
    }
    if (!sameId(vmaasFolderId, task?.folder?.id)) {
      return { pipeline: null, reason: 'in SecOps but outside the VMaaS folder' };
    }
    if (TEMPLATE_LIST_PATTERN.test(str(task?.list?.name))) {
      return { pipeline: null, reason: 'in a VMaaS template list' };
    }
    return { pipeline: 'vmaas', reason: null };
  }

  // No space filter configured at all: keep the historic behaviour of treating
  // everything as pentest work rather than silently dropping every event.
  if (!str(pentestSpaceId) && !str(secopsSpaceId)) {
    return { pipeline: 'pentest', reason: null };
  }

  return { pipeline: null, reason: 'outside the monitored spaces' };
}

module.exports = { classifyTask, TEMPLATE_LIST_PATTERN };
