/**
 * Task ID Generator
 *
 * Generates unique task IDs in the T#### format used by CLEO.
 * Ensures uniqueness across active and archived tasks.
 */

/**
 * Task ID pattern: T followed by 3+ digits
 */
const TASK_ID_PATTERN = /^T(\d{3,})$/;

/**
 * Extract the numeric part from a task ID
 */
function extractNumber(id: string): number {
  const match = id.match(TASK_ID_PATTERN);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Find the highest existing task ID number
 */
export function findHighestId(existingIds: Set<string>): number {
  let highest = 0;
  for (const id of existingIds) {
    const num = extractNumber(id);
    if (num > highest) {
      highest = num;
    }
  }
  return highest;
}

/**
 * Generate the next ID given an explicit set of existing IDs.
 * Useful when caller has already loaded task data.
 */
export function generateNextIdFromSet(existingIds: Set<string>): string {
  const highest = findHighestId(existingIds);
  const next = highest + 1;
  const padded = next.toString().padStart(3, '0');
  return `T${padded}`;
}

/**
 * Validate that a task ID matches the expected format
 */
export function isValidTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

/**
 * Normalize a task ID input to canonical T#### format.
 *
 * Accepts various loose formats (lowercase prefix, bare digits,
 * underscore-suffixed descriptors) and returns the canonical form,
 * or null if the input cannot be parsed as a task ID.
 */
export function normalizeTaskId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const match = trimmed.match(/^[Tt]?(\d+)(?:_.*)?$/);
  if (!match) return null;
  return `T${match[1]}`;
}
