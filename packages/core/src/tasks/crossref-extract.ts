/**
 * Cross-reference extraction - extract task IDs from text content.
 * Ported from lib/tasks/crossref-extract.sh
 *
 * @epic T4454
 * @task T4529
 */

/** Valid relationship types for relates entries. */
export type RelatesType =
  | 'related'
  | 'blocks'
  | 'duplicates'
  | 'absorbs'
  | 'fixes'
  | 'extends'
  | 'supersedes';

const VALID_RELATES_TYPES: RelatesType[] = [
  'related',
  'blocks',
  'duplicates',
  'absorbs',
  'fixes',
  'extends',
  'supersedes',
];

/** A single relates entry. */
export interface RelatesEntry {
  taskId: string;
  type: RelatesType;
  reason?: string;
}

/**
 * Extract task IDs from text content.
 * Scans for patterns like T1234, T001, T42 (T followed by 3+ digits).
 */
export function extractTaskRefs(text: string, excludeId?: string): string[] {
  if (!text) return [];

  const pattern = /T\d{3,}/g;
  const matches = text.match(pattern);
  if (!matches) return [];

  const unique = [...new Set(matches)];

  if (excludeId) {
    return unique.filter((id) => id !== excludeId).sort();
  }
  return unique.sort();
}

/**
 * Create relates entries from extracted task IDs.
 */
export function createRelatesEntries(
  refs: string[],
  relType: RelatesType = 'related',
  reason?: string,
): RelatesEntry[] {
  if (!refs.length) return [];

  // Validate type, fallback to 'related'
  const validType = VALID_RELATES_TYPES.includes(relType) ? relType : 'related';

  return refs.map((taskId) => {
    const entry: RelatesEntry = { taskId, type: validType };
    if (reason) entry.reason = reason;
    return entry;
  });
}

/**
 * Merge new relates entries with existing ones.
 * Existing entries take precedence (dedup by taskId).
 */
export function mergeRelatesArrays(
  existing: RelatesEntry[],
  newEntries: RelatesEntry[],
): RelatesEntry[] {
  const existingIds = new Set(existing.map((e) => e.taskId));
  const filtered = newEntries.filter((e) => !existingIds.has(e.taskId));
  return [...existing, ...filtered];
}

/**
 * Validate that referenced task IDs exist.
 * Returns array of invalid (non-existent) task IDs.
 */
export function validateRelatesRefs(relates: RelatesEntry[], validTaskIds: string[]): string[] {
  if (!relates.length) return [];

  const validSet = new Set(validTaskIds);
  return relates.map((r) => r.taskId).filter((id) => !validSet.has(id));
}

/**
 * Convenience: extract task refs from text and create relates entries.
 */
export function extractAndCreateRelates(
  text: string,
  excludeId?: string,
  relType: RelatesType = 'related',
  reason?: string,
): RelatesEntry[] {
  const refs = extractTaskRefs(text, excludeId);
  return createRelatesEntries(refs, relType, reason);
}
