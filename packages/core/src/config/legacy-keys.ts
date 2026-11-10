/**
 * Legacy config key migration — read-old, write-new (T14375).
 *
 * `orchestrator.contextThresholds` moved to `orchestrate.contextThresholds`,
 * so all orchestration settings live under one `orchestrate` key. Readers
 * call {@link migrateLegacyConfigKeys} on every file they load, which keeps
 * old configs working; `cleo upgrade` calls {@link migrateLegacyConfigFile}
 * once to rewrite the project file in the new shape.
 *
 * @task T14375
 */

import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../store/atomic.js';

/** Tight type guard for a plain object (excludes arrays and null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Move legacy keys in a parsed config object to their current home, in place.
 *
 * `orchestrator.contextThresholds` moves to `orchestrate.contextThresholds`
 * unless that key is already set (the new key wins). The legacy
 * `orchestrator` object is removed once nothing else is left in it, so no
 * value is ever discarded silently. Idempotent.
 *
 * @param config - Parsed config file contents; mutated in place.
 * @returns The legacy key paths that were moved (empty when none).
 *
 * @example
 * ```typescript
 * const cfg = { orchestrator: { contextThresholds: { warning: 60, critical: 75 } } };
 * migrateLegacyConfigKeys(cfg); // ['orchestrator.contextThresholds']
 * cfg.orchestrate; // { contextThresholds: { warning: 60, critical: 75 } }
 * ```
 */
export function migrateLegacyConfigKeys(config: Record<string, unknown>): string[] {
  const legacy = config['orchestrator'];
  if (!isPlainObject(legacy) || !('contextThresholds' in legacy)) return [];
  const current = isPlainObject(config['orchestrate']) ? config['orchestrate'] : {};
  if (!('contextThresholds' in current)) {
    current['contextThresholds'] = legacy['contextThresholds'];
  }
  config['orchestrate'] = current;
  delete legacy['contextThresholds'];
  if (Object.keys(legacy).length === 0) {
    delete config['orchestrator'];
  }
  return ['orchestrator.contextThresholds'];
}

/**
 * Rewrite a config file on disk with its legacy keys migrated (one-time step
 * run by `cleo upgrade`).
 *
 * Missing or unparseable files are left untouched; the file is written
 * atomically only when a legacy key was found.
 *
 * @param configPath - Absolute path to a `config.json`.
 * @returns The legacy key paths migrated (empty when the file was unchanged).
 */
export async function migrateLegacyConfigFile(configPath: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const migrated = migrateLegacyConfigKeys(parsed);
  if (migrated.length > 0) {
    await atomicWriteJson(configPath, parsed);
  }
  return migrated;
}
