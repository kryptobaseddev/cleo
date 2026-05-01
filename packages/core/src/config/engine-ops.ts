/**
 * Config Engine Operations — EngineResult wrappers for config domain.
 *
 * Migrated from `packages/cleo/src/dispatch/engines/config-engine.ts`
 * (ENG-MIG-15 / T1582 / ADR-057 D1). All business logic remains in
 * `../config.ts`; this module only adds the `EngineResult` envelope so the
 * CLI dispatch layer can call core directly per ADR-057 D1.
 *
 * Importable from `@cleocode/core/internal` — no intermediate engine file
 * required in the CLI layer.
 *
 * @module config/engine-ops
 * @task T1582 — ENG-MIG-15
 * @epic T1566
 */

import {
  applyStrictnessPreset,
  getRawConfig,
  getRawConfigValue,
  listStrictnessPresets,
  type StrictnessPreset,
  setConfigValue,
} from '../config.js';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';

/** Valid strictness preset names. */
const VALID_PRESETS: StrictnessPreset[] = ['strict', 'standard', 'minimal'];

// ---------------------------------------------------------------------------
// configGet
// ---------------------------------------------------------------------------

/**
 * Get a config value by key (dot-notation supported) or the full config.
 *
 * Returns the full project config object when `key` is omitted.
 * Returns a single value when `key` is specified.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param key - Optional dot-notation config key (e.g. `session.autoStart`).
 * @returns EngineResult with the config value or full config object.
 * @task T1582 — ENG-MIG-15
 */
export async function configGet(projectRoot: string, key?: string): Promise<EngineResult<unknown>> {
  try {
    if (!key) {
      const config = await getRawConfig(projectRoot);
      if (!config) {
        return engineError('E_NOT_INITIALIZED', 'No config.json found');
      }
      return engineSuccess(config);
    }

    const value = await getRawConfigValue(key, projectRoot);
    if (value === undefined) {
      return engineError('E_CONFIG_KEY_NOT_FOUND', `Config key '${key}' not found`);
    }

    return engineSuccess(value);
  } catch (err: unknown) {
    return engineError('E_CONFIG_READ_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// configSet
// ---------------------------------------------------------------------------

/**
 * Set a config value by key (dot-notation supported).
 *
 * Creates intermediate objects as needed. Parses string values into
 * appropriate types (boolean, number, null, JSON).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param key - Dot-notation config key (e.g. `session.autoStart`).
 * @param value - Value to set. Strings are parsed into appropriate types.
 * @returns EngineResult with the key, parsed value, and scope.
 * @task T1582 — ENG-MIG-15
 */
export async function configSet(
  projectRoot: string,
  key: string,
  value: unknown,
): Promise<EngineResult<{ key: string; value: unknown }>> {
  try {
    const result = await setConfigValue(key, value, projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    return engineError('E_CONFIG_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// configSetPreset
// ---------------------------------------------------------------------------

/**
 * Apply a strictness preset to the project config.
 *
 * Valid presets: `strict`, `standard`, `minimal`.
 * Merges preset values over existing config — unrelated keys are preserved.
 * Idempotent: applying the same preset twice yields the same config.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param preset - Preset name (`strict` | `standard` | `minimal`).
 * @returns EngineResult with the applied preset details.
 * @task T067
 * @task T1582 — ENG-MIG-15
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return engineError('E_CONFIG_WRITE_FAILED', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// configListPresets
// ---------------------------------------------------------------------------

/**
 * List all available strictness presets with descriptions and values.
 *
 * Synchronous — reads from the in-memory preset definitions.
 *
 * @returns EngineResult with the array of preset descriptors.
 * @task T067
 * @task T1582 — ENG-MIG-15
 */
export function configListPresets(): EngineResult<unknown> {
  return engineSuccess(listStrictnessPresets());
}
