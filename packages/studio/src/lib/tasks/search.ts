/**
 * Task search normalization utilities for CLEO Studio.
 *
 * Centralizes the logic for parsing user search input into an exact task ID
 * (e.g. "T663", "t663", "663") or a fuzzy title query.
 */

/** Result of normalizing a raw search string. */
export type NormalizedSearch =
  | { kind: 'id'; id: string }
  | { kind: 'title'; query: string }
  | { kind: 'empty' };

/**
 * Normalizes a raw search string entered by the user.
 *
 * Rules:
 * - Empty / whitespace-only → `{ kind: 'empty' }`
 * - Matches `T###`, `t###`, or bare `###` (digits only) → `{ kind: 'id', id: 'T###' }`
 * - Anything else → `{ kind: 'title', query: trimmed }` for fuzzy title search
 *
 * @param raw - The raw string value from the search input.
 * @returns A discriminated union describing the normalized search intent.
 */
export function normalizeSearch(raw: string): NormalizedSearch {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'empty' };
  }

  // Match optional T/t prefix followed by digits
  const idMatch = /^[Tt]?(\d+)$/.exec(trimmed);
  if (idMatch) {
    return { kind: 'id', id: `T${idMatch[1]}` };
  }

  return { kind: 'title', query: trimmed };
}
