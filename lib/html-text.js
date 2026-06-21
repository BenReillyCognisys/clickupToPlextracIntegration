// Deterministic HTML → plain-text conversion for the "strip formatting" check.
// Plextrac stores narrative fields (executive summary, finding description /
// recommendations) as HTML. This converts that to clean plain text without an
// AI call, so formatting removal is cheap, predictable, and reversible.

const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  // Numeric entities: &#123; and &#x1F;
  out = out.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  return out;
}

// Returns true if the string contains HTML tags or encoded entities — i.e.
// stripping it would actually change something.
function hasFormatting(text) {
  if (typeof text !== 'string') return false;
  return /<[a-z!/][^>]*>/i.test(text) || /&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/i.test(text);
}

function stripFormatting(text) {
  if (typeof text !== 'string' || text === '') return text;

  let out = text;

  // Block-level tags become line breaks so paragraphs/list items stay separated.
  // (Note: the opening <li> owns the list-item break — don't also break on </li>,
  // or consecutive items get a double gap.)
  out = out.replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/tr)\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\s*li[^>]*>/gi, '\n- ');

  // Remove all remaining tags.
  out = out.replace(/<[^>]+>/g, '');

  out = decodeEntities(out);

  // Normalise whitespace: collapse runs of spaces/tabs, trim trailing space on
  // each line, and squeeze 3+ blank lines down to a single blank line.
  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

module.exports = { stripFormatting, hasFormatting, decodeEntities };
