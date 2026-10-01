/**
 * FTS5 pre-tokenisation for the public lexical index.
 *
 * Known trap (dispatch package §四.2 / SPEC §11): SQLite's `unicode61` tokenizer does not split
 * Han text, so writing "战神之龙王归来" alone makes the query "战" miss. Every CJK run is therefore
 * stored as single characters, adjacent bigrams and the whole run, which is what makes single- and
 * double-character recall work without any tokenizer extension.
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function isCjkChar(char: string): boolean {
  return CJK_RUN.test(char);
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function gramsOfRun(run: string): string[] {
  const grams: string[] = [];
  for (const char of run) grams.push(char);
  const characters = [...run];
  for (let index = 0; index + 1 < characters.length; index += 1) grams.push(characters[index] + characters[index + 1]);
  if (characters.length > 1) grams.push(run);
  return grams;
}

/** Splits text into CJK runs and latin/digit words, then expands each CJK run into its grams. */
export function indexTokens(value: string): string[] {
  const source = normalized(value);
  if (source === '') return [];
  const tokens: string[] = [];
  let cjkRun = '';
  let latinRun = '';

  const flushCjk = (): void => {
    if (cjkRun !== '') {
      tokens.push(...gramsOfRun(cjkRun));
      cjkRun = '';
    }
  };
  const flushLatin = (): void => {
    if (latinRun !== '') {
      tokens.push(latinRun);
      latinRun = '';
    }
  };

  for (const char of source) {
    if (isCjkChar(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }
    flushCjk();
    if (char === ' ') {
      flushLatin();
      continue;
    }
    latinRun += char;
  }
  flushCjk();
  flushLatin();

  return [...new Set(tokens)];
}

/** Space-joined form for `public_search_fts` columns, matching the SPEC §11 worked example. */
export function indexTokenColumn(value: string): string {
  return indexTokens(value).join(' ');
}

function quote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * A MATCH expression is an OR over the query's own grams, with double-quoted literals so no user
 * character can escape into FTS5 syntax. Returns null when nothing is searchable.
 */
export function matchExpression(query: string, options?: { prefixLatin?: boolean }): string | null {
  const terms = indexTokens(query);
  if (terms.length === 0) return null;
  const wantsPrefix = options?.prefixLatin === true;
  const clauses = terms.map((term) => {
    const literal = quote(term);
    if (wantsPrefix && !isCjkChar(term[0] as string) && term.length >= 2) return `${literal}*`;
    return literal;
  });
  return clauses.join(' OR ');
}

/** Leading grams of a query, used for completion (`/api/search/suggestions`). */
export function completionGrams(query: string): string[] {
  return indexTokens(query);
}
