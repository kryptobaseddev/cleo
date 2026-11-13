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
import type { UpgradeFileJournal } from '../scaffold/upgrade-file-journal.js';
import { atomicWriteJson } from '../store/atomic.js';

/** Tight type guard for a plain object (excludes arrays and null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Legacy key path and the key path that replaced it (T14375). */
const LEGACY_PREFIX = 'orchestrator.contextThresholds';
const CURRENT_PREFIX = 'orchestrate.contextThresholds';

/**
 * Move legacy keys in a parsed config object to their current home, in place.
 *
 * `orchestrator.contextThresholds` merges into `orchestrate.contextThresholds`
 * field by field: a field already set under the new key wins, every other
 * legacy field is carried over. The legacy `orchestrator` object is removed
 * once nothing else is left in it, so no value is discarded silently.
 * Idempotent.
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
  const legacyThresholds = legacy['contextThresholds'];
  const current = isPlainObject(config['orchestrate']) ? config['orchestrate'] : {};
  const currentThresholds = current['contextThresholds'];
  if (!('contextThresholds' in current)) {
    current['contextThresholds'] = legacyThresholds;
  } else if (isPlainObject(currentThresholds) && isPlainObject(legacyThresholds)) {
    for (const [field, value] of Object.entries(legacyThresholds)) {
      if (!(field in currentThresholds)) currentThresholds[field] = value;
    }
  }
  config['orchestrate'] = current;
  delete legacy['contextThresholds'];
  if (Object.keys(legacy).length === 0) {
    delete config['orchestrator'];
  }
  return [LEGACY_PREFIX];
}

/**
 * Map a legacy dot-separated config key to the key that replaced it.
 *
 * `orchestrator.contextThresholds[.<field>]` maps to
 * `orchestrate.contextThresholds[.<field>]` and emits a `DeprecationWarning`
 * naming the new key, so a read or write of the old path is never silent.
 * Any other key is returned unchanged.
 *
 * @param key - Dot-separated key path as the caller gave it.
 * @returns The key path to read or write.
 */
export function resolveLegacyConfigKey(key: string): string {
  if (key !== LEGACY_PREFIX && !key.startsWith(`${LEGACY_PREFIX}.`)) return key;
  const current = CURRENT_PREFIX + key.slice(LEGACY_PREFIX.length);
  process.emitWarning(
    `config key '${key}' is deprecated since T14375; use '${current}' (run 'cleo upgrade' to migrate config.json)`,
    'DeprecationWarning',
  );
  return current;
}

/**
 * Doctor deprecation messages for a parsed config, migrating it in memory
 * first so schema validation sees the current shape (T14375 · T14260).
 *
 * @param config - Parsed `config.json`; mutated in place.
 * @returns One message per legacy key found.
 */
export function configLegacyKeyDeprecations(config: Record<string, unknown>): string[] {
  return migrateLegacyConfigKeys(config).map(
    (k) =>
      `config.json: ${k} is deprecated since T14375 and read as ${CURRENT_PREFIX}; run 'cleo upgrade' to rewrite it`,
  );
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

/**
 * Remove zero-valued sibling caps only for an explicitly requested upgrade repair.
 *
 * Legacy scaffolds and intentional unlimited overrides both used zero, so reads
 * and ordinary upgrades must preserve them. This opt-in repair backs up the
 * current bytes before restoring profile defaults; positive caps are retained.
 *
 * @param configPath - Project config file to repair.
 * @param journal - Upgrade journal recording the previous config bytes.
 * @param dryRun - Preview removed keys without writing or creating a backup.
 * @returns Removed key paths, or the proposed paths for a dry run.
 */
export async function migrateHierarchyDefaults(
  configPath: string,
  journal: UpgradeFileJournal,
  dryRun = false,
): Promise<string[]> {
  const { readJson } = await import('../store/json.js');
  const config = await readJson<Record<string, unknown>>(configPath);
  const hierarchy = config?.['hierarchy'];
  if (!config || !isPlainObject(hierarchy)) return [];

  const removed: string[] = [];
  for (const field of ['maxSiblings', 'maxActiveSiblings'] as const) {
    if (hierarchy[field] === 0) {
      delete hierarchy[field];
      removed.push(`hierarchy.${field}`);
    }
  }
  if (!dryRun && removed.length > 0) {
    const { backupBeforeChange } = await import('../scaffold/upgrade-file-journal.js');
    await backupBeforeChange(journal, configPath);
    await atomicWriteJson(configPath, config);
  }
  return removed;
}
