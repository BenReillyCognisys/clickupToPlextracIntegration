"""Renders Jinja2 export templates to PDF (or HTML) for the client-facing documents.

Called by lib/pdf-renderer.js, never directly by a request. One process renders every
document for one release, so Python and WeasyPrint start once per release rather than
once per file.

Protocol - JSON on stdin, JSON on stdout, nothing else on stdout:

    stdin:  {"jobs": [{"id": "exec-summary",
                       "template": "cognisys-exec-summary.j2",
                       "context": {...},            # the template's variables
                       "output": "pdf" | "html"}]}   # html = skip WeasyPrint (previews)

    stdout: {"results": [{"id": "exec-summary", "ok": true,
                          "content_base64": "...", "warnings": ["..."]},
                         {"id": "...", "ok": false, "error": "..."}]}

Each job succeeds or fails on its own: one broken template does not stop the other
documents. Diagnostics go to stderr, which the Node side logs.

Security: the templates pass PlexTrac rich text (and Claude's output) through `|safe`,
so the HTML is only as trustworthy as that content. WeasyPrint is therefore only
allowed `data:` URIs - the fonts and logos in the templates are all inlined - so a
stray <img src="file:///etc/passwd"> or <img src="http://169.254.169.254/..."> in a
narrative can neither read a local file nor make the server fetch a URL. A blocked
resource is dropped from the PDF and reported in `warnings`.

Usage: render.py --templates <dir>
"""

import argparse
import base64
import json
import logging
import sys
import traceback

from jinja2 import Environment, FileSystemLoader

ALLOWED_URL_PROTOCOLS = ("data",)


class _Collector(logging.Handler):
    """Captures WeasyPrint's warnings for the job being rendered."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def build_environment(template_dir):
    # autoescape off, as PlexTrac renders these templates: they escape with |e where
    # a value is plain text and pass rich text through with |safe. Turning it on
    # would double-escape every value the templates already escape.
    return Environment(
        loader=FileSystemLoader(template_dir),
        autoescape=False,
        extensions=["jinja2.ext.do", "jinja2.ext.loopcontrols"],
    )


def render_pdf(html, template_dir):
    # Imported lazily so HTML-only previews work without WeasyPrint's system
    # libraries (Pango) installed.
    from weasyprint import HTML
    from weasyprint.urls import URLFetcher

    fetcher = URLFetcher(allowed_protocols=ALLOWED_URL_PROTOCOLS, timeout=5)
    return HTML(string=html, base_url=template_dir, url_fetcher=fetcher).write_pdf()


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
            content = render_pdf(html, template_dir)
        return {
            "id": job_id,
            "ok": True,
            "content_base64": base64.b64encode(content).decode("ascii"),
            "warnings": collector.messages,
        }
    except Exception as exc:  # one bad document must not sink the rest
        traceback.print_exc(file=sys.stderr)
        return {"id": job_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        wp_logger.removeHandler(collector)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--templates", required=True, help="directory holding the .j2 templates")
    args = parser.parse_args()

    # WeasyPrint's own logger is left at WARNING so the collector sees what matters
    # (blocked URLs, unsupported CSS) without the INFO chatter.
    logging.getLogger("weasyprint").setLevel(logging.WARNING)

    payload = json.load(sys.stdin)
    env = build_environment(args.templates)
    results = [run_job(env, args.templates, job) for job in payload.get("jobs", [])]

    sys.stdout.write(json.dumps({"results": results}))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
