import { existsSync } from 'node:fs';
import { join } from 'node:path';
// T9766 — `LoggerConfig` is now centralized in `@cleocode/contracts`.
import type { LoggerConfig } from '@cleocode/contracts';
import { loadConfig } from '@cleocode/core/config';
import { initLogger } from '@cleocode/core/logger';
import { getProjectInfoSync } from '@cleocode/core/project-info';
import { getProjectRoot } from '@cleocode/core/project-scope';

/** Set once {@link startCliFileLogger} has run in this process. */
let fileLoggerStarted = false;

/**
 * Initialize CLI logger with optional projectHash correlation context.
 */
export function initCliLogger(cwd: string, loggingConfig: LoggerConfig): void {
  const projectInfo = getProjectInfoSync(cwd);
  initLogger(join(cwd, '.cleo'), loggingConfig, projectInfo?.projectHash);
}

/**
 * Start the pino file logger for this CLI process (T14605).
 *
 * Resolves the project root, reads the merged `logging` config (defaults,
 * global, project and `CLEO_LOG_*` env overrides) and starts the logger that
 * writes `.cleo/<logging.filePath>` (default `.cleo/logs/cleo.log`). Runs at
 * most once per process; later calls do nothing. Outside a project (no
 * resolvable root or no `.cleo/` directory) it starts nothing, so
 * `getLogger()` keeps its stderr warn fallback. Never throws: a logger that
 * cannot start must not fail the command.
 *
 * @returns `true` when this call started the file logger.
 */
export async function startCliFileLogger(): Promise<boolean> {
  if (fileLoggerStarted) return false;
  fileLoggerStarted = true;
  try {
    const projectRoot = getProjectRoot();
    if (!existsSync(join(projectRoot, '.cleo'))) return false;
    const { logging } = await loadConfig(projectRoot);
    initCliLogger(projectRoot, logging);
    return true;
  } catch {
    return false;
  }
}
