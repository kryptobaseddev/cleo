/**
 * Config Engine
 *
 * Thin wrapper around core config operations.
 * Business logic lives in src/core/config.ts.
 *
 * @task T4815
 * @task T067
 */

import {
  applyStrictnessPreset,
  getRawConfig,
  getRawConfigValue,
  listStrictnessPresets,
  type StrictnessPreset,
  setConfigValue,
} from '@cleocode/core';
import { type EngineResult, engineError } from './_error.js';

const VALID_PRESETS: StrictnessPreset[] = ['strict', 'standard', 'minimal'];

/**
 * Get config value by key (dot-notation supported)
 */
export async function configGet(projectRoot: string, key?: string): Promise<EngineResult<unknown>> {
  try {
    if (!key) {
      const config = await getRawConfig(projectRoot);
      if (!config) {
        return engineError('E_NOT_INITIALIZED', 'No config.json found');
      }
      return { success: true, data: config };
    }

    const value = await getRawConfigValue(key, projectRoot);
    if (value === undefined) {
      return engineError('E_CONFIG_KEY_NOT_FOUND', `Config key '${key}' not found`);
    }

    return { success: true, data: value };
  } catch (err: unknown) {
    return engineError('E_CONFIG_READ_FAILED', (err as Error).message);
  }
}

/**
 * Set a config value by key (dot-notation supported)
 */
export async function configSet(
  projectRoot: string,
  key: string,
  value: unknown,
): Promise<EngineResult<{ key: string; value: unknown }>> {
  try {
    const result = await setConfigValue(key, value, projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_CONFIG_WRITE_FAILED', (err as Error).message);
  }
}

/**
 * Apply a strictness preset to the project config.
 * @task T067
 */
export async function configSetPreset(
  projectRoot: string,
  preset: string,
): Promise<EngineResult<unknown>> {
  if (!VALID_PRESETS.includes(preset as StrictnessPreset)) {
    return engineError(
      'E_INVALID_INPUT',
      `Invalid preset '${preset}'. Valid presets: ${VALID_PRESETS.join(', ')}`,
    );
  }
  try {
    const result = await applyStrictnessPreset(preset as StrictnessPreset, projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_CONFIG_WRITE_FAILED', (err as Error).message);
  }
}

/**
 * List all available strictness presets.
 * @task T067
 */
export function configListPresets(): EngineResult<unknown> {
  return { success: true, data: listStrictnessPresets() };
}
