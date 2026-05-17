/**
 * XDG drift migration for the global CLEO config file (T9405).
 *
 * Pre-T9405 history: `globalConfigPath()` resolved to the CLEO **data** dir
 * (`getCleoHome()`), so existing installs have `config.json` at
 * `~/.local/share/cleo/config.json`. XDG says user config belongs in
 * `XDG_CONFIG_HOME` (`~/.config/cleo/config.json`).
 *
 * This migration runs on first credentials read after upgrade:
 *
 * 1. Skip if the data-dir source is absent.
 * 2. Skip if the data-dir migration marker exists (idempotent).
 * 3. Skip if the config-dir target already exists (manual migration / fresh install).
 * 4. Otherwise:
 *    a. `mkdir -p` the config dir.
 *    b. Read the data-dir config.
 *    c. Validate the JSON parses.
 *    d. Write to a temp file in the config dir, then atomically rename to the
 *       final `config.json` (temp-then-rename — never any partial state).
 *    e. Drop the marker file at `<data-dir>/.migrations/config-dir-v1.done`.
 *    f. Rename the data-dir original to `config.json.pre-e1-bak` so users can
 *       recover if something goes wrong.
 *
 * Migration is best-effort: every error is swallowed and logged to stderr. A
 * failed migration must never crash a CLI invocation — credentials resolution
 * just falls back to the data-dir location via the transition-window logic
 * baked into `globalConfigPath()`.
 *
 * @module llm/global-config-migration
 * @task T9405
 * @epic T9398
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCleoHome, getCleoPlatformPaths } from '@cleocode/paths';

/**
 * Filename used by `legacyGlobalConfigPath()` / `configDirGlobalConfigPath()`.
 *
 * Kept in one place so the migration helper and the credentials resolver agree
 * without anyone hard-coding the string in two places.
 *
 * @internal
 */
export const GLOBAL_CONFIG_FILENAME = 'config.json';

/**
 * Subdirectory in the data dir where migration markers are stamped.
 *
 * @internal
 */
const MIGRATIONS_SUBDIR = '.migrations';

/**
 * Marker filename written when the config-dir migration completes.
 *
 * @internal
 */
const MIGRATION_MARKER = 'config-dir-v1.done';

/**
 * Backup suffix appended to the data-dir source after a successful migration.
 *
 * Per the E-CONFIG-AUTH-UNIFY spec the original is renamed (not deleted) so
 * users have a recovery path.
 *
 * @internal
 */
const BACKUP_SUFFIX = '.pre-e1-bak';

/**
 * Resolve the canonical config-dir path for the global config file.
 *
 * Linux:   `~/.config/cleo/config.json`
 * macOS:   `~/Library/Preferences/cleo/config.json`
 * Windows: `%APPDATA%\cleo\Config\config.json`
 *
 * @public
 */
export function configDirGlobalConfigPath(): string {
  return join(getCleoPlatformPaths().config, GLOBAL_CONFIG_FILENAME);
}

/**
 * Resolve the legacy data-dir path for the global config file.
 *
 * Pre-T9405 location. Read-only fallback during the transition window — the
 * migration moves the contents to {@link configDirGlobalConfigPath} and
 * renames the data-dir original to `config.json.pre-e1-bak`.
 *
 * @public
 */
export function legacyGlobalConfigPath(): string {
  return join(getCleoHome(), GLOBAL_CONFIG_FILENAME);
}

/**
 * Path to the migration marker file. Stamped in the data dir (NOT the config
 * dir) because the marker is tied to "did we already process the legacy
 * data-dir install?" — co-locating it with the source makes the relationship
 * obvious and prevents `CLEO_HOME` overrides in tests from clobbering the
 * config-dir state.
 *
 * @internal
 */
function migrationMarkerPath(): string {
  return join(getCleoHome(), MIGRATIONS_SUBDIR, MIGRATION_MARKER);
}

/**
 * Path used during atomic write inside the config dir.
 *
 * @internal
 */
function tempTargetPath(): string {
  return `${configDirGlobalConfigPath()}.tmp`;
}

/**
 * Run the data-dir → config-dir migration if applicable.
 *
 * Idempotent: safe to call on every CLEO invocation. Performs at most three
 * filesystem stat calls in the steady state (marker present OR source absent).
 *
 * Never throws. Errors are logged to stderr and swallowed — the credentials
 * resolver's transition-window logic will still find the legacy data-dir copy.
 *
 * @returns `true` when a migration was actually performed, `false` when it was
 *   a no-op (already migrated, no source, or target already present).
 *
 * @task T9405
 */
