// Stress test: 100 reports released at the same moment (plus 5 webhooks delivered
// twice), across 30 clients with 3-4 reports each. Every file filed in Drive and
// Plextrac is then read back to prove it went to the right place with the right data.
//
// Real: every line of this service's code — runReleaseExports, the locks, Drive folder
// resolution, filenames, the document pipeline (screenshots included), and the
// renderer: a separate Python process per document rendering the REAL full-report,
// executive-summary and letter-of-attestation templates with Jinja2
// (tests/fixtures/render_without_weasyprint.py swaps only WeasyPrint's HTML → PDF
// step, so each document can be read back).
//
// Simulated: Google Drive (in memory — duplicate names allowed, arbitrary list order
// unless orderBy is asked for, like the real API) and Plextrac (findings in the
// positional-row shape the real list endpoint returns), each with random latency so
// the 105 runs interleave as badly as possible.
//
// Every report's data carries markers (REPORT-<id>, EXEC-<id>, SCOPE-<id>,
// CLIENT-<id>, FINDING-<id>, and a screenshot per finding), and each report has its
// own mix of finding severities, so a document holding another report's data — or
// another report's counts or screenshots — is caught.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const childProcess = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const REPORTS = 100;
const DUPLICATE_DELIVERIES = 5;
const CLIENTS = 30;
const RENDER_LIMIT = 4;

const jitter = (max) => new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * max)));

// ── Python available? ─────────────────────────────────────────────────────────
const python = process.env.PDF_RENDERER_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');
if (childProcess.spawnSync(python, ['-c', 'import jinja2'], { stdio: 'ignore' }).status !== 0) {
  console.log(`  -  SKIPPED release stress test (no jinja2 for ${python})\n`);
  process.exit(0);
}

// ── Templates: the real ones, copied so the test can't touch the originals ────
const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-templates-'));
for (const t of ['cognisys-full-report.j2', 'cognisys-exec-summary.j2', 'cognisys-letter-of-attestation.j2']) {
  fs.copyFileSync(path.join(ROOT_DIR, 'jinja2-export-templates', t), path.join(templateDir, t));
}

process.env.CLIENT_DOCS_TEMPLATE_DIR = templateDir;
process.env.PDF_RENDERER_PYTHON = python;
process.env.PDF_RENDER_CONCURRENCY = String(RENDER_LIMIT);
process.env.GOOGLE_DRIVE_REPORTS_FOLDER_ID = 'ROOT';

// ── Renderer processes: counted, and pointed at the WeasyPrint-less shim ──────
const RENDER_SCRIPT = path.join(ROOT_DIR, 'renderer', 'render.py');
const SHIM = path.join(__dirname, 'fixtures', 'render_without_weasyprint.py');
const procs = { active: 0, max: 0, total: 0 };
const realSpawn = childProcess.spawn;
childProcess.spawn = (cmd, args, opts) => {
  if (args?.[0] !== RENDER_SCRIPT) return realSpawn(cmd, args, opts);
  procs.active++; procs.total++; procs.max = Math.max(procs.max, procs.active);
  const child = realSpawn(cmd, [SHIM, ...args.slice(1)], opts);
  child.on('close', () => { procs.active--; });
  return child;
};

