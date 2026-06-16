const crypto = require('crypto');
const axios = require('axios');

async function fetchTaskDetails(taskId) {
  const { data } = await axios.get(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: process.env.CLICKUP_API_TOKEN }
  });
  return data;
}

async function handler(req, res) {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[ClickUp] CLICKUP_WEBHOOK_SECRET is not set');
    return res.status(500).end();
  }

  // Verify HMAC-SHA256 signature — req.body is a raw Buffer here
  const signature = req.headers['x-signature'];
  const computed = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (signature !== computed) {
    console.warn('[ClickUp] Rejected webhook — invalid signature');
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).end();
  }

  // Acknowledge immediately so ClickUp doesn't retry
  res.status(200).end();

  if (payload.event !== 'taskCreated') return;

  try {
    const task = await fetchTaskDetails(payload.task_id);

    console.log('\n========== NEW TASK CREATED ==========');
    console.log(`Task Name : ${task.name}`);
    console.log(`Task ID   : ${task.id}`);
    console.log(`URL       : ${task.url}`);
    console.log('\nFull task details:');
    console.log(JSON.stringify(task, null, 2));
    console.log('======================================\n');
  } catch (err) {
    console.error('[ClickUp] Failed to fetch task details:', err.message);
  }
}

module.exports = handler;
