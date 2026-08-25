const assert  = require('assert');
const http    = require('http');
const express = require('express');

// The router's auth middleware reads this at request time.
process.env.BREAK_SERVICES_API_KEY = 'test-key';
process.env.SLACK_AUTH_FORM_CHANNEL = 'C0AUTH';
process.env.CLICKUP_TEAM_ID = 'team-1'; // workspace id for the V3 custom-field upload

// ── Stub the outbound helpers BEFORE the router is required ────────────────────
// routes/clickup-actions destructures these on import, so the fakes must be in
// place first. We mutate the module exports objects the router will destructure.
const clickupApi = require('../lib/clickup-api');
const slack      = require('../lib/slack');
const availability = require('../lib/availability-cache');
const googleDrive  = require('../lib/google-drive');

// In-memory comment store keyed by task id; a task id of 'FAIL' throws.
const comments = {};   // taskId -> [{ id, comment_text }]
let nextCommentId = 1;
const scheduled = [];  // recorded updateTaskSchedule calls
const slackPosts = []; // recorded postMessage calls
const attachments = {}; // taskId -> [{ filename, size, fieldId }]
const fieldValues = {}; // taskId -> { [fieldId]: value } from setTaskCustomField
const descriptions = {}; // taskId -> markdown description string
let nextAttachmentId = 1;
let taskState = {};     // taskId -> { start_date, due_date, custom_fields } returned by getTask

// The "Authorisation Forms" File custom field, present on every task by default so
// the finalised-auth-form flow can resolve it. taskState may override per task.
const AUTH_FORM_FILE_FIELD = { id: 'cf-authforms', name: 'Authorisation Forms', type: 'attachment' };

clickupApi.listTaskComments = async (taskId) => {
  if (taskId === 'FAIL') throw new Error('boom (list)');
  return comments[taskId] || [];
};
clickupApi.createTaskComment = async (taskId, text) => {
  if (taskId === 'FAIL') throw new Error('boom (create)');
  const id = `c${nextCommentId++}`;
  (comments[taskId] ||= []).push({ id, comment_text: text });
  return id;
};
clickupApi.updateComment = async (commentId, text) => {
  for (const list of Object.values(comments)) {
    const c = list.find((x) => x.id === commentId);
    if (c) { c.comment_text = text; return; }
  }
  throw new Error(`comment ${commentId} not found`);
};
clickupApi.updateTaskSchedule = async (taskId, opts) => {
  if (taskId === 'FAIL') throw new Error('boom (schedule)');
  scheduled.push({ taskId, ...opts });
};
// Recorded updateTaskStatus calls; 'STATUSFAIL' models a rejected status (e.g. the
// status doesn't exist in the space) so the non-fatal path can be asserted.
const statusWrites = [];
clickupApi.updateTaskStatus = async (taskId, status) => {
  if (taskId === 'STATUSFAIL') throw new Error('boom (status)');
  statusWrites.push({ taskId, status });
};
// Uploads to a File custom field entity (V3) and returns a fresh attachment id.
let lastUpload = null;
clickupApi.uploadCustomFieldAttachment = async (workspaceId, fieldId, buffer, filename) => {
  const id = `att-${nextAttachmentId++}`;
  lastUpload = { workspaceId, fieldId, filename, size: buffer.length, id };
  return { id, title: filename };
};
clickupApi.setTaskCustomField = async (taskId, fieldId, value) => {
  (fieldValues[taskId] ||= {})[fieldId] = value;
  // Mirror the association into `attachments` so the flow's result is easy to assert.
  if (value && Array.isArray(value.add)) {
    for (const attId of value.add) {
      (attachments[taskId] ||= []).push({ filename: lastUpload?.filename, size: lastUpload?.size, fieldId, attId });
    }
  }
};
clickupApi.getTask = async (taskId) => {
  // 'FAIL' / 'GETFAIL' model a task read failure (e.g. a deleted task 404).
  if (taskId === 'GETFAIL' || taskId === 'FAIL') throw new Error('boom (getTask)');
  const state = taskState[taskId] || {};
  // Default every task to carrying the Authorisation Forms field unless overridden.
  const custom_fields = state.custom_fields || [AUTH_FORM_FILE_FIELD];
  return { id: taskId, ...state, custom_fields };
};
clickupApi.getTaskDescription = async (taskId) => descriptions[taskId] || '';
clickupApi.updateTaskDescription = async (taskId, markdown) => { descriptions[taskId] = markdown; };
// Real Drive share links — the route validates the URL itself (only the download is
// stubbed), so these must parse as genuine Drive links.
const DRIVE_OK   = 'https://drive.google.com/file/d/FILEID123/view';
const DRIVE_FAIL = 'https://drive.google.com/file/d/FAILID999/view';
// The canonical link the route rebuilds from the file id and writes to descriptions.
const DRIVE_OK_CANONICAL = 'https://drive.google.com/file/d/FILEID123/view';

