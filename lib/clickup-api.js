const axios = require('axios');

const BASE = 'https://api.clickup.com/api/v2';

function authHeaders() {
  return { Authorization: process.env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' };
}

function isAuthError(err) {
  return err.response?.status === 401 || err.response?.status === 403;
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

module.exports = { validateToken, updateTaskStatus, listSpaceTasks };
