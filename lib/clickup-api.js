const axios = require('axios');

const BASE = 'https://api.clickup.com/api/v2';
// V3 is only used for the Attachments API, which (unlike V2) can upload a file to a
// File-type custom field entity rather than only to a task's general attachments.
const BASE_V3 = 'https://api.clickup.com/api/v3';

// Sensible ceiling for outbound ClickUp calls so a hung request can't wedge a
// handler indefinitely (ClickUp normally responds in well under a second).
const CLICKUP_TIMEOUT_MS = Number(process.env.CLICKUP_TIMEOUT_MS) || 15000;

function authHeaders() {
  return { Authorization: process.env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
}

function isAuthError(err) {
  return err.response?.status === 401 || err.response?.status === 403;
}

// Turns an axios error into a compact, loggable message (status + trimmed body)
// without ever including the Authorization header / token. Auth failures are
// surfaced with the same clear message the other helpers use.
function clickupError(err, method, path) {
  if (isAuthError(err)) {
    return new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
  }
  const status = err.response?.status || 'ERR';
  const body = typeof err.response?.data === 'string'
    ? err.response.data
    : JSON.stringify(err.response?.data ?? err.message);
  return new Error(`ClickUp ${status} ${method} ${path}: ${String(body).slice(0, 400)}`);
}

async function validateToken() {
  try {
    await axios.get(`${BASE}/user`, { headers: authHeaders() });
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
    }
    throw err;
  }
}

// Fetches a single task (includes start_date, due_date, assignees, custom_fields).
// Used by the start-date watcher to re-check tasks whose report was created before
// a start date was set.
async function getTask(taskId) {
  return clickupGet(`${BASE}/task/${taskId}`);
}

async function updateTaskStatus(taskId, status) {
  try {
    await axios.put(`${BASE}/task/${taskId}`, { status }, { headers: authHeaders() });
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
    }
    throw err;
  }
}

// GET helper that maps ClickUp auth failures to a clear error (mirrors the
// handling in the functions above) and returns the parsed body.
async function clickupGet(url) {
  try {
    const { data } = await axios.get(url, { headers: authHeaders() });
    return data;
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
    }
    throw err;
  }
}

/**
 * Returns every list id in a space: lists inside folders plus folderless lists
 * that live directly in the space, so new lists are picked up automatically.
 *
 * @param {string} spaceId
 * @param {object} [opts]
 * @param {string[]} [opts.excludeListIds] list ids to drop from the result
 */
async function getSpaceListIds(spaceId, { excludeListIds = [] } = {}) {
  const exclude = new Set(excludeListIds);
  const [folders, folderless] = await Promise.all([
    clickupGet(`${BASE}/space/${spaceId}/folder`),
    clickupGet(`${BASE}/space/${spaceId}/list`),
  ]);

  const ids = new Set();
  for (const folder of folders.folders || []) {
    for (const list of folder.lists || []) ids.add(list.id);
  }
  for (const list of folderless.lists || []) ids.add(list.id);

  return [...ids].filter((id) => !exclude.has(id));
}

/**
 * Fetches every task in a list (following pagination), including each task's
 * custom_fields and assignees. Unlike listSpaceTasks this can include subtasks.
 *
 * @param {string} listId
 * @param {object} [opts]
 * @param {boolean} [opts.subtasks]      include subtasks (default true)
 * @param {boolean} [opts.includeClosed] include closed tasks (default false)
 */
async function listListTasks(listId, { subtasks = true, includeClosed = false } = {}) {
  const all = [];
  for (let page = 0; ; page++) {
    const params = new URLSearchParams();
    params.append('page', String(page));
    params.append('subtasks', String(subtasks));
    params.append('include_closed', String(includeClosed));

    const data = await clickupGet(`${BASE}/list/${listId}/task?${params.toString()}`);
    const tasks = data.tasks || [];
    all.push(...tasks);
    if (data.last_page || tasks.length === 0) break;
  }
  return all;
}

