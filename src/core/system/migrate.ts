/**
 * Migration status core module.
 * @task T4783
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

export interface MigrateResult {
  from: string;
  to: string;
  migrations: Array<{ name: string; applied: boolean }>;
  dryRun: boolean;
}

/** Check/report schema migration status. */
export function getMigrationStatus(
  projectRoot: string,
  opts?: { target?: string; dryRun?: boolean },
): MigrateResult {
  const taskPath = join(projectRoot, '.cleo', 'tasks.json');

  let currentVersion = 'unknown';
  if (existsSync(taskPath)) {
    try {
      const taskFile = JSON.parse(readFileSync(taskPath, 'utf-8'));
      currentVersion = taskFile._meta?.schemaVersion ?? taskFile.version ?? 'unknown';
    } catch {
      throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read tasks.json');
    }
  } else {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'No tasks.json found');
  }

  const targetVersion = opts?.target ?? currentVersion;

  return {
    from: currentVersion,
    to: targetVersion,
    migrations: currentVersion === targetVersion
      ? []
      : [{ name: `${currentVersion} -> ${targetVersion}`, applied: false }],
    dryRun: opts?.dryRun ?? false,
  };
}
