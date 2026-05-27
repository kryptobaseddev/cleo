/**
 * Similarity check for proposed doc slugs at `cleo docs add` write-time.
 *
 * When an agent (or a human) is about to write a new doc with `--slug X`, it
 * is often the case that a previous doc with a near-identical slug already
 * exists — the intent was probably to UPDATE the existing doc rather than
 * fork a near-duplicate. This module detects that case before the write
 * lands and surfaces a "did you mean `cleo docs update <slug>`?" hint.
 *
 * Exact collisions are intentionally NOT covered here — they flow through
 * the slug-collision path that already exists in the AttachmentStore (and
 * will gain a project-wide reservation table in T10392 / E1 of the
 * SG-DOCS-INTEGRITY saga). This module fires ONLY when the proposed slug
 * is FUZZY-CLOSE to an existing slug for the SAME DocKind.
 *
 * Threshold semantics: similarity is a normalised Levenshtein score in
 * `[0, 1]` where `1.0` is an exact match. Anything ≥ `threshold` (default
 * `0.85`) and < `1.0` is reported as a near-duplicate. An exact `1.0`
 * match falls through to the collision path on the caller side.
 *
 * Project-level overrides live in `.cleo/canon.yml` under the optional
 * top-level `similarity:` block:
 *
 * ```yaml
 * similarity:
 *   warnThreshold: 0.85   # 0..1, scores >= this trigger the warn/block
 *   mode: warn            # 'warn' (default) | 'block'
 * ```
 *
 * @epic T10291 — E3-DOCS-CLI-HARDENING
 * @saga T10288 — SG-DOCS-INTEGRITY
 * @task T10361 — T-E3.3 (closes absorbed T10167)
 * @adr ADR-083
 */

import { createAttachmentStore } from '../store/attachment-store.js';

/**
 * Default similarity threshold. Score above this (but below `1.0`) triggers
 * the "did you mean" hint. Calibrated to catch `cant-spec` vs `cantspec`,
 * `release-plan` vs `release-plans`, and one-character typos while NOT
 * flagging structurally distinct slugs that happen to share a prefix.
 *
 * @task T10361
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Default policy when a near-duplicate slug is detected. `warn` prints the
 * hint and continues; `block` exits with `E_SLUG_SIMILARITY` unless the
 * caller passes `--allow-similar`.
 *
 * @task T10361
 */
export const DEFAULT_SIMILARITY_MODE: SimilarityMode = 'warn';

/**
 * Policy mode for similarity hits.
 *
 * - `'warn'`: print the hint, continue with the write.
 * - `'block'`: exit `E_SLUG_SIMILARITY` (code 6) unless `--allow-similar`
 *   is supplied. Non-TTY callers (CI agents) are the common consumers.
 *
 * @task T10361
 */
export type SimilarityMode = 'warn' | 'block';

/**
 * Result envelope returned by {@link checkSlugSimilarity}.
 *
 * @task T10361
 */
export interface SimilarityCheckResult {
  /** Normalised Levenshtein score in `[0, 1]`. `1.0` = exact match. */
  readonly score: number;
  /** Slug that scored closest. `null` when no candidate >= threshold OR exact match. */
  readonly mostSimilarSlug: string | null;
  /** `true` when nothing crossed the threshold (and no exact match). */
  readonly belowThreshold: boolean;
}

/**
 * Parameters accepted by {@link checkSlugSimilarity}.
 *
 * @task T10361
 */
export interface CheckSlugSimilarityOptions {
  /** Proposed slug to be written. */
  readonly slug: string;
  /** DocKind id (`'adr'`, `'spec'`, etc.) — narrows the candidate set. */
  readonly type: string;
  /** Project root directory (used by the attachment store). */
  readonly projectRoot: string;
  /**
   * Threshold in `[0, 1]`. Scores `>= threshold` AND `< 1.0` are reported.
   * Defaults to {@link DEFAULT_SIMILARITY_THRESHOLD} (`0.85`).
   */
  readonly threshold?: number;
  /**
   * Test override — when supplied, bypasses the AttachmentStore query and
   * uses these slugs as the candidate set. Used by unit tests to exercise
   * scoring logic without touching the DB.
   */
  readonly existingSlugs?: ReadonlyArray<string>;
}

/**
 * Calculate the Levenshtein distance between two strings.
 *
 * Distance = minimum number of single-character edits (insert, delete,
 * substitute) needed to change `a` into `b`. Implementation duplicated
 * from `packages/cleo/src/cli/lib/did-you-mean.ts` so the core package
 * does not take a CLI dependency.
 *
 * @internal
 * @task T10361
 */