// ── Simulated Google Drive ────────────────────────────────────────────────────
const FOLDER = 'application/vnd.google-apps.folder';
const drive = { items: [], seq: 0, updates: 0 };
const unq = (s) => s.replace(/\\(.)/g, '$1');
const fakeDrive = {
  files: {
    list: async (p) => {
      await jitter(15);
      const parent = unq(/'((?:[^'\\]|\\.)*)' in parents/.exec(p.q)[1]);
      const nameM = /name = '((?:[^'\\]|\\.)*)'/.exec(p.q);
      let hits = drive.items.filter((i) => i.parent === parent
        && (!nameM || i.name === unq(nameM[1]))
        && (!p.q.includes(`mimeType = '${FOLDER}'`) || i.mimeType === FOLDER));
      // Real Drive's default order is not creation order — shuffle unless asked.
      hits = p.orderBy === 'createdTime' ? hits : hits.sort(() => Math.random() - 0.5);
      return { data: { files: hits.slice(0, p.pageSize || 100).map(({ id, name }) => ({ id, name })) } };
    },
    create: async ({ requestBody, media }) => {
      const content = media ? Buffer.concat(await media.body.toArray()) : null;
      await jitter(15);
      const item = { id: `D${++drive.seq}`, name: requestBody.name, parent: requestBody.parents[0],
        mimeType: requestBody.mimeType || media?.mimeType, content };
      drive.items.push(item);
      return { data: { id: item.id, name: item.name } };
    },
    update: async ({ fileId, media }) => {
      drive.updates++;
      const item = drive.items.find((i) => i.id === fileId);
      item.content = Buffer.concat(await Readable.from(media.body).toArray());
      return { data: { id: item.id, name: item.name } };
    },
  },
};
require.cache[require.resolve('googleapis')] = {
  loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, drive: () => fakeDrive } },
};

// ── The code under test ───────────────────────────────────────────────────────
const api = require('../lib/plextrac-api');
const slack = require('../lib/slack');
const { runReleaseExports } = require('../pipeline/release-exports');
const { safeFilename } = require('../pipeline/report-export');

// ── Simulated Plextrac ────────────────────────────────────────────────────────
const NAMES = ["O'Neill & Sons", 'Acme/Corp: Ltd', 'Émile Sécurité', 'Back\\slash Ltd', 'Quote "Q" Co'];
const clients = Array.from({ length: CLIENTS }, (_, i) => ({ id: i + 1, name: NAMES[i] || `Client ${String(i + 1).padStart(2, '0')}` }));
const reports = Array.from({ length: REPORTS }, (_, i) => ({ id: 1000 + i, client: clients[i % CLIENTS] }));
const reportById = new Map(reports.map((r) => [r.id, r]));
const artifacts = [];

// Each report's scope, in the shape Plextrac's Scope narrative really has: an
// "In-Scope URLs" table (header row + hosts), a "User Authentication" table of test
// accounts that must never reach the letter, then the out-of-scope section.
const scopeHtml = (r) => '<h5>In-Scope URLs</h5><figure class="table"><table><tbody>'
  + '<tr><td style="background-color:#C2DAFF;"><p>URL</p></td><td><p>Notes</p></td></tr>'
  + `<tr><td>https://app-${r.id}.example</td><td>SCOPE-${r.id} portal</td></tr>`
  + '<tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table></figure>'
  + '<h5>User Authentication</h5><figure class="table"><table><tbody>'
  + `<tr><td>Credentials</td><td>Role</td></tr><tr><td>tester-${r.id}@client.example</td><td>Admin</td></tr>`
  + '</tbody></table></figure>'
  + '<p>The following activities were out of scope for this engagement:</p><ul><li>DoS</li></ul>';

