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
  const todoPath = join(projectRoot, '.cleo', 'todo.json');

  let currentVersion = 'unknown';
  if (existsSync(todoPath)) {
    try {
      const todo = JSON.parse(readFileSync(todoPath, 'utf-8'));
      currentVersion = todo._meta?.schemaVersion ?? todo.version ?? 'unknown';
    } catch {
      throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read todo.json');
    }
  } else {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'No todo.json found');
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
