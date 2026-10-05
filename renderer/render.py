"""Renders Jinja2 export templates to PDF (or HTML) for the client-facing documents.

Called by lib/pdf-renderer.js, never directly by a request. One process renders every
document for one release, so Python and WeasyPrint start once per release rather than
once per file.

Protocol - JSON on stdin, JSON on stdout, nothing else on stdout:

    stdin:  {"jobs": [{"id": "exec-summary",
                       "template": "cognisys-exec-summary.j2",
                       "context": {...},            # the template's variables
                       "output": "pdf" | "html",     # html = skip WeasyPrint (previews)
                       "pdf_options": {"dpi": 150}}]}  # optional, see PDF_OPTIONS

    stdout: {"results": [{"id": "exec-summary", "ok": true,
                          "content_base64": "...", "warnings": ["..."]},
                         {"id": "...", "ok": false, "error": "..."}]}

Each job succeeds or fails on its own: one broken template does not stop the other
documents. Diagnostics go to stderr, which the Node side logs.

Security: the templates pass PlexTrac rich text through `|safe`, so the HTML is only
as trustworthy as that content. WeasyPrint is therefore only
allowed `data:` URIs - the fonts and logos in the templates are all inlined - so a
stray <img src="file:///etc/passwd"> or <img src="http://169.254.169.254/..."> in a
narrative can neither read a local file nor make the server fetch a URL. A blocked
resource is dropped from the PDF and reported in `warnings`.

An incomplete installation (Jinja2 or WeasyPrint missing, or Pango not installed) is
reported as a one-line error per document naming the interpreter and the fix.

Usage: render.py --templates <dir>
       render.py --check        prints {"ok", "python", "jinja2", "weasyprint", "error"}
                                as JSON - what the service logs at startup
"""

import argparse
import base64
import json
import logging
import sys
import traceback

ALLOWED_URL_PROTOCOLS = ("data",)

# The WeasyPrint write_pdf options a job may set, and the type each must be. Anything
# else in a job's pdf_options is ignored, so a job can't switch on, say, attachments.
#   dpi              downsample images to at most this resolution (screenshots)
#   optimize_images  recompress images losslessly
#   jpeg_quality     re-encode JPEGs at this quality (0-95)
PDF_OPTIONS = {"dpi": int, "optimize_images": bool, "jpeg_quality": int}


def pdf_options(requested):
    options = {}
    for key, kind in PDF_OPTIONS.items():
        value = (requested or {}).get(key)
        if isinstance(value, kind) and not (kind is int and isinstance(value, bool)):
            options[key] = value
    return options


class _Collector(logging.Handler):
    """Captures WeasyPrint's warnings for the job being rendered."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def build_environment(template_dir):
    try:
        from jinja2 import Environment, FileSystemLoader
    except ImportError as exc:
        raise SetupError(f"Jinja2 is not installed for {sys.executable} ({exc}) - {SETUP_HINT}") from None
    # autoescape off, as PlexTrac renders these templates: they escape with |e where
    # a value is plain text and pass rich text through with |safe. Turning it on
    # would double-escape every value the templates already escape.
    return Environment(
        loader=FileSystemLoader(template_dir),
        autoescape=False,
        extensions=["jinja2.ext.do", "jinja2.ext.loopcontrols"],
    )


SETUP_HINT = "run `npm run setup:renderer` on this server (see docs/client-documents.md)"


class SetupError(Exception):
    """The renderer's installation is incomplete. Every document would fail the same
    way, so this is reported as one clear line rather than a traceback per document."""


def load_weasyprint():
    # Imported lazily so HTML-only previews work without WeasyPrint's system
    # libraries (Pango) installed.
    try:
        from weasyprint import HTML
        from weasyprint.urls import URLFetcher
    except ImportError as exc:
        raise SetupError(f"WeasyPrint is not installed for {sys.executable} ({exc}) - {SETUP_HINT}") from None
    except OSError as exc:
        # WeasyPrint is installed but Pango isn't: cffi can't load the library.
        raise SetupError(
            f"WeasyPrint cannot load its system libraries ({exc}) - "
            "sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0"
        ) from None
    return HTML, URLFetcher


def render_pdf(html, template_dir, options=None):
    HTML, URLFetcher = load_weasyprint()
    fetcher = URLFetcher(allowed_protocols=ALLOWED_URL_PROTOCOLS, timeout=5)
    return HTML(string=html, base_url=template_dir, url_fetcher=fetcher).write_pdf(**pdf_options(options))


def run_job(env, template_dir, job):
    job_id = job.get("id")
    collector = _Collector()
    wp_logger = logging.getLogger("weasyprint")
    wp_logger.addHandler(collector)
    try:
        template = env.get_template(job["template"])
        html = template.render(**(job.get("context") or {}))
        if job.get("output", "pdf") == "html":
            content = html.encode("utf-8")
        else:
            content = render_pdf(html, template_dir, job.get("pdf_options"))
        return {
            "id": job_id,
            "ok": True,
            "content_base64": base64.b64encode(content).decode("ascii"),
            "warnings": collector.messages,
        }
    except SetupError as exc:
        # Already says what is wrong and how to fix it; a traceback adds nothing.
        return {"id": job_id, "ok": False, "error": str(exc)}
    except Exception as exc:  # one bad document must not sink the rest
        traceback.print_exc(file=sys.stderr)
        return {"id": job_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        wp_logger.removeHandler(collector)


def check():
    """Can this interpreter render PDFs? Imports everything a render needs."""
    report = {"ok": False, "python": sys.executable, "jinja2": None, "weasyprint": None, "error": None}
    try:
        build_environment(".")
        import jinja2
        report["jinja2"] = jinja2.__version__
        load_weasyprint()
        import weasyprint
        report["weasyprint"] = weasyprint.__version__
        report["ok"] = True
    except SetupError as exc:
        report["error"] = str(exc)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--templates", help="directory holding the .j2 templates")
    parser.add_argument("--check", action="store_true", help="report whether this interpreter can render")
    args = parser.parse_args()

    # stdout carries the JSON reply and nothing else. Libraries print to it - WeasyPrint
    # writes a banner there when it can't load Pango - so everything but the reply is
    # sent to stderr, which the service logs.
    reply = sys.stdout
    sys.stdout = sys.stderr

    if args.check:
        reply.write(json.dumps(check()))
        reply.flush()
        return
    if not args.templates:
        parser.error("--templates is required")

    # WeasyPrint's own logger is left at WARNING so the collector sees what matters
    # (blocked URLs, unsupported CSS) without the INFO chatter.
    logging.getLogger("weasyprint").setLevel(logging.WARNING)

    # Bytes, decoded as UTF-8 explicitly: sys.stdin decodes with the OS locale, which
    # is not UTF-8 everywhere (cp1252 on Windows, whatever LANG says on a server) and
    # would garble every accent, curly quote and em dash in the report text.
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    jobs = payload.get("jobs", [])
    try:
        env = build_environment(args.templates)
        results = [run_job(env, args.templates, job) for job in jobs]
    except SetupError as exc:
        results = [{"id": job.get("id"), "ok": False, "error": str(exc)} for job in jobs]

    reply.write(json.dumps({"results": results}))
    reply.flush()


if __name__ == "__main__":
    main()
