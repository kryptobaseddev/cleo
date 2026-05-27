import { join } from 'node:path';
// T9766 — `LoggerConfig` is now centralized in `@cleocode/contracts`.
import type { LoggerConfig } from '@cleocode/contracts';
import { getProjectInfoSync, initLogger } from '@cleocode/core';

/**
 * Initialize CLI logger with optional projectHash correlation context.
 */
export function initCliLogger(cwd: string, loggingConfig: LoggerConfig): void {
  const projectInfo = getProjectInfoSync(cwd);
  initLogger(join(cwd, '.cleo'), loggingConfig, projectInfo?.projectHash);
}
