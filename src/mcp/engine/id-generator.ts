/**
 * Task ID Generator
 *
 * Generates unique task IDs in the T#### format used by CLEO.
 * Ensures uniqueness across both todo.json and todo-archive.json.
 */

import { readJsonFile } from './store.js';
import { join } from 'path';

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
 * Collect all existing task IDs from todo.json and archive
 */
export function collectAllIds(projectRoot: string): Set<string> {
  const ids = new Set<string>();

  // Read todo.json
  const taskPath = join(projectRoot, '.cleo', 'todo.json');
  const taskData = readJsonFile<{ tasks?: Array<{ id: string }> }>(taskPath);
  if (taskData?.tasks) {
    for (const task of taskData.tasks) {
      if (task.id) ids.add(task.id);
    }
  }

  // Read archive
  const archivePath = join(projectRoot, '.cleo', 'todo-archive.json');
  const archiveData = readJsonFile<{
    archivedTasks?: Array<{ id: string }>;
  }>(archivePath);
  if (archiveData?.archivedTasks) {
    for (const task of archiveData.archivedTasks) {
      if (task.id) ids.add(task.id);
    }
  }

  return ids;
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
 * Generate the next available task ID.
 *
 * Finds the highest existing ID number across todo.json and archive,
 * then returns the next sequential ID.
 *
 * @param projectRoot - Project root directory
 * @returns New unique task ID (e.g., "T4321")
 */
export function generateNextId(projectRoot: string): string {
  const existingIds = collectAllIds(projectRoot);
  const highest = findHighestId(existingIds);
  const next = highest + 1;

  // Pad to at least 3 digits
  const padded = next.toString().padStart(3, '0');
  return `T${padded}`;
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