function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Allocate the 2-D DP matrix lazily.
  const matrix: number[][] = Array.from({ length: aLen + 1 }, (_, i) => [i]);
  for (let j = 1; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // deletion
        matrix[i]![j - 1]! + 1, // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[aLen]![bLen]!;
}

/**
 * Normalise Levenshtein distance to a `[0, 1]` similarity score.
 *
 * Formula: `1 - distance / max(len(a), len(b))`. Identical strings return
 * `1.0`; strings sharing no characters of equal length return `0.0`.
 *
 * @internal
 * @task T10361
 */
function similarityScore(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1; // both empty
  const distance = levenshteinDistance(a, b);
  return 1 - distance / longest;
}

/**
 * Check whether the proposed slug is near-duplicate of any existing slug
 * for the same DocKind in the current project.
 *
 * Returns `mostSimilarSlug = null` when:
 *   - No existing slugs cross the threshold, OR
 *   - The proposed slug exactly matches an existing slug (score = 1.0).
 *     The exact-match case is intentionally ignored here — it is the
 *     responsibility of the slug-collision path (T10392 / E1).
 *
 * @example
 * ```ts
 * const r = await checkSlugSimilarity({
 *   slug: 'cant-spec',
 *   type: 'spec',
 *   projectRoot: '/repo',
 *   existingSlugs: ['cantspec', 'release-plan'],
 * });
 * // r.score === 0.888..., r.mostSimilarSlug === 'cantspec'
 * ```
 *
 * @param opts - {@link CheckSlugSimilarityOptions} bag.
 * @returns {@link SimilarityCheckResult}
 */
export async function checkSlugSimilarity(
  opts: CheckSlugSimilarityOptions,
): Promise<SimilarityCheckResult> {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // Test override or live AttachmentStore query, narrowed to the same kind.
  let existing: ReadonlyArray<string>;
  if (opts.existingSlugs !== undefined) {
    existing = opts.existingSlugs;
  } else {
    const store = createAttachmentStore();
    const rows = await store.listAllInProject(opts.projectRoot, { type: opts.type });
    existing = rows
      .map((r) => r.slug)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  }

  let bestScore = 0;
  let bestSlug: string | null = null;
  for (const candidate of existing) {
    const score = similarityScore(opts.slug, candidate);
    // Exact match goes through the collision path — never reported here.
    if (score >= 1) {
      continue;
    }
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestSlug = candidate;
    }
  }

  if (bestSlug === null) {
    return { score: 0, mostSimilarSlug: null, belowThreshold: true };
  }
  return { score: bestScore, mostSimilarSlug: bestSlug, belowThreshold: false };
}

/**
 * Optional `similarity:` block parsed from `.cleo/canon.yml`.
 *
 * @task T10361
 */
export interface SimilarityConfig {
  /** Score above this triggers the warn/block. Defaults to `0.85`. */
  readonly warnThreshold: number;
  /** `'warn'` (print + continue) or `'block'` (exit unless `--allow-similar`). */
  readonly mode: SimilarityMode;
}

/**
 * Validate a partial similarity config from `canon.yml`. Returns the
 * narrowed shape with defaults applied, or throws on structural defects.
 *
 * @param raw - Value parsed from the `similarity:` YAML node (may be
 *   missing — caller passes `undefined`).
 * @param source - Path label used in error messages.
 * @returns Fully-populated {@link SimilarityConfig}.
 * @task T10361
 */
export function parseSimilarityConfig(raw: unknown, source: string): SimilarityConfig {
  if (raw === undefined || raw === null) {
    return { warnThreshold: DEFAULT_SIMILARITY_THRESHOLD, mode: DEFAULT_SIMILARITY_MODE };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: 'similarity' must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  let warnThreshold = DEFAULT_SIMILARITY_THRESHOLD;
  if (obj['warnThreshold'] !== undefined) {
    const t = obj['warnThreshold'];
    if (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t > 1) {
      throw new Error(
        `${source}: 'similarity.warnThreshold' must be a number in [0, 1] (got ${String(t)})`,
      );
    }
    warnThreshold = t;
  }

  let mode: SimilarityMode = DEFAULT_SIMILARITY_MODE;
  if (obj['mode'] !== undefined) {
    const m = obj['mode'];
    if (m !== 'warn' && m !== 'block') {
      throw new Error(`${source}: 'similarity.mode' must be 'warn' or 'block' (got ${String(m)})`);
    }
    mode = m;
  }

  return { warnThreshold, mode };
}
