// Renders the client-facing Jinja2 templates (jinja2-export-templates/) through the
// Python renderer (renderer/render.py): real Jinja2 + WeasyPrint, the same engines the
// templates are written and tested against.
//
// One Python process renders every document of a release in one go — Python and
// WeasyPrint start once, not once per file — and it is a fresh process per release,
// so two releases can never share state, temp files or output. Documents travel over
// stdin/stdout only.
//
// Configuration (see .env.example → "Client documents"):
//   PDF_RENDERER_PYTHON     interpreter to use (default: renderer/.venv, then python3)
//   PDF_RENDER_TIMEOUT_MS   kill the renderer after this long (default 120000)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const ROOT = path.join(__dirname, '..');
const RENDER_SCRIPT = path.join(ROOT, 'renderer', 'render.py');
const TEMPLATE_DIR = path.join(ROOT, 'jinja2-export-templates');
const TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 120000);

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
 * Renders templates in a single renderer run.
 *
 * @param {Array<{id: string, template: string, context: object, output?: 'pdf'|'html'}>} jobs
 * @returns {Promise<Map<string, {ok: boolean, buffer?: Buffer, warnings?: string[], error?: string}>>}
 *   keyed by job id. A failed document is { ok: false, error } — it does not fail the
 *   others. The promise itself rejects only when the renderer could not run at all.
 */
function renderTemplates(jobs) {
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
        finish(reject, new Error(`PDF renderer returned unreadable output: ${errText.slice(-500)}`));
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

module.exports = { renderTemplates, templateExists, pythonPath, TEMPLATE_DIR };
