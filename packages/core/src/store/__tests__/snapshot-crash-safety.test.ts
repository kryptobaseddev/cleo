/**
 * A process killed mid-VACUUM must never leave an empty file under a valid
 * snapshot name (T12508). Before the fix, `VACUUM INTO '<final name>'` created
 * the file first, so a SIGKILL left an empty `tasks-YYYYMMDD-HHmmss.db` — the
 * NEWEST snapshot, which restore then picked.
 *
 * A real child process (compiled `packages/core/dist/`) opens a real project
 * store and is SIGKILLed at the moment SQLite would be writing the snapshot:
 * `DatabaseSync.prototype.exec` is patched so `VACUUM INTO` creates its target
 * empty (as SQLite does) and then kills the process. The parent asserts that
 * only a `.tmp-<pid>` file remains — invisible to listing — and that the next
 * snapshot removes it and writes a valid snapshot.
 *
 * Skipped, with the reason below, when dist is not built.
 *
 * @task T12508
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PKG_ROOT = resolve(__dirname, '..', '..', '..');
const BACKUP_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'sqlite-backup.js');
const SQLITE_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'sqlite.js');
const DIST_MISSING = ![BACKUP_DIST, SQLITE_DIST].every((p) => existsSync(p));
if (DIST_MISSING) {
  process.stderr.write(
    'snapshot-crash-safety: SKIPPED — packages/core/dist is not built ' +
      '(run `pnpm --filter @cleocode/core run build`).\n',
  );
}

const VALID_NAME = /^tasks-\d{8}-\d{6}\.db$/;
const TEMP_NAME = /^tasks-\d{8}-\d{6}\.db\.tmp-\d+$/;

describe.skipIf(DIST_MISSING)('snapshot crash safety — killed mid-VACUUM (T12508)', () => {
  let workDir: string;
  let projectRoot: string;
  let cleoDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cleo-t12508-crash-'));
    projectRoot = join(workDir, 'project');
    cleoDir = join(projectRoot, '.cleo');
    const home = join(workDir, 'home');
    mkdirSync(cleoDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    env = { ...process.env, CLEO_HOME: home, CLEO_DIR: cleoDir, XDG_DATA_HOME: home };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Run a snapshot in a child; `killMidVacuum` SIGKILLs it inside VACUUM INTO. */
  function snapshotInChild(killMidVacuum: boolean): ReturnType<typeof spawnSync> {
    const script = `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      if (${killMidVacuum}) {
        const exec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function (sql) {
          if (sql.startsWith('VACUUM INTO')) {
            const target = sql.slice(sql.indexOf("'") + 1, sql.lastIndexOf("'")).replace(/''/g, "'");
            fs.writeFileSync(target, '');
            process.kill(process.pid, 'SIGKILL');
          }
          return exec.call(this, sql);
        };
      }
      (async () => {
        const sqlite = await import(${JSON.stringify(pathToFileURL(SQLITE_DIST).href)});
        await sqlite.getDb(${JSON.stringify(projectRoot)});
        const backup = await import(${JSON.stringify(pathToFileURL(BACKUP_DIST).href)});
        await backup.vacuumIntoBackup({ cwd: ${JSON.stringify(projectRoot)}, mode: 'required' });
        process.exit(0);
      })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
    `;
    return spawnSync(process.execPath, ['-e', script], {
      env,
      encoding: 'utf-8',
      timeout: 60_000,
    });
  }

  it('leaves no file under a valid snapshot name, and the next snapshot cleans up', () => {
    const killed = snapshotInChild(true);
    expect(killed.signal).toBe('SIGKILL');

    const backupDir = join(cleoDir, 'backups', 'sqlite');
    const afterKill = readdirSync(backupDir);
    expect(afterKill.filter((f) => VALID_NAME.test(f))).toEqual([]);
    expect(afterKill.filter((f) => TEMP_NAME.test(f))).toHaveLength(1);

    // The killed process left its gate lock behind; it would expire after
    // 10 minutes. Remove it to model that expiry.
    rmSync(join(backupDir, '.snapshot-gate.lock'), { recursive: true, force: true });

    const next = snapshotInChild(false);
    if (next.status !== 0) throw new Error(`snapshot failed: ${next.stderr}`);
    const afterNext = readdirSync(backupDir);
    expect(afterNext.filter((f) => TEMP_NAME.test(f))).toEqual([]);
    const valid = afterNext.filter((f) => VALID_NAME.test(f));
    expect(valid).toHaveLength(1);
    const path = join(backupDir, valid[0] ?? '');
    expect(statSync(path).size).toBeGreaterThan(0);
    const snap = new DatabaseSync(path, { readOnly: true });
    const ok = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    snap.close();
    expect(ok.integrity_check).toBe('ok');
  }, 120_000);
});
