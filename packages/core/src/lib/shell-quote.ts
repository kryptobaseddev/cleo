/**
 * POSIX shell quoting for printed remedies (a refusal's `fix`, a next step).
 *
 * Dependency-free; safe to import from any layer. Import it from this module:
 * the `lib/index.ts` barrel does not re-export it.
 *
 * @task T14668
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
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
