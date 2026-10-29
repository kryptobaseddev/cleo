/**
 * Normalised Levenshtein similarity for slugs and short names (T10361),
 * a leaf module with no refusals so the duplicate-doc check (T14109) and the
 * docs-rot check (T14111) can share it without pulling the slug-similarity
 * gate's error paths onto their callers' import graphs.
 *
 * @task T10361
 * @task T14109
 */

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
 * @param a - First string.
 * @param b - Second string.
 * @returns The score in `[0, 1]`.
 * @task T10361
 * @task T14109 — exported for the duplicate-doc check
 * @task T14111 — exported for the docs-rot duplicate-title check
 */
export function similarityScore(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1; // both empty
  const distance = levenshteinDistance(a, b);
  return 1 - distance / longest;
}
