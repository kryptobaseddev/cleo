/**
 * Init Engine
 *
 * Thin wrapper around core init operations.
 * Business logic lives in src/core/init.ts.
 *
 * CRITICAL: Init is explicit, not automatic. The MCP server MUST NOT
 * silently create .cleo/ directories on first write.
 *
 * @task T4789
 */

import {
  initProject as coreInitProject,
  isAutoInitEnabled as coreIsAutoInitEnabled,
  ensureInitialized as coreEnsureInitialized,
  getVersion as coreGetVersion,
} from '../../core/init.js';

/**
 * Engine result wrapper
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

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
      return {
        success: false,
        error: {
          code: 'E_ALREADY_INITIALIZED',
          message: 'CLEO project already initialized. Use force=true to reinitialize.',
        },
      };
    }
    return {
      success: false,
      error: { code: 'E_INIT_FAILED', message },
    };
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
    return {
      success: false,
      error: {
        code: 'E_NOT_INITIALIZED',
        message: (err as Error).message,
      },
    };
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
    return {
      success: false,
      error: { code: 'E_VERSION_FAILED', message: (err as Error).message },
    };
  }
}
