const axios = require('axios');

async function updateTaskStatus(taskId, status) {
  await axios.put(
    `https://api.clickup.com/api/v2/task/${taskId}`,
    { status },
    { headers: { Authorization: process.env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' } }
  );
}

module.exports = { updateTaskStatus };
