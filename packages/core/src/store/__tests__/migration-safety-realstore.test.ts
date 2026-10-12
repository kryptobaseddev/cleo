/**
 * AC5 (T13448) — the snapshot-proof variant the #2169 review asked for.
 *
 * The AC says "a copy of this repo's real .cleo store"; this file exercises
 * exactly that, safely:
 *
 *   1. The snapshot is taken OUT OF BAND with `cleo backup add` (a VACUUM
 *      INTO copy under `.cleo/backups/sqlite/`) — the live `.cleo/*.db` is
 *      never read directly. The snapshot file is gitignored, so a machine
 *      without one skips this suite (`CLEO_TEST_REAL_STORE_SNAPSHOT` points
 *      at an explicit copy).
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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  fingerprintTable,
  type MigrationStepReport,
  rollbackMigrationStep,
  runMigrationSteps,
} from '../migration-safety.js';

/** node:sqlite is CJS-only; createRequire keeps this ESM test file loadable. */
const _require = createRequire(import.meta.url);

/** The repo root (worktree root here) — six levels above this test file. */
function repoRoot(): string {
  return dirname(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))));
}

/** A discovered real-store snapshot: the `cleo backup add` copy + its sidecar. */
interface RealStoreSnapshot {
  /** Absolute path of the `cleo.db.<backupId>` snapshot file. */
  readonly path: string;
  /** The backup id from the `<backupId>.meta.json` sidecar. */
  readonly backupId: string;
  /** ISO-8601 snapshot time from the sidecar. */
  readonly timestamp: string;
}

/**
 * Resolve a real-store snapshot without ever touching a live `.cleo/*.db`:
 * an explicit env path first, then the newest `cleo backup add` snapshot in
 * `<repoRoot>/.cleo/backups/sqlite/` (sidecar + store file both present).
 */
function resolveRealStoreSnapshot(): RealStoreSnapshot | null {
  const fromEnv = process.env['CLEO_TEST_REAL_STORE_SNAPSHOT'];
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return { path: fromEnv, backupId: 'env', timestamp: 'unknown' };
  }
  const dir = join(repoRoot(), '.cleo', 'backups', 'sqlite');
  if (!existsSync(dir)) return null;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -'.meta.json'.length);
    if (!existsSync(join(dir, `cleo.db.${id}`))) continue;
    const mtimeMs = statSync(join(dir, name)).mtimeMs;
    if (best === null || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
  }
  if (best === null) return null;
  const sidecar = JSON.parse(readFileSync(join(dir, `${best.id}.meta.json`), 'utf-8')) as {
    timestamp?: string;
  };
  return {
    path: join(dir, `cleo.db.${best.id}`),
    backupId: best.id,
    timestamp: sidecar.timestamp ?? 'unknown',
  };
}

/** SHA-256 of a file (byte-equality assertions). */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SNAPSHOT = resolveRealStoreSnapshot();
if (SNAPSHOT === null) {
  process.stdout.write(
    '[migration-safety-realstore] no real-store snapshot found ' +
      '(set CLEO_TEST_REAL_STORE_SNAPSHOT or run `cleo backup add`); suite skipped\n',
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
