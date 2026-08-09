// Pure helpers for the "signed authorisation form" block that the finalised-auth-form
// endpoint prepends to a ClickUp task description. The block is a single marker line
// plus a horizontal-rule separator, with the task's original description kept below.
//
// Prepending is idempotent: any existing block (identified by the MARKER_TEXT
// substring, which survives ClickUp's markdown round-tripping) is stripped first, so
// a re-send from the SFE replaces the link in place rather than stacking a new one.

const MARKER_TEXT = 'Signed authorisation form';

// Removes a previously-inserted auth-form block — the marker line plus the blank
// lines and single '---' separator we added after it — from a description. Safe to
// call on descriptions that never had one (returns the trimmed input).
function stripFinalisedAuthForm(text) {
  const source = String(text || '');
  const lines = source.split('\n');
  const idx = lines.findIndex((l) => l.includes(MARKER_TEXT));
  if (idx === -1) return source.trim();

  lines.splice(idx, 1);
  // Drop blank lines and the single separator that followed our marker line.
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (lines.length && lines[0].trim() === '---') {
    lines.shift();
    while (lines.length && lines[0].trim() === '') lines.shift();
  }
  return lines.join('\n').trim();
}

// Prepends the signed-auth-form Drive link to a description, keeping the original
// text below a separator. Idempotent (replaces any existing block).
function prependFinalisedAuthForm(existing, driveUrl, clientName) {
  const label = clientName
    ? `${MARKER_TEXT} (${clientName})`
    : MARKER_TEXT;
  const marker = `📎 **${label}:** [Open in Google Drive](${driveUrl})`;
  const body = stripFinalisedAuthForm(existing);
  return body ? `${marker}\n\n---\n\n${body}` : marker;
}

module.exports = { prependFinalisedAuthForm, stripFinalisedAuthForm, MARKER_TEXT };