/**
 * Fetches every (open, top-level) task in a space via the filtered team-tasks
 * endpoint, following pagination. Each returned task includes its `custom_fields`
 * and `assignees`. ClickUp returns up to 100 tasks per page.
 *
 * @param {string} spaceId
 * @param {object} [opts]
 * @param {string} [opts.teamId]        defaults to CLICKUP_TEAM_ID
 * @param {boolean} [opts.includeClosed] include closed tasks (default false)
 */
async function listSpaceTasks(spaceId, { teamId = process.env.CLICKUP_TEAM_ID, includeClosed = false } = {}) {
  if (!teamId) throw new Error('CLICKUP_TEAM_ID is not set — required to list space tasks');
  const all = [];
  for (let page = 0; ; page++) {
    const params = new URLSearchParams();
    params.append('space_ids[]', spaceId);
    params.append('page', String(page));
    params.append('include_closed', String(includeClosed));
    params.append('subtasks', 'false');

    let data;
    try {
      ({ data } = await axios.get(`${BASE}/team/${teamId}/task?${params.toString()}`, {
        headers: authHeaders(),
      }));
    } catch (err) {
      if (isAuthError(err)) {
        throw new Error('CLICKUP_API_TOKEN is invalid or revoked — check your .env');
      }
      throw err;
    }

    const tasks = data.tasks || [];
    all.push(...tasks);
    // ClickUp signals the end with last_page=true; guard on an empty page too.
    if (data.last_page || tasks.length === 0) break;
  }
  return all;
}

// ─── Comments ─────────────────────────────────────────────────────────────────

/**
 * Returns a task's comments (newest first, as ClickUp orders them). Each comment
 * has `id` and `comment_text` (the plain-text rendering) among other fields.
 */
async function listTaskComments(taskId) {
  try {
    const { data } = await axios.get(`${BASE}/task/${taskId}/comment`, {
      headers: authHeaders(),
      timeout: CLICKUP_TIMEOUT_MS,
    });
    return data.comments || [];
  } catch (err) {
    throw clickupError(err, 'GET', `/task/${taskId}/comment`);
  }
}

/** Creates a new comment on a task; returns the created comment's id. */
async function createTaskComment(taskId, commentText) {
  try {
    const { data } = await axios.post(
      `${BASE}/task/${taskId}/comment`,
      { comment_text: commentText, notify_all: false },
      { headers: authHeaders(), timeout: CLICKUP_TIMEOUT_MS },
    );
    return data.id;
  } catch (err) {
    throw clickupError(err, 'POST', `/task/${taskId}/comment`);
  }
}

/** Replaces the text of an existing comment (used to keep a marked comment fresh). */
async function updateComment(commentId, commentText) {
  try {
    await axios.put(
      `${BASE}/comment/${commentId}`,
      { comment_text: commentText },
      { headers: authHeaders(), timeout: CLICKUP_TIMEOUT_MS },
    );
  } catch (err) {
    throw clickupError(err, 'PUT', `/comment/${commentId}`);
  }
}

// ─── Custom fields ──────────────────────────────────────────────────────────

/**
 * Sets a single custom field value on a task. `value` is passed straight through
 * (a string for URL/text fields). Field id comes from the task's `custom_fields`.
 */
async function setTaskCustomField(taskId, fieldId, value) {
  try {
    await axios.post(
      `${BASE}/task/${taskId}/field/${fieldId}`,
      { value },
      { headers: authHeaders(), timeout: CLICKUP_TIMEOUT_MS },
    );
  } catch (err) {
    throw clickupError(err, 'POST', `/task/${taskId}/field/${fieldId}`);
  }
}

// ─── Task description ─────────────────────────────────────────────────────────

/**
 * Fetches a task's description as markdown. `include_markdown_description=true`
 * adds the `markdown_description` field to the response; falls back to the plain
 * `description`, then an empty string.
 */
