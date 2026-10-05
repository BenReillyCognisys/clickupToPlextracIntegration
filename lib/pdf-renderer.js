// Renders the client-facing Jinja2 templates (jinja2-export-templates/) through the
// Python renderer (renderer/render.py): real Jinja2 + WeasyPrint, the same engines the
// templates are written and tested against.
//
// Each renderTemplates call is a fresh Python process, so two documents can never share
// state, temp files or output. Documents travel over stdin/stdout only. The client
// documents render one per call (pipeline/client-documents): WeasyPrint is
// single-threaded, so a release's documents in one process would render one after
// another on one core, the small ones stuck behind the full report. Starting Python and
// WeasyPrint costs about a second; a full report takes far longer than that to lay out.
//
// At most PDF_RENDER_CONCURRENCY renderer processes run at once; further documents wait
// their turn. WeasyPrint takes 100MB+ per process, so 100 reports released together
// must not mean 300 renderers — that would exhaust the server's memory.
//
// Configuration (see .env.example → "Client documents"):
//   PDF_RENDERER_PYTHON     interpreter to use (default: renderer/.venv, then python3)
//   PDF_RENDER_TIMEOUT_MS   kill a renderer after this long (default 300000 - the full
//                           report, screenshots and all; the clock starts when it
//                           starts, not while it waits for a turn)
//   PDF_RENDER_CONCURRENCY  renderer processes at once (default 4; one release uses up
//                           to 3). Up to the server's cores, memory allowing.

const childProcess = require('child_process');
const { spawn } = childProcess;
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { limiter } = require('./concurrency');

const ROOT = path.join(__dirname, '..');
const RENDER_SCRIPT = path.join(ROOT, 'renderer', 'render.py');
// Overridable so tests can render against a folder of their own templates.
const TEMPLATE_DIR = process.env.CLIENT_DOCS_TEMPLATE_DIR || path.join(ROOT, 'jinja2-export-templates');
const TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 300000);
const renderSlots = limiter(process.env.PDF_RENDER_CONCURRENCY || 4);

// The venv created by `npm run setup:renderer` wins over whatever python is on PATH, so
// the pinned Jinja2/WeasyPrint are the ones that run.
function pythonPath() {
  if (process.env.PDF_RENDERER_PYTHON) return process.env.PDF_RENDERER_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(ROOT, 'renderer', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'renderer', '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Template names come from config/client-documents.js; this also rejects anything that
// isn't a plain filename inside the templates folder.
function templateExists(name) {
  if (!name || path.basename(name) !== name) return false;
  return fs.existsSync(path.join(TEMPLATE_DIR, name));
}

/**
 * Renders templates in one renderer process.
 *
 * @param {Array<{id: string, template: string, context: object, output?: 'pdf'|'html',
 *   pdf_options?: object}>} jobs  pdf_options: WeasyPrint options for that document
 * @returns {Promise<Map<string, {ok: boolean, buffer?: Buffer, warnings?: string[], error?: string}>>}
 *   keyed by job id. A failed document is { ok: false, error } — it does not fail the
 *   others. The promise itself rejects only when the renderer could not run at all.
 */
function renderTemplates(jobs) {
  return renderSlots(() => runRenderer(jobs));
}

function runRenderer(jobs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [RENDER_SCRIPT, '--templates', TEMPLATE_DIR], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`PDF renderer timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => finish(reject, new Error(
      `PDF renderer could not start (${pythonPath()}): ${err.message} — see docs/client-documents.md`,
    )));
    // An early exit closes stdin under us; the exit handler reports the real reason.
    child.stdin.on('error', () => {});

    child.on('close', (code) => {
      const errText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        finish(reject, new Error(`PDF renderer exited with code ${code}: ${errText.slice(-1500)}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch {
        const out = Buffer.concat(stdout).toString('utf8').trim();
        finish(reject, new Error(`PDF renderer returned unreadable output: ${(errText || out).slice(-500)}`));
        return;
      }
      if (errText) log.warn('PDF renderer stderr', { stderr: errText.slice(-2000) });

      const results = new Map();
      for (const r of parsed.results || []) {
        results.set(r.id, r.ok
          ? { ok: true, buffer: Buffer.from(r.content_base64, 'base64'), warnings: r.warnings || [] }
          : { ok: false, error: r.error });
      }
      finish(resolve, results);
    });

    child.stdin.end(JSON.stringify({ jobs }));
  });
}

/**
 * Whether the renderer can produce PDFs on this machine: runs `render.py --check`
 * with the interpreter renders would use. Resolves (never rejects) to
 * { ok, python, jinja2, weasyprint, error } — logged at startup so a missing
 * `npm run setup:renderer` shows up in the console before the first release does.
 */
function checkRenderer() {
  const python = pythonPath();
  return new Promise((resolve) => {
    childProcess.execFile(python, [RENDER_SCRIPT, '--check'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      try {
        resolve({ python, ...JSON.parse(stdout) });
      } catch {
        resolve({
          ok: false, python,
          error: `${python} could not run the renderer (${(err?.message || String(stderr)).trim().split('\n').pop()}) — `
            + 'run `npm run setup:renderer` on this server',
        });
      }
    });
  });
}

module.exports = { renderTemplates, checkRenderer, templateExists, pythonPath, TEMPLATE_DIR };
