/**
 * Canonical slug normalization — SINGLE SOURCE OF TRUTH for document slug
 * normalization in the CLEO docs system.
 *
 * ## Why this module exists (T11180)
 *
 * Before T11180, slug normalization was duplicated across three locations:
 *
 *   1. `docs/slug-allocator.ts` → `normalizeSlug()`
 *   2. `docs/import/slug.ts`   → `slugify()`
 *   3. `orchestration/spawn-prompt.ts` → `slugify()` (different algorithm)
 *
 * #1 and #2 were identical but separate implementations, with
 * `slug-allocator.ts` explicitly acknowledging the duplication in its
 * module-level docs: "Inlined here to avoid a circular import (the import
 * module already depends on attachment-store via the accessor)."
 *
 * This module extracts the canonical algorithm into one location so:
 *   - All document-slug consumers use the same normalization.
 *   - Changes to the normalization algorithm happen in exactly one place.
 *   - The `import/slug.ts` module can import this without circular
 *     dependency concerns (it's a leaf module with no deps on
 *     attachment-store or the rest of the docs subsystem).
 *
 * ## Algorithm (unchanged from the pre-T11180 implementation)
 *
 *   1. Unicode NFKD normalization + strip combining diacritics.
 *   2. Lowercase.
 *   3. Replace any non-`[a-z0-9]` run with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * ## Consumer migration
 *
 *   | Pre-T11180 location          | Post-T11180                              |
 *   |------------------------------|------------------------------------------|
 *   | `slug-allocator.normalizeSlug` | `slug-normalize.normalizeSlug`         |
 *   | `import/slug.slugify`          | `slug-normalize.normalizeSlug`         |
 *   | `spawn-prompt.slugify`         | `slug-normalize.normalizeSlug` + trunc  |
 *
 * @task T11180 (T10516-B)
 * @epic T10518
 * @saga T10516
 */

/**
 * Normalize a free-form string to canonical kebab-case slug form.
 *
 * Steps:
 *   1. Unicode NFKD normalize + strip combining diacritics.
 *   2. Lowercase.
 *   3. Replace any non-`[a-z0-9]` run with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * @param input - Raw slug source string.
 * @returns Canonical kebab-case form. May be empty if input had no
 *          alphanumeric characters.
 *
 * @example
 * ```ts
 * normalizeSlug('My Cool Doc')      // → 'my-cool-doc'
 * normalizeSlug('Café Résumé')      // → 'cafe-resume'
 * normalizeSlug('  --Foo--  ')      // → 'foo'
 * normalizeSlug('!!!')              // → ''
 * ```
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
