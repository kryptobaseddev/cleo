import { join } from 'node:path';
import type { LoggerConfig } from '../core/logger.js';
import { initLogger } from '../core/logger.js';
import { getProjectInfoSync } from '../core/project-info.js';

/**
 * Initialize CLI logger with optional projectHash correlation context.
 */
export function initCliLogger(cwd: string, loggingConfig: LoggerConfig): void {
  const projectInfo = getProjectInfoSync(cwd);
  initLogger(join(cwd, '.cleo'), loggingConfig, projectInfo?.projectHash);
}