// Each report's own mix of severities: 1-5 findings, rotating through the scale.
const SEVS = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
const findingsOf = (id) => Array.from({ length: 1 + (id % 5) }, (_, i) => SEVS[(id + i * 2) % 5]);
// What the letter must say for that mix: "3 issues, which consists of 1 High and 2 Low".
function expectedCounts(id) {
  const f = findingsOf(id);
  const parts = SEVS.map((s) => [f.filter((x) => x === s).length, s]).filter(([n]) => n).map(([n, s]) => `${n} ${s}`);
  const breakdown = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${f.length} issue${f.length === 1 ? '' : 's'}, which consists of ${breakdown}`;
}
// Jinja2's |e.
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&#34;').replace(/'/g, '&#39;');

api.getClient = async (clientId) => { await jitter(20); return { id: clientId, name: clients[clientId - 1].name }; };
api.getReport = async (clientId, reportId) => {
  await jitter(20);
  const r = reportById.get(reportId);
  return {
    id: r.id, client_id: r.client.id, name: `Report REPORT-${r.id}`,
    start_date: '2026-09-01', end_date: '2026-09-05', tags: [],
    custom_field: [{ label: 'Author 1', value: `Author of REPORT-${r.id}` }],
    exec_summary: {
      custom_fields: ['Overview', 'Scope', 'Limitation', 'Disclaimer', 'Confidentiality Notice', 'Executive Summary']
        .map((label) => ({
          label,
          text: label === 'Executive Summary' ? `<p>EXEC-${r.id}</p>`
            : label === 'Scope' ? scopeHtml(r)
              : `<p>${label} of REPORT-${r.id} for CLIENT-${r.client.id}</p>`,
        })),
    },
  };
};
// In the list endpoint's real shape: { id, doc_id, data: [flaw_id, severity, title, status, ...] }.
api.listReportFindings = async (clientId, reportId) => {
  await jitter(20);
  return findingsOf(reportId).map((sev, i) => ({ id: `f${i}`, doc_id: [reportId, i], data: [i, sev, `Finding ${i}`, 'Open'] }));
};
// The single-finding endpoint: the write-up the full report prints, marked with its
// report, and a screenshot stored in Plextrac's upload store.
api.getFinding = async (clientId, reportId, flawId) => {
  await jitter(20);
  const sev = findingsOf(reportId)[flawId];
  return {
    flaw_id: flawId, report_id: reportId, client_id: clientId, title: `Finding ${flawId}`, severity: sev,
    description: `<p>FINDING-${reportId} number ${flawId}</p>`,
    recommendations: '<p>Fix it.</p>',
    fields: { proof_of_concept: { key: 'proof_of_concept', label: 'Technical Details',
      value: `<figure class="image"><img src="/api/v2/uploads/shot-${reportId}-${flawId}.png" /></figure>` } },
    risk_score: sev === 'Critical' ? { CVSS3_1: { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', overall: 9.8 } } : {},
    affected_assets: { [`a${reportId}`]: { asset: `app-${reportId}.example`, ports: {} } },
  };
};
// Plextrac's upload store: a PNG whose bytes name the file, so each inlined screenshot
// can be traced back to the upload it came from.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
api.rawBinary = async (method, path) => {
  await jitter(20);
  return { buffer: Buffer.concat([PNG_SIGNATURE, Buffer.from(`UPLOAD ${path}`)]), contentType: 'image/png' };
};
api.uploadReportArtifact = async (clientId, reportId, file) => {
  await jitter(20);
  const id = `A${artifacts.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  artifacts.push({ id, clientId, reportId, filename: file.filename, content: file.buffer });
  return id;
};
api.listReportArtifacts = async (clientId, reportId) => {
  await jitter(20);
  return artifacts.filter((a) => a.clientId === clientId && a.reportId === reportId).map((a) => ({ id: a.id }));
};

const slackReplies = [];
slack.postReply = async (channel, ts, text) => { slackReplies.push({ ts, text }); };
slack.postMessage = async (channel, text) => { slackReplies.push({ ts: null, text }); };

// ── Checks ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(description, fn) {
  try {
    fn();
    console.log(`  ✓  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${description}\n       ${err.message.split('\n').slice(0, 6).join('\n       ')}`);
    failed++;
  }
}

// The report ids a document's text refers to, by marker.
const idsIn = (text, marker) => [...new Set((text.match(new RegExp(`${marker}-(\\d+)`, 'g')) || [])
  .map((m) => Number(m.split('-')[1])))];

