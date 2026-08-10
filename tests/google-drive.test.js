const assert = require('assert');

// Read at require time by lib/google-drive, so it must be set first.
process.env.GOOGLE_DRIVE_AUTH_FORM_FOLDER_ID = 'FOLDER_AUTH';

const { fileIdFromUrl, driveFileUrl, withinAuthFormFolder } = require('../lib/google-drive');

let passed = 0, failed = 0;
function test(description, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓  ${description}`); passed++; })
    .catch((err) => { console.error(`  ✗  ${description}\n       ${err.message}`); failed++; });
}

// Fake Drive client over a { folderId: [parentIds] } tree. A folder listed in
// `unreadable` throws, modelling an ancestor the service account can't see.
function fakeDrive(tree, unreadable = []) {
  return {
    files: {
      get: async ({ fileId }) => {
        if (unreadable.includes(fileId)) throw new Error('404');
        return { data: { parents: tree[fileId] || [] } };
      },
    },
  };
}

(async () => {
  console.log('fileIdFromUrl — accepts genuine Drive links:');

  await test('/file/d/<id>/view', () => {
    assert.strictEqual(fileIdFromUrl('https://drive.google.com/file/d/ABC-123_x/view'), 'ABC-123_x');
  });

  await test('docs.google.com /document/d/<id>/edit', () => {
    assert.strictEqual(fileIdFromUrl('https://docs.google.com/document/d/ID9/edit'), 'ID9');
  });

  await test('open?id=<id>', () => {
    assert.strictEqual(fileIdFromUrl('https://drive.google.com/open?id=ID8'), 'ID8');
  });

  await test('uc?id=<id>&export=download', () => {
    assert.strictEqual(fileIdFromUrl('https://drive.google.com/uc?id=ID7&export=download'), 'ID7');
  });

  console.log('\nfileIdFromUrl — rejects everything else:');

  await test('a non-Drive host', () => {
    assert.strictEqual(fileIdFromUrl('https://evil.example/file/d/ABC/view'), null);
  });

  await test('a lookalike host', () => {
    assert.strictEqual(fileIdFromUrl('https://drive.google.com.evil.example/file/d/ABC/view'), null);
  });

  await test('plain http', () => {
    assert.strictEqual(fileIdFromUrl('http://drive.google.com/file/d/ABC/view'), null);
  });

  await test('a Drive URL with no file id', () => {
    assert.strictEqual(fileIdFromUrl('https://drive.google.com/drive/my-drive'), null);
  });

  await test('junk / empty / null', () => {
    assert.strictEqual(fileIdFromUrl('not-a-url'), null);
    assert.strictEqual(fileIdFromUrl(''), null);
    assert.strictEqual(fileIdFromUrl(null), null);
  });

  console.log('\nfileIdFromUrl — strips smuggled content (no substring matching):');

  await test('markdown appended in the fragment yields only the id', () => {
    const smuggled = 'https://drive.google.com/file/d/REALID/view#\n\n[phish](https://evil.example)';
    assert.strictEqual(fileIdFromUrl(smuggled), 'REALID');
    assert.strictEqual(driveFileUrl(fileIdFromUrl(smuggled)), 'https://drive.google.com/file/d/REALID/view');
  });

  await test('a /d/ pattern hidden in the query string is not treated as the id', () => {
    // The id must come from the path or ?id=; a decoy elsewhere must not win.
    assert.strictEqual(fileIdFromUrl('https://drive.google.com/file/d/REALID/view?x=/d/DECOY'), 'REALID');
  });

  await test('a /d/ pattern on a non-Drive host is still rejected', () => {
    assert.strictEqual(fileIdFromUrl('https://evil.example/?u=https://drive.google.com/file/d/ABC/view'), null);
  });

  console.log('\nwithinAuthFormFolder — folder restriction:');

  await test('file directly in the auth-form folder passes', async () => {
    const drive = fakeDrive({});
    assert.strictEqual(await withinAuthFormFolder(drive, ['FOLDER_AUTH']), true);
  });

  await test('file in a per-client subfolder passes', async () => {
    // CLIENT_A → FOLDER_AUTH
    const drive = fakeDrive({ CLIENT_A: ['FOLDER_AUTH'] });
    assert.strictEqual(await withinAuthFormFolder(drive, ['CLIENT_A']), true);
  });

  await test('file several levels deep still passes (within the depth cap)', async () => {
    const drive = fakeDrive({ L3: ['L2'], L2: ['L1'], L1: ['FOLDER_AUTH'] });
    assert.strictEqual(await withinAuthFormFolder(drive, ['L3']), true);
  });

  await test('file in an unrelated folder is rejected', async () => {
    const drive = fakeDrive({ OTHER: ['ROOT'], ROOT: [] });
    assert.strictEqual(await withinAuthFormFolder(drive, ['OTHER']), false);
  });

  await test('file with no parents is rejected', async () => {
    const drive = fakeDrive({});
    assert.strictEqual(await withinAuthFormFolder(drive, []), false);
    assert.strictEqual(await withinAuthFormFolder(drive, undefined), false);
  });

  await test('a chain longer than the depth cap is rejected, not crawled forever', async () => {
    // 8 levels — deeper than MAX_FOLDER_DEPTH (5).
    const drive = fakeDrive({
      D8: ['D7'], D7: ['D6'], D6: ['D5'], D5: ['D4'],
      D4: ['D3'], D3: ['D2'], D2: ['D1'], D1: ['FOLDER_AUTH'],
    });
    assert.strictEqual(await withinAuthFormFolder(drive, ['D8']), false);
  });

  await test('an unreadable ancestor fails closed rather than throwing', async () => {
    const drive = fakeDrive({ HIDDEN: ['FOLDER_AUTH'] }, ['HIDDEN']);
    assert.strictEqual(await withinAuthFormFolder(drive, ['HIDDEN']), false);
  });

  await test('a parent cycle terminates instead of looping', async () => {
    const drive = fakeDrive({ A: ['B'], B: ['A'] });
    assert.strictEqual(await withinAuthFormFolder(drive, ['A']), false);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
