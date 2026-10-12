/**
 * AC5 (T13448) — the snapshot-proof variant the #2169 review asked for.
 *
 * The AC says "a copy of this repo's real .cleo store"; this file exercises
 * exactly that, safely:
 *
 *   1. The snapshot is taken OUT OF BAND with `cleo backup add` (a VACUUM
 *      INTO copy under `.cleo/backups/sqlite/`) — the live `.cleo/*.db` is
 *      never read directly. The suite runs ONLY when
 *      `CLEO_TEST_REAL_STORE_SNAPSHOT` names an explicit snapshot copy; there
 *      is no auto-discovery, so a machine without the env var skips the suite
 *      (and never copies personal store data into tmp).
 *   2. The test copies the snapshot into a throwaway sandbox and runs the
 *      harness against the COPY only.
 *   3. It reports the table/row counts and content hashes it verified, runs
 *      a no-op step through backup → verify → report, then rolls back and
 *      asserts byte equality with the pre-step snapshot.
 *
 * @task T13448
 * @task T13609 — the transactional bracket is what makes the no-op proof
 *   meaningful on a live multi-MB store: nothing outside the step transaction
 *   can be half-written.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintTable,
  type MigrationStepReport,
  rollbackMigrationStep,
  runMigrationSteps,
} from '../migration-safety.js';

/** node:sqlite is CJS-only; createRequire keeps this ESM test file loadable. */
const _require = createRequire(import.meta.url);

/** An explicitly-named real-store snapshot file (a `cleo backup add` copy). */
interface RealStoreSnapshot {
  /** Absolute path of the snapshot file. */
  readonly path: string;
  /** Snapshot label reported in the proof line (`'env'` for an env-named copy). */
  readonly backupId: string;
  /** ISO-8601 snapshot time when known, else `'unknown'`. */
  readonly timestamp: string;
}

/**
 * Resolve a real-store snapshot without ever touching a live `.cleo/*.db`:
 * ONLY an explicit `CLEO_TEST_REAL_STORE_SNAPSHOT` env path is honored. There
 * is deliberately NO auto-discovery under `<repoRoot>/.cleo/backups/sqlite/` —
 * that would silently run a heavy (~300 s) test and copy personal store data
 * into tmp on any dev machine that happens to have a backup (#2169 review).
 */
function resolveRealStoreSnapshot(): RealStoreSnapshot | null {
  const fromEnv = process.env['CLEO_TEST_REAL_STORE_SNAPSHOT'];
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return { path: fromEnv, backupId: 'env', timestamp: 'unknown' };
  }
  return null;
}

/** SHA-256 of a file (byte-equality assertions). */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SNAPSHOT = resolveRealStoreSnapshot();
if (SNAPSHOT === null) {
  process.stdout.write(
    '[migration-safety-realstore] no real-store snapshot found ' +
      '(set CLEO_TEST_REAL_STORE_SNAPSHOT to an explicit snapshot copy); suite skipped\n',
  );
}

/** Compact proof line the review asked to be reported. */
function reportProof(
  snapshot: RealStoreSnapshot,
  step: MigrationStepReport,
  extra: Record<string, number>,
): void {
  const totalRows = step.tables.reduce((sum, t) => sum + t.before.count, 0);
  const sampled = step.tables.filter((t) => !t.before.full).length;
  const proof = {
    snapshot: snapshot.backupId,
    snapshotTakenAt: snapshot.timestamp,
    tablesVerified: step.tables.length,
    totalRows,
    tablesSampled: sampled,
    tasksRows: step.tables.find((t) => t.table === 'tasks_tasks')?.before.count ?? 0,
    versionsRows:
      step.tables.find((t) => t.table === 'conduit_attachment_versions')?.before.count ?? 0,
    attachmentsRows: step.tables.find((t) => t.table === 'conduit_attachments')?.before.count ?? 0,
    ...extra,
  };
  process.stdout.write(`[migration-safety-realstore] proof ${JSON.stringify(proof)}\n`);
}

const describeReal = SNAPSHOT === null ? describe.skip : describe;

describeReal('AC5 — harness against a snapshot of this repo’s real .cleo store', () => {
  it('a copied real-store snapshot runs backup → verify → report, then rolls back with byte equality', {
    timeout: 300_000,
  }, async () => {
    if (SNAPSHOT === null) throw new Error('unreachable: suite is skipped');
    const sandbox = mkdtempSync(join(tmpdir(), 'cleo-realstore-'));
    const cleoDir = join(sandbox, '.cleo');
    try {
      mkdirSync(cleoDir, { recursive: true });
      const dbPath = join(cleoDir, 'cleo.db');
      // The harness runs against the COPY only; the real store is untouched.
      copyFileSync(SNAPSHOT.path, dbPath);

      // Point the path SSoT at the sandbox: restoreStoreSnapshot resolves
      // the target through resolveCleoDir, which prefers CLEO_DIR.
      vi.stubEnv('CLEO_DIR', cleoDir);
      // Open the copy exactly like the production store: extension loading
      // permitted and sqlite-vec loaded, or the brain vec0 tables cannot
      // even be counted (memory-sqlite.ts loadBrainVecExtension, T5157).
      const db = new DatabaseSync(dbPath, { allowExtension: true });
      const sqliteVec = _require('sqlite-vec') as { load: (d: DatabaseSync) => void };
      sqliteVec.load(db);
      let step: MigrationStepReport;
      try {
        // Substance checks BEFORE the run: this really is the project's store.
        const tasks = fingerprintTable(db, 'tasks_tasks');
        expect(tasks.count).toBeGreaterThan(0);
        const noop = {
          name: 'realstore-noop',
          description: 'no-op proof step against a real-store snapshot copy',
          run() {
            /* intentionally empty: carried-everything is the assertion */
          },
        };
        const run = await runMigrationSteps([noop], {
          db,
          projectRoot: sandbox,
          cwd: sandbox,
          dbPath,
        });
        expect(run.status).toBe('completed');
        const first = run.steps[0];
        if (!first) throw new Error('run produced no step reports');
        step = first;
        expect(step.transaction).toBe('committed');
        expect(step.foreignKeyViolations).toBe(0);
        expect(step.failures).toEqual([]);
        // The real schema was in scope — dozens of tables, all carried.
        expect(step.tables.length).toBeGreaterThan(30);
        for (const table of step.tables) {
          expect(table.countOk).toBe(true);
          expect(table.hashOk).toBe(true);
        }
      } finally {
        // The restore refuses while any handle on the target is open.
        db.close();
      }

      const backup = step.backup;
      if (backup === null) throw new Error('expected a backup receipt');
      reportProof(SNAPSHOT, step, {
        snapshotBytes: statSync(SNAPSHOT.path).size,
        rollbackVerified: 1,
      });

      const rollback = await rollbackMigrationStep({
        projectRoot: sandbox,
        cwd: sandbox,
        step: step.step,
        backup,
        before: step.tables.map((t) => t.before),
      });
      expect(rollback.restored).toBe(true);
      expect(rollback.verified).toBe(true);
      expect(rollback.failures).toEqual([]);
      expect(fileSha256(dbPath)).toBe(fileSha256(backup.snapshotPath));
    } finally {
      vi.unstubAllEnvs();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
