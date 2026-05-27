/**
 * slug — filename → kebab-case slug with collision resolution.
 *
 * Pure functions used by `cleo docs import` (T9639). Slug normalization
 * is delegated to {@link ../slug-normalize.ts | `../slug-normalize.js`},
 * the canonical single source of truth established by T11180.
 * Collision resolution appends `-2`, `-3`, ... until
 * the slug is unique within a caller-supplied set.
 *
 * Reserved slugs are rejected outright — these names collide with
 * existing `cleo docs <subcommand>` verbs and would be ambiguous in any
 * future "lookup by slug" interface.
 *
 * @epic T9628 (Saga T9625)
 * @task T9712 (ST-MIG-1b)
 */

import { normalizeSlug } from '../slug-normalize.js';

/**
 * Slugs that conflict with `cleo docs <subcommand>` verbs and any other
 * single-token names reserved for the docs surface.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'index',
  'list',
  'fetch',
  'add',
  'remove',
  'import',
  'publish',
  'sync',
  'status',
  // Defence-in-depth — other current `cleo docs` verbs.
  'generate',
  'export',
  'search',
  'merge',
  'graph',
  'rank',
  'versions',
  'gap-check',
]);

/** Result of {@link generateSlug}. */
export interface SlugResult {
  /** The final, collision-resolved slug. */
  readonly slug: string;
  /** True when the base slug already existed and a suffix was appended. */
  readonly collision: boolean;
  /** The numeric suffix used (2, 3, ...) when `collision` is true. */
  readonly suffix?: number;
}

/**
 * Convert a free-form string into a normalised kebab-case slug.
 *
 * Delegates to {@link ../slug-normalize.normalizeSlug | normalizeSlug}
 * (T11180 SSoT). The function name `slugify` is retained for backward
 * compatibility so existing callers do not break.
 *
 * @param input - The source string (typically a filename without extension).
 * @returns The slugified form.
 */
export function slugify(input: string): string {
  return normalizeSlug(input);
}

/**
 * Strip the `.md` extension from a filename if present. Used to compute
 * the base slug from a file's basename.
 *
 * @param filename - The file basename (e.g. `My Doc.md`).
 * @returns The basename without its `.md` extension.
 */
export function stripMdExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

/** Options for {@link generateSlug}. */
export interface GenerateSlugOptions {
  /** The raw source string to slugify (typically a filename basename). */
  readonly source: string;
  /** Slugs that already exist in the target scope (per-project per T9627). */
  readonly existing: ReadonlySet<string>;
  /**
   * Maximum suffix to try before giving up. Default: 9999. The cap
   * defends against pathological collision chains.
   */
  readonly maxSuffix?: number;
}

/** Thrown when a slug cannot be generated within the suffix budget. */
export class SlugCollisionLimitError extends Error {
  constructor(
    public readonly base: string,
    public readonly limit: number,
  ) {
    super(`slug "${base}" collided ${limit} times — refusing to keep counting`);
    this.name = 'SlugCollisionLimitError';
  }
}

/** Thrown when the input slugifies to a reserved or empty value. */
export class SlugReservedError extends Error {
  constructor(
    public readonly base: string,
    public readonly reason: 'reserved' | 'empty',
  ) {
    super(
      reason === 'reserved'
        ? `slug "${base}" is reserved`
        : `slug for input is empty after normalisation`,
    );
    this.name = 'SlugReservedError';
  }
}

/**
 * Generate a unique slug from `source`, suffixing `-2`, `-3`, ... if
 * the base already exists in `existing`.
 *
 * Rejects empty and {@link RESERVED_SLUGS reserved} slugs with
 * {@link SlugReservedError}; rejects collision chains longer than
 * `maxSuffix` with {@link SlugCollisionLimitError}.
 *
 * @param options - Source + collision set.
 * @returns The unique slug + collision metadata.
 */
export function generateSlug(options: GenerateSlugOptions): SlugResult {
  const base = slugify(options.source);
  if (base.length === 0) {
    throw new SlugReservedError(options.source, 'empty');
  }
  if (RESERVED_SLUGS.has(base)) {
    throw new SlugReservedError(base, 'reserved');
  }

  if (!options.existing.has(base)) {
    return { slug: base, collision: false };
  }

  const limit = options.maxSuffix ?? 9999;
  for (let i = 2; i <= limit; i++) {
    const candidate = `${base}-${i}`;
    if (!options.existing.has(candidate)) {
      return { slug: candidate, collision: true, suffix: i };
    }
  }
  throw new SlugCollisionLimitError(base, limit);
}