async function getTaskDescription(taskId) {
  try {
    const { data } = await axios.get(
      `${BASE}/task/${taskId}?include_markdown_description=true`,
      { headers: authHeaders(), timeout: CLICKUP_TIMEOUT_MS },
    );
    return data.markdown_description ?? data.description ?? '';
  } catch (err) {
    throw clickupError(err, 'GET', `/task/${taskId}`);
  }
}

/**
 * Overwrites a task's description with markdown. `markdown_content` is ClickUp's
 * markdown setter on the update-task endpoint.
 */
async function updateTaskDescription(taskId, markdown) {
  try {
    await axios.put(
      `${BASE}/task/${taskId}`,
      { markdown_content: markdown },
      { headers: authHeaders(), timeout: CLICKUP_TIMEOUT_MS },
    );
  } catch (err) {
    throw clickupError(err, 'PUT', `/task/${taskId}`);
  }
}

// ─── Attachments ──────────────────────────────────────────────────────────────

/**
 * Uploads a file to a task's Attachments as multipart/form-data. `buffer` is the
 * raw file bytes and `filename` the name it appears under in ClickUp. Returns the
 * created attachment (id, url, …). The Authorization header is sent WITHOUT the
 * JSON content-type so axios sets the multipart boundary itself.
 */
async function uploadTaskAttachment(taskId, buffer, filename) {
  const form = new FormData();
  form.append('attachment', new Blob([buffer]), filename);
  try {
    const { data } = await axios.post(
      `${BASE}/task/${taskId}/attachment`,
      form,
      {
        headers: { Authorization: process.env.CLICKUP_API_TOKEN },
        timeout: CLICKUP_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );
    return data;
  } catch (err) {
    throw clickupError(err, 'POST', `/task/${taskId}/attachment`);
  }
}

/**
 * Uploads a file to a File-type custom field via the V3 Attachments API and returns
 * the created attachment (its `id` is what associates it with a task). The file is
 * uploaded to the `custom_fields` entity — NOT to a specific task — so the caller
 * must then link it to the task with setTaskCustomField (the add/rem shape). Sent as
 * multipart/form-data with the Authorization header only, so axios sets the boundary.
 *
 * @param {string} workspaceId ClickUp workspace/team id (CLICKUP_TEAM_ID)
 * @param {string} fieldId     the File custom field's id (from a task's custom_fields)
 */
async function uploadCustomFieldAttachment(workspaceId, fieldId, buffer, filename) {
  const form = new FormData();
  form.append('attachment', new Blob([buffer]), filename);
  const path = `/workspaces/${workspaceId}/custom_fields/${fieldId}/attachments`;
  try {
    const { data } = await axios.post(
      `${BASE_V3}${path}`,
      form,
      {
        headers: { Authorization: process.env.CLICKUP_API_TOKEN },
        timeout: CLICKUP_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );
    return data;
  } catch (err) {
    throw clickupError(err, 'POST', path);
  }
}

// ─── Task scheduling ──────────────────────────────────────────────────────────

/**
 * Writes start/due dates (unix ms, all-day) onto an existing task and, when an
 * assigneeId is supplied, adds them as an assignee. Dates and assignee are sent
 * in a single PUT so the caller can treat assignee resolution as optional.
 */
async function updateTaskSchedule(taskId, { startDateMs, dueDateMs, assigneeId = null }) {
  const body = {
    start_date:      startDateMs,
    start_date_time: false,
    due_date:        dueDateMs,
    due_date_time:   false,
  };
  if (assigneeId != null) body.assignees = { add: [assigneeId], rem: [] };
  try {
    await axios.put(`${BASE}/task/${taskId}`, body, {
      headers: authHeaders(),
      timeout: CLICKUP_TIMEOUT_MS,
    });
  } catch (err) {
    throw clickupError(err, 'PUT', `/task/${taskId}`);
  }
}

module.exports = {
  validateToken, getTask, updateTaskStatus, listSpaceTasks, getSpaceListIds, listListTasks,
  listTaskComments, createTaskComment, updateComment, updateTaskSchedule,
  setTaskCustomField, getTaskDescription, updateTaskDescription, uploadTaskAttachment,
  uploadCustomFieldAttachment,
};
