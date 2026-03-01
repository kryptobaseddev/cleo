/**
 * Config Engine
 *
 * Thin wrapper around core config operations.
 * Business logic lives in src/core/config.ts.
 *
 * @task T4789
 */

import { getRawConfig, getRawConfigValue, setConfigValue } from '../../core/config.js';
import type { EngineResult } from '../../dispatch/engines/_error.js';

/**
 * Get config value by key (dot-notation supported)
 */
export async function configGet(
  projectRoot: string,
  key?: string
): Promise<EngineResult<unknown>> {
  try {
    if (!key) {
      const config = await getRawConfig(projectRoot);
      if (!config) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No config.json found' },
        };
      }
      return { success: true, data: config };
    }

    const value = await getRawConfigValue(key, projectRoot);
    if (value === undefined) {
      return {
        success: false,
        error: {
          code: 'E_CONFIG_KEY_NOT_FOUND',
          message: `Config key '${key}' not found`,
        },
      };
    }

    return { success: true, data: value };
  } catch (err: unknown) {
    return {
      success: false,
      error: { code: 'E_CONFIG_READ_FAILED', message: (err as Error).message },
    };
  }
}

/**
 * Set a config value by key (dot-notation supported)
 */
export async function configSet(
  projectRoot: string,
  key: string,
  value: unknown
): Promise<EngineResult<{ key: string; value: unknown }>> {
  try {
    const result = await setConfigValue(key, value, projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return {
      success: false,
      error: { code: 'E_CONFIG_WRITE_FAILED', message: (err as Error).message },
    };
  }
}
