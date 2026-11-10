/**
 * Where lead records live (T14363), kept apart from `lead-records.ts` so a
 * hot path (`cleo orchestrate status`) can check for records without loading
 * the reaper and its AgentMBX, session-store and worktree imports (gate 39).
 *
 * @task T14363
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCleoDir } from '../paths.js';

/**
 * Directory holding a project's lead records (`<cleoDir>/leads`).
 *
 * @param projectRoot - Project root.
 * @returns The directory path.
 * @task T14363
 */
export function leadRecordsDir(projectRoot: string): string {
  return join(resolveCleoDir(projectRoot), 'leads');
}

/**
 * Whether any lead record may exist, without loading the reaper.
 *
 * @param projectRoot - Project root.
 * @returns True when the lead records directory exists.
 * @task T14363
 */
export function hasLeadRecords(projectRoot: string): boolean {
  return existsSync(leadRecordsDir(projectRoot));
}
