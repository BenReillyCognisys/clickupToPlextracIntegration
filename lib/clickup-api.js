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

module.exports = { validateToken, updateTaskStatus };
