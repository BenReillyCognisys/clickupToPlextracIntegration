const assert = require('assert');
const { classifyTask } = require('../config/monitored-spaces');
const { vmaasRenameAction } = require('../pipeline/vmaas');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

const PENTEST_SPACE = '90151040426';
const SECOPS_SPACE = '90150758482';
const VMAAS_FOLDER = '901517065720';

// Env is read per call, so each case sets exactly what it needs.
function withEnv(env, fn) {
  const keys = ['CLICKUP_SPACE_ID', 'CLICKUP_SECOPS_SPACE_ID', 'CLICKUP_VMAAS_FOLDER_ID'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const configured = {
  CLICKUP_SPACE_ID: PENTEST_SPACE,
  CLICKUP_SECOPS_SPACE_ID: SECOPS_SPACE,
  CLICKUP_VMAAS_FOLDER_ID: VMAAS_FOLDER,
};

const task = ({ space, folder, list } = {}) => ({
  id: 'abc123',
  name: 'Acme Ltd',
  space: { id: space ?? SECOPS_SPACE, name: 'SecOps' },
  folder: folder === null ? undefined : { id: folder ?? VMAAS_FOLDER, name: 'VMaaS' },
  list: { id: '1', name: list ?? 'Acme Ltd' },
});

// ── Space / folder routing ───────────────────────────────────────────────────
// Both webhooks deliver to the same endpoint, so the fetched task decides which
// pipeline runs. SecOps is only monitored inside the VMaaS folder.
console.log('\nMonitored-space routing:');

test('a Penetration Test task routes to the pentest pipeline', () => {
  withEnv(configured, () => {
    const { pipeline } = classifyTask(task({ space: PENTEST_SPACE, folder: '999' }));
    assert.strictEqual(pipeline, 'pentest');
  });
});

test('a SecOps task in the VMaaS folder routes to the vmaas pipeline', () => {
  withEnv(configured, () => {
    assert.strictEqual(classifyTask(task()).pipeline, 'vmaas');
  });
});

test('a SecOps task outside the VMaaS folder is ignored', () => {
  withEnv(configured, () => {
    const { pipeline, reason } = classifyTask(task({ folder: '901516093315' }));
    assert.strictEqual(pipeline, null);
    assert.match(reason, /outside the VMaaS folder/);
  });
});

test('a folderless SecOps task is ignored', () => {
  withEnv(configured, () => {
    assert.strictEqual(classifyTask(task({ folder: null })).pipeline, null);
  });
});

test('a task in a VMaaS template list is ignored', () => {
  withEnv(configured, () => {
    const { pipeline, reason } = classifyTask(task({ list: 'VMaaS Project List Template' }));
    assert.strictEqual(pipeline, null);
    assert.match(reason, /template list/);
  });
});

test('SecOps is ignored entirely when the VMaaS folder id is unset', () => {
  withEnv({ ...configured, CLICKUP_VMAAS_FOLDER_ID: undefined }, () => {
    const { pipeline, reason } = classifyTask(task());
    assert.strictEqual(pipeline, null);
    assert.match(reason, /CLICKUP_VMAAS_FOLDER_ID/);
  });
});

test('a task in some other space is ignored', () => {
  withEnv(configured, () => {
    assert.strictEqual(classifyTask(task({ space: '90150758807' })).pipeline, null);
  });
});

test('with no space filter configured, everything falls back to pentest', () => {
  withEnv({}, () => {
    assert.strictEqual(classifyTask(task()).pipeline, 'pentest');
  });
});

// ── VMaaS renames ────────────────────────────────────────────────────────────
// The task name IS the client name, so a rename means the form has to be
// re-rendered — unless the task was still the template placeholder, in which case
// no form exists yet and one is created.
console.log('\nVMaaS rename handling:');

test('a placeholder → real name creates the form', () => {
  assert.strictEqual(vmaasRenameAction('Test Task', 'Acme Ltd'), 'create');
});

test('a missing previous name creates the form', () => {
  assert.strictEqual(vmaasRenameAction(null, 'Acme Ltd'), 'create');
});

test('a client rename re-scopes the form', () => {
  assert.strictEqual(vmaasRenameAction('Acme Ltd', 'Acme Group Ltd'), 'rescope');
});

test('a whitespace/case-only change does nothing', () => {
  assert.strictEqual(vmaasRenameAction('Acme Ltd', '  acme ltd '), 'none');
});

test('a rename back to the placeholder does nothing', () => {
  assert.strictEqual(vmaasRenameAction('Acme Ltd', 'Test Task'), 'none');
});

test('a rename to an empty name does nothing', () => {
  assert.strictEqual(vmaasRenameAction('Acme Ltd', '   '), 'none');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