// Drive download stub: DRIVE_FAIL throws; otherwise returns a small fake file carrying
// the same fileId/canonicalUrl shape the real helper produces.
googleDrive.downloadDriveFile = async (driveUrl) => {
  if (driveUrl === DRIVE_FAIL) throw new Error('boom (drive)');
  const fileId = googleDrive.fileIdFromUrl(driveUrl);
  return {
    buffer: Buffer.from('signed-form-bytes'),
    filename: 'Auth Form.pdf',
    mimeType: 'application/pdf',
    fileId,
    canonicalUrl: googleDrive.driveFileUrl(fileId),
  };
};
let slackShouldFail = false; // toggled by the "Slack fails" test (channel is hardcoded)
slack.postMessage = async (channel, text) => {
  if (channel === 'C0FAIL' || slackShouldFail) throw new Error('boom (slack)');
  slackPosts.push({ channel, text });
  return '123.456';
};
// Consultant resolution: a tiny fake members map + the real findUserInMap.
availability.cache.availability = { membersMap: { 99: { id: 99, name: 'Jane Smith', email: 'jane@example.com' } } };

const router = require('../routes/clickup-actions');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

function request(path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/clickup', router);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request({
        port, path, method,
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const KEY = { 'X-API-Key': 'test-key' };

(async () => {
  // ── merged-auth-form ────────────────────────────────────────────────────────
  console.log('POST /clickup/merged-auth-form:');

  await test('rejects a missing/wrong API key with 401', async () => {
    const r = await request('/clickup/merged-auth-form', { body: {} });
    assert.strictEqual(r.status, 401);
  });

  await test('rejects a missing clickupTaskIds array with 400', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY, body: { clientName: 'Acme', mergedFormUrl: 'https://f/1' },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('creates one comment per task on first call', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: {
        clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1',
        clickupTaskIds: ['T1', 'T2'], testTypes: ['External', 'Wireless'], dayCount: 2.5,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['created', 'created']);
    assert.strictEqual(comments.T1.length, 1);
    assert.ok(comments.T1[0].comment_text.includes('[merged-auth-form:tok-1]'));
    assert.ok(comments.T1[0].comment_text.includes('https://f/1'));
  });

  await test('is idempotent — a repeat call updates the same comment, not stacks', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: {
        clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1',
        clickupTaskIds: ['T1', 'T2', 'T3'], testTypes: ['External', 'Wireless', 'Internal'], dayCount: 4,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['updated', 'updated', 'created']);
    assert.strictEqual(comments.T1.length, 1, 'T1 must still have exactly one comment');
    assert.ok(comments.T1[0].comment_text.includes('Internal'), 'comment text was refreshed');
  });

  await test('reports a per-task failure but still 200 when others succeed', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1', clickupTaskIds: ['T1', 'FAIL'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    const fail = r.json.results.find((x) => x.taskId === 'FAIL');
    assert.strictEqual(fail.action, 'failed');
    assert.ok(fail.error);
  });

  await test('returns 502 with ok:false when every task fails', async () => {
    const r = await request('/clickup/merged-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', mergedFormUrl: 'https://f/1', mergedFormToken: 'tok-1', clickupTaskIds: ['FAIL'] },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
  });

  // ── finalised-auth-form ───────────────────────────────────────────────────────
  console.log('\nPOST /clickup/finalised-auth-form:');

  await test('rejects a missing driveUrl / task ids with 400', async () => {
    const r = await request('/clickup/finalised-auth-form', { headers: KEY, body: { clientName: 'Acme' } });
    assert.strictEqual(r.status, 400);
  });

  await test('downloads the form once and attaches it to each task', async () => {
    descriptions.A1 = 'Existing description body.'; // A1 already has description text
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskIds: ['A1', 'A2'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.results.map((x) => x.action), ['attached', 'attached']);
    assert.strictEqual(attachments.A1.length, 1);
    assert.strictEqual(attachments.A1[0].filename, 'Auth Form.pdf');
    assert.strictEqual(attachments.A2[0].size, Buffer.from('signed-form-bytes').length);
    // The file lands on the "Authorisation Forms" custom field (add/rem shape), not
    // the task's general attachments.
    assert.strictEqual(attachments.A1[0].fieldId, 'cf-authforms');
    assert.deepStrictEqual(fieldValues.A1['cf-authforms'], { add: [attachments.A1[0].attId], rem: [] });
    // The link is prepended to the description, above the existing text (not over it).
    assert.deepStrictEqual(r.json.results.map((x) => x.description), ['updated', 'updated']);
    assert.ok(descriptions.A1.startsWith(`📄 **Authorisation form:** ${DRIVE_OK_CANONICAL}`), 'link is at the top');
    assert.ok(descriptions.A1.includes('Existing description body.'), 'existing text is preserved');
    assert.ok(descriptions.A2.includes(DRIVE_OK_CANONICAL), 'link added even when there was no prior description');
  });

  await test('does not prepend the link twice on a repeat call (idempotent description)', async () => {
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY,
      body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'A1' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].description, 'skipped');
    const occurrences = descriptions.A1.split('📄 **Authorisation form:**').length - 1;
    assert.strictEqual(occurrences, 1, 'the auth-form line appears exactly once');
  });

  await test('rejects a driveUrl that is not a Google Drive link with 400', async () => {
    for (const bad of [
      'https://evil.example/file/d/ABC123/view',   // wrong host
      'http://drive.google.com/file/d/ABC123/view', // not https
      'https://drive.google.com/file/nope',         // no file id
      'not-a-url',
    ]) {
      const r = await request('/clickup/finalised-auth-form', {
        headers: KEY, body: { clientName: 'Acme', driveUrl: bad, clickupTaskId: 'BAD1' },
      });
      assert.strictEqual(r.status, 400, `expected 400 for ${bad}`);
      assert.ok(!attachments.BAD1, `nothing attached for ${bad}`);
    }
  });

  await test('strips smuggled markdown from driveUrl before writing the description', async () => {
    // A real file id with attacker markdown appended — only the id may survive.
    const smuggled = 'https://drive.google.com/file/d/FILEID123/view#\n\n## Urgent\n[Re-auth](https://evil.example)';
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: smuggled, clickupTaskId: 'INJ1' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(descriptions.INJ1, `📄 **Authorisation form:** ${DRIVE_OK_CANONICAL}`);
    assert.ok(!descriptions.INJ1.includes('evil.example'), 'attacker link is not in the description');
    assert.ok(!descriptions.INJ1.includes('Urgent'), 'attacker markdown is not in the description');
  });

  await test('fails the task when the Authorisation Forms field is absent', async () => {
    taskState = { NOFIELD: { custom_fields: [{ id: 'x', name: 'Something Else' }] } };
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'NOFIELD' },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
    assert.ok(/not found/.test(r.json.results[0].error), 'error names the missing field');
    assert.ok(!attachments.NOFIELD, 'nothing associated when the field is missing');
    taskState = {};
  });

  await test('accepts a single clickupTaskId too', async () => {
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'A3' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(attachments.A3.length, 1);
  });

  await test('returns 502 when the Drive download fails (nothing to attach)', async () => {
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_FAIL, clickupTaskIds: ['A4'] },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
    assert.ok(!attachments.A4, 'no attachment attempted when the download failed');
  });

  await test('reports a per-task attach failure but still 200 when others succeed', async () => {
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskIds: ['A5', 'FAIL'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.results.find((x) => x.taskId === 'FAIL').action, 'failed');
  });

  // ── extra-urls ────────────────────────────────────────────────────────────────
  console.log('\nPOST /clickup/extra-urls:');

  await test('rejects an empty urls array with 400', async () => {
    const r = await request('/clickup/extra-urls', { headers: KEY, body: { clientName: 'Acme', urls: [] } });
    assert.strictEqual(r.status, 400);
  });

  await test('comments on the task and posts to Slack', async () => {
    const before = slackPosts.length;
    const r = await request('/clickup/extra-urls', {
      headers: KEY,
      body: {
        clientName: 'Acme', formToken: 'f1', formUrl: 'https://f/x', clickupTaskId: 'U1',
        urls: ['https://a.acme.com', 'https://b.acme.com'], urlCount: 2,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ ok: r.json.ok, clickup: r.json.clickup, slack: r.json.slack }, { ok: true, clickup: 'commented', slack: 'sent' });
    assert.strictEqual(comments.U1.length, 1);
    assert.strictEqual(slackPosts.length, before + 1);
    assert.strictEqual(slackPosts.at(-1).channel, 'C0AA3SNQUKE', 'alert goes to the hardcoded channel');
    assert.ok(slackPosts.at(-1).text.includes('app.clickup.com/t/U1'), 'Slack text links the task');
  });

  await test('skips the comment when clickupTaskId is null but still alerts Slack', async () => {
    const r = await request('/clickup/extra-urls', {
      headers: KEY,
      body: { clientName: 'Acme', clickupTaskId: null, urls: ['https://a.acme.com', 'https://b.acme.com'] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.clickup, 'skipped');
    assert.strictEqual(r.json.slack, 'sent');
  });

  await test('returns 502 when the only work (Slack) fails', async () => {
    slackShouldFail = true;
    const r = await request('/clickup/extra-urls', {
      headers: KEY, body: { clientName: 'Acme', clickupTaskId: null, urls: ['https://a', 'https://b'] },
    });
    assert.strictEqual(r.status, 502);
    assert.deepStrictEqual({ ok: r.json.ok, clickup: r.json.clickup, slack: r.json.slack }, { ok: false, clickup: 'skipped', slack: 'failed' });
    slackShouldFail = false;
  });

  // ── schedule-task ─────────────────────────────────────────────────────────────
  console.log('\nPOST /clickup/schedule-task:');

  await test('rejects a missing endDate with 400', async () => {
    const r = await request('/clickup/schedule-task', { headers: KEY, body: { clickupTaskId: 'S1', startDate: '2026-09-07' } });
    assert.strictEqual(r.status, 400);
  });

  await test('rejects a malformed date with 400', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'S1', startDate: 'not-a-date', endDate: '2026-09-08' },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('writes UTC-midnight ms dates and resolves the consultant assignee', async () => {
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'S1', startDate: '2026-09-07', endDate: '2026-09-08', consultant: 'Jane Smith', testType: 'Paid Black Box Pentest', days: 2 },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.start_date, Date.parse('2026-09-07T00:00:00Z'));
    assert.strictEqual(r.json.due_date, Date.parse('2026-09-08T00:00:00Z'));
    assert.strictEqual(scheduled.length, before + 1);
    assert.strictEqual(scheduled.at(-1).assigneeId, 99, 'Jane Smith resolves to user id 99');
  });

  await test('still sets dates when the consultant cannot be resolved (non-fatal)', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'S2', startDate: '2026-09-07', endDate: '2026-09-08', consultant: 'Nobody Here' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(scheduled.at(-1).assigneeId, null);
  });

  await test('returns 502 when the ClickUp update fails', async () => {
    const r = await request('/clickup/schedule-task', {
      headers: KEY, body: { clickupTaskId: 'FAIL', startDate: '2026-09-07', endDate: '2026-09-08' },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.ok, false);
  });

  await test('Free Black Box: schedules on first submission (no existing start date)', async () => {
    taskState = { FB1: {} }; // no start_date yet
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'FB1', startDate: '2026-09-07', endDate: '2026-09-08', testType: 'Free Black Box Test' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.skipped, undefined);
    assert.strictEqual(scheduled.length, before + 1, 'first submission writes the dates');
  });

  await test('Free Black Box: a repeat submission does NOT change the dates', async () => {
    taskState = { FB2: { start_date: '1757203200000', due_date: '1757289600000' } };
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'FB2', startDate: '2027-01-01', endDate: '2027-01-02', testType: 'Free Black Box Test' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.skipped, true);
    assert.strictEqual(r.json.start_date, 1757203200000, 'original start date is preserved');
    assert.strictEqual(scheduled.length, before, 'no schedule write happened');
  });

  await test('a repeat NON-Free-Black-Box submission still updates the dates', async () => {
    taskState = { PB1: { start_date: '1757203200000' } };
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'PB1', startDate: '2027-01-01', endDate: '2027-01-02', testType: 'Paid Black Box Pentest' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.skipped, undefined);
    assert.strictEqual(scheduled.length, before + 1, 'non-Free type is not frozen');
  });

  await test('Free Black Box: a task read failure falls through to a normal update', async () => {
    const before = scheduled.length;
    const r = await request('/clickup/schedule-task', {
      headers: KEY,
      body: { clickupTaskId: 'GETFAIL', startDate: '2026-09-07', endDate: '2026-09-08', testType: 'Free Black Box Test' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.skipped, undefined);
    assert.strictEqual(scheduled.length, before + 1, 'transient read failure does not block scheduling');
  });

  // ── finalised-auth-form: pre-reqs status ──────────────────────────────────────
  console.log('\nPOST /clickup/finalised-auth-form (pre-reqs status):');

  await test('advances a task in an early status to the pre-reqs status', async () => {
    taskState = { PR1: { status: { status: 'to do', type: 'open' } } };
    const before = statusWrites.length;
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'PR1' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].status, 'set');
    assert.strictEqual(statusWrites.length, before + 1);
    assert.deepStrictEqual(statusWrites.at(-1), { taskId: 'PR1', status: 'Waiting for Pre-reqs' });
  });

  await test('matches the early status case-insensitively', async () => {
    taskState = { PR2: { status: { status: 'To Do', type: 'open' } } };
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'PR2' },
    });
    assert.strictEqual(r.json.results[0].status, 'set');
  });

  await test('leaves a task that has moved on alone (QA is not dragged backwards)', async () => {
    taskState = { PR3: { status: { status: 'QA / Reviewing', type: 'custom' } } };
    const before = statusWrites.length;
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'PR3' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].action, 'attached', 'the form is still attached');
    assert.strictEqual(r.json.results[0].status, 'skipped');
    assert.strictEqual(statusWrites.length, before, 'no status write happened');
  });

  await test('a task already in the pre-reqs status is not re-written', async () => {
    taskState = { PR4: { status: { status: 'Waiting for Pre-reqs', type: 'custom' } } };
    const before = statusWrites.length;
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'PR4' },
    });
    assert.strictEqual(r.json.results[0].status, 'already_set');
    assert.strictEqual(statusWrites.length, before);
  });

  await test('a failed status write is non-fatal — the form stays attached', async () => {
    taskState = { STATUSFAIL: { status: { status: 'to do', type: 'open' } } };
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'STATUSFAIL' },
    });
    assert.strictEqual(r.status, 200, 'not a 502 — the attachment already succeeded');
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.results[0].action, 'attached');
    assert.strictEqual(r.json.results[0].status, 'failed');
    assert.strictEqual((attachments.STATUSFAIL || []).length, 1);
  });

  await test('a merged form advances each task independently', async () => {
    taskState = {
      PR5: { status: { status: 'to do', type: 'open' } },
      PR6: { status: { status: 'Completed', type: 'done' } },
    };
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskIds: ['PR5', 'PR6'] },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results.map((x) => x.status), ['set', 'skipped']);
  });

  await test('a task with no status field is skipped, not advanced', async () => {
    taskState = { PR7: {} }; // getTask returned no status at all
    const before = statusWrites.length;
    const r = await request('/clickup/finalised-auth-form', {
      headers: KEY, body: { clientName: 'Acme', driveUrl: DRIVE_OK, clickupTaskId: 'PR7' },
    });
    assert.strictEqual(r.json.results[0].status, 'skipped');
    assert.strictEqual(statusWrites.length, before);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
