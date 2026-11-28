/**
 * POSIX shell quoting for printed remedies (a refusal's `fix`, a next step):
 * {@link shellQuote} leaves a safe word bare, {@link shellQuoteAlways} always quotes.
 *
 * Dependency-free; safe to import from any layer. Import it from this module:
 * the `lib/index.ts` barrel does not re-export it.
 *
 * @task T14668
 * @task T14672
 */

/**
 * POSIX single-quote a shell word (bare when it is already safe).
 *
 * A path under `Application Support` or a slug carrying a `$` would split or
 * expand when pasted unquoted; the quoted word reads back exactly.
 *
 * @param word - Word to quote.
 * @returns A string the shell reads back as exactly `word`.
 * @example
 * ```ts
 * shellQuote('my-slug');                    // my-slug
 * shellQuote('/Users/me/Application Support/a.md'); // '/Users/me/Application Support/a.md'
 * ```
 */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : shellQuoteAlways(word);
}

/**
 * POSIX single-quote a shell word, always: wrap it in `'...'` and rewrite each
 * embedded `'` as `'\''`. One literal word for any input, even a safe one.
 *
 * @param word - Word to quote.
 * @returns The single-quoted shell word.
 * @example
 * ```ts
 * shellQuoteAlways('my-slug'); // 'my-slug'
 * shellQuoteAlways("o'brien"); // 'o'\''brien'
 * ```
 */
export function shellQuoteAlways(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
