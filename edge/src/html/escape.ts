/**
 * The XSS boundary for every edge-rendered HTML surface (`/s`, `/dl`).
 *
 * These documents interpolate values that originate outside this process: D1 titles, provider
 * metadata, `?ref=` and `?ep=` query parameters. SPEC 10 mandates an edge-direct inline page, so no
 * framework escaper is doing this work for us. Every interpolation MUST go through one of the three
 * functions below, chosen by the context it is inserted into:
 *   1. element text content         -> `escapeText`
 *   2. quoted attribute values      -> `escapeAttribute`
 *   3. inside the inline script     -> `embedJson`
 * A value that skips its function is a stored-XSS hole in a page opened by anonymous share links.
 */

/** Text content: `&` is replaced first, otherwise entities inserted here would be escaped again. */
const TEXT_REPLACEMENTS: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;'
};

/** Attribute values additionally need both quote forms, because every attribute here is quoted. */
const ATTRIBUTE_REPLACEMENTS: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function replaceAll(value: string, table: Readonly<Record<string, string>>): string {
  let out = '';
  for (const character of value) {
    const entity = table[character];
    out += entity === undefined ? character : entity;
  }
  return out;
}

export function escapeText(value: string): string {
  return replaceAll(value, TEXT_REPLACEMENTS);
}

export function escapeAttribute(value: string): string {
  return replaceAll(value, ATTRIBUTE_REPLACEMENTS);
}

/**
 * U+2028 / U+2029 are valid inside a JSON document but end a JavaScript string literal in some
 * engines. They are named from their code points instead of written inline, so this source file can
 * never carry an invisible separator byte that a reviewer (or a scanner) would walk straight past.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Safe embedding of a value inside `<script>` element content.
 *
 * `JSON.stringify` alone is not enough: the HTML parser ends a script block at the first `</script`
 * it sees, and the two separators above break the string literal. Emitting `\uXXXX` keeps the parsed
 * value byte-identical while making `</script>` and `<!--` impossible to form.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

/**
 * Query parameters arrive from a link somebody else posted: bound the length and drop control
 * characters before they reach the DOM. Display-only, never a business key.
 */
export function sanitizeDisplayToken(raw: string | null | undefined, maxLength = 80): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (cleaned === '') return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** Tiny element builder: attribute values get escaped, the already-safe inner string passes through. */
export function tag(
  name: string,
  attributes: Readonly<Record<string, string | null | undefined>>,
  inner: string,
  selfClosing = false
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}="${escapeAttribute(value)}"`);
  }
  const head = parts.length === 0 ? name : `${name} ${parts.join(' ')}`;
  return selfClosing ? `<${head} />` : `<${head}>${inner}</${name}>`;
}
