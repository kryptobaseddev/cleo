/**
 * Init Engine
 *
 * Thin wrapper around core init operations.
 * Business logic lives in src/core/init.ts.
 *
 * CRITICAL: Init is explicit, not automatic. The MCP server MUST NOT
 * silently create .cleo/ directories on first write.
 *
 * @task T4815
 */

import {
  initProject as coreInitProject,
  isAutoInitEnabled as coreIsAutoInitEnabled,
  ensureInitialized as coreEnsureInitialized,
  getVersion as coreGetVersion,
} from '../../core/init.js';
import { engineError, type EngineResult } from './_error.js';

/**
 * Initialize a CLEO project directory.
 *
 * Creates the .cleo/ directory structure with empty data files.
 * Returns error if already initialized (unless force=true).
 */
export async function initProject(
  projectRoot: string,
  options?: {
    projectName?: string;
    force?: boolean;
  }
): Promise<EngineResult<{
  initialized: boolean;
  projectRoot: string;
  filesCreated: string[];
}>> {
  try {
    const result = await coreInitProject({
      name: options?.projectName,
      force: options?.force,
    });

    return {
      success: true,
      data: {
        initialized: result.initialized,
        projectRoot,
        filesCreated: result.created,
      },
    };
  } catch (err: unknown) {
    const message = (err as Error).message;
    if (message.includes('already initialized')) {
      return engineError('E_ALREADY_INITIALIZED', 'CLEO project already initialized. Use force=true to reinitialize.');
    }
    return engineError('E_INIT_FAILED', message);
  }
}

/**
 * Check if auto-init is enabled via environment variable
 */
export function isAutoInitEnabled(): boolean {
  return coreIsAutoInitEnabled();
}

/**
 * Check initialization status and auto-init if configured
 */
export async function ensureInitialized(
  projectRoot: string
): Promise<EngineResult<{ initialized: boolean }>> {
  try {
    const result = await coreEnsureInitialized(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_NOT_INITIALIZED', (err as Error).message);
  }
}

/**
 * Get current version (native implementation)
 */
export async function getVersion(
  projectRoot: string
): Promise<EngineResult<{ version: string }>> {
  try {
    const result = await coreGetVersion(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_VERSION_FAILED', (err as Error).message);
  }
}
