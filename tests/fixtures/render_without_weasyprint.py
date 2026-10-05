"""The real renderer (renderer/render.py) with only WeasyPrint's HTML -> PDF step
swapped out: the "PDF" is b"%PDF-" followed by the rendered HTML.

Used by tests/release-stress.test.js, which needs to read each document back to prove
whose data is in it. Everything else - the stdin/stdout protocol, one process per
release, Jinja2 rendering the real template with the real context - is the production
code. WeasyPrint itself is a pure function of the HTML it is given.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "renderer"))

import render  # noqa: E402

render.render_pdf = lambda html, template_dir, options=None: b"%PDF-TEST\n" + html.encode("utf-8")

if __name__ == "__main__":
    render.main()
