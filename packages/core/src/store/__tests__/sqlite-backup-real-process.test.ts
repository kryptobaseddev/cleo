/**
 * Real-process regression test for the T10316 brain backup gap.
 *
 * Spawns a node child via `child_process.spawnSync('node', ['-e', '...'])` that
 * imports the compiled `vacuumIntoBackupAll` from `packages/core/dist/`. The
 * child:
 *
 * 1. Sets `CLEO_HOME` and `CLEO_DIR` to absolute paths inside a per-test
 *    temp dir (no contamination of the live `$XDG_DATA_HOME/cleo/` or the
 *    project's `.cleo/`).
 * 2. Does NOT call `cleo memory observe` or any code path that would lazily
 *    open brain.db. The brain native-handle singleton starts as `null`.
 * 3. Invokes `vacuumIntoBackupAll({ cwd: tempDir, force: true })`.
 * 4. Exits cleanly.
 *
 * The parent process then asserts that a `brain-YYYYMMDD-HHmmss.db` file
 * landed in `<tempDir>/.cleo/backups/sqlite/`. Before the T10316 fix the
 * fast-path returned `null` and snapshotOne silently skipped brain — so
 * the only artifacts were `tasks-*.db` snapshots.
 *
 * This test deliberately bypasses vitest mocks because the bug surfaces only
 * in a real process where module-singleton caches are empty. The mock-based
 * unit guard (`sqlite-backup.test.ts`, the `vacuumIntoBackupAll calls openDb
 * for brain when getBrainNativeDb is null (T10316)` case) remains in place
 * as the inner-contract guard.
 *
 * @task T10316
 * @saga T10281
 * @epic T10284 (E3-BACKUP-RECOVERY)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// packages/core/src/store/__tests__/ → packages/core
const CORE_PKG_ROOT = resolve(__dirname, '..', '..', '..');
const SQLITE_BACKUP_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'sqlite-backup.js');

describe('sqlite-backup real-process (T10316)', () => {
  let workDir: string;
  let cleoHome: string;
  let cleoDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cleo-t10316-real-'));
    cleoHome = join(workDir, 'cleo-home');
    cleoDir = join(workDir, 'project', '.cleo');
    mkdirSync(cleoHome, { recursive: true });
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort — tmp cleanup is non-fatal.
    }
  });

  it('produces brain-YYYYMMDD-HHmmss.db even when no caller pre-opened brain.db', () => {
    // The compiled dist MUST exist — the test depends on the real module
    // graph (no vitest module mocks). Builds run before tests via the
    // monorepo workflow; a missing dist is a clear signal to rebuild.
    expect(existsSync(SQLITE_BACKUP_DIST)).toBe(true);

    // T10316: brain.db is NEVER opened in the child process before the
    // snapshot call. The bug is that vacuumIntoBackupAll would silently
    // skip brain when getBrainNativeDb() returns null. The fix is the
    // eager-open via target.openDb.
    const projectRoot = join(workDir, 'project');
    const childScript = `
      const path = ${JSON.stringify(SQLITE_BACKUP_DIST)};
      (async () => {
        const mod = await import(path);
        await mod.vacuumIntoBackupAll({ cwd: ${JSON.stringify(projectRoot)}, force: true });
      })().catch((err) => {
        process.stderr.write(String((err && err.stack) || err));
        process.exit(2);
      });
    `;

    const result = spawnSync(process.execPath, ['-e', childScript], {
      env: {
        ...process.env,
        // Test isolation: ensure no contamination of the developer's real
        // ~/.local/share/cleo/ or project .cleo/. CLEO_HOME pins the
        // global tier; CLEO_DIR pins the project tier (absolute path —
        // bypasses getProjectRoot walk per paths.ts §getCleoDir line 283).
        CLEO_HOME: cleoHome,
        CLEO_DIR: cleoDir,
        // Belt-and-suspenders: route any unintended global open to the
        // throwaway home, never the developer's machine.
        XDG_DATA_HOME: cleoHome,
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // The child MUST succeed end-to-end — backup failure is supposed to be
    // non-fatal, but spawning failure is a test infrastructure problem we
    // want to see surfaced.
    if (result.status !== 0) {
      throw new Error(
        `Child exited with status ${result.status}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }

    // Assert: brain snapshot landed in <CLEO_DIR>/backups/sqlite/.
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    expect(existsSync(backupDir)).toBe(true);

    const files = readdirSync(backupDir);
    const brainSnapshots = files.filter((f) => /^brain-\d{8}-\d{6}\.db$/.test(f));
    const tasksSnapshots = files.filter((f) => /^tasks-\d{8}-\d{6}\.db$/.test(f));

    // Headline regression check: at LEAST one brain-*.db snapshot file.
    // Pre-fix, this count was 0 in production despite tasks-*.db being healthy.
    expect(brainSnapshots.length).toBeGreaterThanOrEqual(1);

    // Sanity: tasks snapshot should also exist — confirms the eager-open
    // contract holds for the previously-working path too.
    expect(tasksSnapshots.length).toBeGreaterThanOrEqual(1);
  });
});
