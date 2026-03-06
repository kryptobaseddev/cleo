/**
 * Migration status core module.
 * @task T4783
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';

export interface MigrateResult {
  from: string;
  to: string;
  migrations: Array<{ name: string; applied: boolean }>;
  dryRun: boolean;
}

/** Check/report schema migration status. */
export async function getMigrationStatus(
  projectRoot: string,
  opts?: { target?: string; dryRun?: boolean },
): Promise<MigrateResult> {
  const taskPath = join(projectRoot, '.cleo', 'tasks.db');

  let currentVersion = 'unknown';
  if (existsSync(taskPath)) {
    try {
      const accessor = await getAccessor(projectRoot);
      const taskFile = await accessor.loadTaskFile();
      currentVersion = taskFile._meta?.schemaVersion ?? taskFile.version ?? 'unknown';
    } catch {
      throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read tasks.db');
    }
  } else {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'No tasks.db found');
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