export function migrateGlobalConfigToConfigDir(): boolean {
  try {
    const source = legacyGlobalConfigPath();
    const target = configDirGlobalConfigPath();
    const marker = migrationMarkerPath();

    // Already ran — fast-path idempotency.
    if (existsSync(marker)) return false;

    // No legacy source — fresh install or already cleaned up. Stamp the marker
    // so we don't re-stat on every invocation.
    if (!existsSync(source)) {
      stampMarker(marker);
      return false;
    }

    // Target already present (manual migration, dual install, or a previous
    // partial run that completed the rename without dropping the marker).
    // Stamp the marker and back up the source so the data-dir copy stops
    // shadowing the config-dir copy.
    if (existsSync(target)) {
      backupSourceQuiet(source);
      stampMarker(marker);
      return false;
    }

    // Read + parse-validate the source. Any failure aborts the migration —
    // we never touch the config dir with content that's not provably JSON.
    const raw = readFileSync(source, 'utf-8');
    try {
      JSON.parse(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[cleo] global config migration skipped: ${source} is not valid JSON (${
          (err as Error).message
        })`,
      );
      return false;
    }

    // Ensure the config dir exists.
    mkdirSync(getCleoPlatformPaths().config, { recursive: true });

    // Atomic temp-then-rename: write to a sibling temp file, then rename onto
    // the final path. rename(2) is atomic on the same filesystem (always true
    // here — both paths are inside the config dir).
    const temp = tempTargetPath();
    writeFileSync(temp, raw, { mode: 0o644 });
    renameSync(temp, target);

    // Stamp the migration marker — must come BEFORE the source rename so a
    // crash between rename(temp→target) and marker write doesn't leave the
    // resolver finding both copies on the next run (the transition-window
    // logic already handles that, but the marker is the cheaper steady state).
    stampMarker(marker);

    // Rename the source to the backup name. We use renameSync (not copyFile +
    // unlink) so the operation is atomic on the same filesystem — once the
    // data-dir entry stops existing the resolver's transition-window check
    // can't accidentally pick up the legacy copy.
    try {
      renameSync(source, `${source}${BACKUP_SUFFIX}`);
    } catch (err) {
      // Best-effort: the migration is logically complete even if the rename
      // fails (the resolver prefers the config dir). Log + continue.
      // eslint-disable-next-line no-console
      console.error(
        `[cleo] global config migrated, but backup rename failed: ${
          (err as Error).message
        }. The legacy file at ${source} can be removed manually.`,
      );
    }

    // eslint-disable-next-line no-console
    console.error(
      `[cleo] migrated global config: ${source} → ${target} (backup at ${source}${BACKUP_SUFFIX})`,
    );
    return true;
  } catch (err) {
    // Last-resort safety net — clean up any partial temp file we left behind.
    try {
      const temp = tempTargetPath();
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.error(
      `[cleo] global config migration failed: ${(err as Error).message}. Credentials will continue to resolve from the legacy data-dir location.`,
    );
    return false;
  }
}

/**
 * Stamp the migration marker file. Best-effort — errors are swallowed.
 *
 * @internal
 */
function stampMarker(markerPath: string): void {
  try {
    mkdirSync(join(getCleoHome(), MIGRATIONS_SUBDIR), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o644 });
  } catch {
    // ignore — a missing marker just means we'll re-stat once more next run.
  }
}

/**
 * Best-effort rename of the legacy source to the backup name. Silent failure.
 *
 * @internal
 */
function backupSourceQuiet(source: string): void {
  try {
    const backup = `${source}${BACKUP_SUFFIX}`;
    if (existsSync(backup)) return; // already backed up
    renameSync(source, backup);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// First-invocation latch
// ---------------------------------------------------------------------------

let hasRunInProcess = false;

/**
 * Run the migration at most once per Node process.
 *
 * Called from the credentials resolver before reading `globalConfigPath()` so
 * a stale install is upgraded in-place on first credentials read. The latch
 * keeps the steady-state cost at one boolean check after the first call —
 * essential because `resolveCredentials()` is on the hot path of every LLM
 * call.
 *
 * Use {@link _resetGlobalConfigMigrationLatch} in tests to re-arm the latch.
 *
 * @public
 */
export function ensureGlobalConfigMigrated(): void {
  if (hasRunInProcess) return;
  hasRunInProcess = true;
  migrateGlobalConfigToConfigDir();
}

/**
 * Reset the in-process migration latch. Test-only — use in `beforeEach` so
 * each test re-runs the migration with its own fresh `XDG_*` / `CLEO_HOME`
 * overrides.
 *
 * @internal
 */
export function _resetGlobalConfigMigrationLatch(): void {
  hasRunInProcess = false;
}