(async () => {
  const runs = [
    ...reports,
    ...reports.slice(0, DUPLICATE_DELIVERIES), // webhooks delivered twice
  ];
  console.log(`release stress — ${runs.length} runs (${REPORTS} reports, ${DUPLICATE_DELIVERIES} delivered twice) across ${CLIENTS} clients, all at once:`);

  const started = Date.now();
  await Promise.all(runs.map((r) => runReleaseExports({
    clientId: r.client.id, reportId: r.id, clientName: r.client.name,
    reportName: `Report REPORT-${r.id}`, channel: 'C1', threadTs: `ts-${r.id}`,
  })));
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s, ${procs.total} renderer processes)\n`);

  const folders = drive.items.filter((i) => i.mimeType === FOLDER);
  const files = drive.items.filter((i) => i.mimeType !== FOLDER);
  const byId = new Map(drive.items.map((i) => [i.id, i]));
  const runsPer = (id) => runs.filter((r) => r.id === id).length;

  check('no problems reported to Slack', () => assert.deepStrictEqual(slackReplies, []));

  check('one month folder, one folder per client — no duplicates anywhere', () => {
    const months = folders.filter((f) => f.parent === 'ROOT');
    assert.strictEqual(months.length, 1, `month folders: ${months.map((m) => m.name)}`);
    const clientFolders = folders.filter((f) => f.parent === months[0].id);
    assert.strictEqual(clientFolders.length, CLIENTS, `client folders: ${clientFolders.length}`);
    assert.strictEqual(new Set(clientFolders.map((f) => f.name)).size, CLIENTS);
    assert.deepStrictEqual(new Set(clientFolders.map((f) => f.name)),
      new Set(clients.map((c) => safeFilename(c.name, 'Unknown client'))));
  });

  check('nothing was ever overwritten', () => assert.strictEqual(drive.updates, 0));

  check('no two files share a name within a folder', () => {
    const seen = new Set();
    for (const f of files) {
      const key = `${f.parent}/${f.name}`;
      assert.ok(!seen.has(key), `duplicate: ${byId.get(f.parent).name}/${f.name}`);
      seen.add(key);
    }
  });

  check(`every run filed exactly 3 files in Drive (${runs.length * 3} expected)`, () => {
    assert.strictEqual(files.length, runs.length * 3);
  });

  // Each file, read back: which report's data is in it?
  const whose = (f) => {
    const text = f.content.toString('utf8');
    // The letter doesn't print the report's name; its hosts carry the SCOPE marker.
    const ids = idsIn(text, f.name.startsWith('Letter') ? 'SCOPE' : 'REPORT');
    assert.strictEqual(ids.length, 1, `${f.name} holds data from reports ${ids}`);
    return ids[0];
  };

  check('every file holds ONE report\'s data, and sits in THAT report\'s client folder', () => {
    for (const f of files) {
      const r = reportById.get(whose(f));
      const folder = byId.get(f.parent);
      assert.strictEqual(folder.name, safeFilename(r.client.name, 'Unknown client'),
        `${f.name} of report ${r.id} (client ${r.client.name}) is in "${folder.name}"`);
      assert.strictEqual(byId.get(folder.parent).parent, 'ROOT');
    }
  });

  check('each run\'s three files share one timestamp — full report, exec summary, letter', () => {
    const sets = new Map();
    for (const f of files) {
      const stamp = f.name.match(/(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})\.pdf$/)[1];
      const key = `${whose(f)}|${stamp}`;
      sets.set(key, [...(sets.get(key) || []), f.name.replace(/ \d{4}.*$/, '')]);
    }
    for (const [key, kinds] of sets) {
      assert.deepStrictEqual(kinds.sort(), ['Executive Summary Report', 'Full-Pentest-Report-Tech-Details', 'Letter of Attestation'],
        `report|stamp ${key} has ${kinds}`);
    }
    for (const r of reports) {
      const n = [...sets.keys()].filter((k) => k.startsWith(`${r.id}|`)).length;
      assert.strictEqual(n, runsPer(r.id), `report ${r.id}: ${n} sets for ${runsPer(r.id)} runs`);
    }
  });

  check('the full report holds THAT report\'s findings, most severe first, with THEIR screenshots', () => {
    for (const f of files.filter((x) => x.name.startsWith('Full-Pentest-Report-Tech-Details'))) {
      const id = whose(f);
      const html = f.content.toString('utf8');
      const expected = findingsOf(id);
      assert.strictEqual((html.match(/<section class="finding">/g) || []).length, expected.length, `${f.name}: findings`);
      assert.deepStrictEqual(idsIn(html, 'FINDING'), [id], `${f.name} holds findings of ${idsIn(html, 'FINDING')}`);
      const order = [...html.matchAll(/<td class="finding-sev">([^<]*)</g)].map((m) => m[1]);
      const rank = (s) => SEVS.findIndex((x) => x.replace('rmational', '') === s);
      assert.deepStrictEqual(order, [...order].sort((a, b) => rank(a) - rank(b)), `${f.name}: order ${order}`);
      // Every screenshot printed is this report's own upload.
      const shots = [...html.matchAll(/src="data:image\/png;base64,([^"]+)"/g)]
        .map((m) => Buffer.from(m[1], 'base64').subarray(8).toString('utf8'))
        .filter((s) => s.startsWith('UPLOAD '));
      assert.deepStrictEqual(shots.sort(), expected.map((_, i) => `UPLOAD /api/v2/uploads/shot-${id}-${i}.png`).sort());
      assert.ok(html.includes(`<li>app-${id}.example</li>`), `${f.name}: affected asset`);
      assert.strictEqual((html.match(/<h3>CVSS Score<\/h3>/g) || []).length, expected.filter((s) => s === 'Critical').length);
    }
  });

  check('the executive summary is THAT report\'s own summary, in full', () => {
    for (const f of files.filter((x) => x.name.startsWith('Executive Summary Report'))) {
      const id = whose(f);
      const html = f.content.toString('utf8');
      assert.ok(html.includes(`<p>EXEC-${id}</p>`), `${f.name} lacks the executive summary of ${id}`);
      assert.deepStrictEqual(idsIn(html, 'EXEC'), [id]);
      assert.deepStrictEqual(idsIn(html, 'CLIENT'), [reportById.get(id).client.id]);
      assert.ok(html.includes(`Author of REPORT-${id}`));
    }
  });

  check('the letter of attestation is for THAT report and client', () => {
    for (const f of files.filter((x) => x.name.startsWith('Letter of Attestation'))) {
      const id = whose(f);
      const html = f.content.toString('utf8');
      const r = reportById.get(id);
      assert.ok(html.includes(`https://app-${id}.example`), `${f.name} lacks its host`);
      assert.deepStrictEqual(idsIn(html, 'SCOPE'), [id]);
      assert.ok(!html.includes('tester-'), `${f.name} lists test accounts`);
      assert.ok(html.includes(`engaged by ${escapeHtml(r.client.name)} during`), `${f.name}: wrong client`);
      assert.ok(html.includes(`identified a total of ${expectedCounts(id)}.`), `${f.name}: counts`);
    }
  });

  check('Plextrac artifacts: 3 per run, each on the right report, holding that report\'s data', () => {
    assert.strictEqual(artifacts.length, runs.length * 3);
    for (const a of artifacts) {
      const r = reportById.get(a.reportId);
      assert.strictEqual(a.clientId, r.client.id);
      const ids = whose({ name: a.filename, content: a.content });
      assert.strictEqual(ids, a.reportId, `artifact ${a.filename} on ${a.reportId} holds report ${ids}`);
    }
    for (const r of reports) {
      assert.strictEqual(artifacts.filter((a) => a.reportId === r.id).length, runsPer(r.id) * 3);
    }
  });

  check(`at most ${RENDER_LIMIT} renderer processes at once (one per document: ${runs.length * 3})`, () => {
    assert.ok(procs.max <= RENDER_LIMIT, `peak ${procs.max}`);
    assert.strictEqual(procs.total, runs.length * 3);
  });

  fs.rmSync(templateDir, { recursive: true, force: true });
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
