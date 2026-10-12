/**
 * The migration safety harness (T13448), attacked and proven:
 *
 *   - AC1/AC2: backup → migrate → verify → report — receipt sidecars on
 *     disk, per-table counts and content hashes compared, FK check clean.
 *   - AC2: a step that leaves an FK violation is caught even when its count
 *     delta is declared.
 *   - AC3: rollback restores the step's snapshot through the programmatic
 *     `cleo restore backup` core and re-proves counts, hashes and bytes.
 *   - AC4: a failed verification auto-halts the run, names the step, and the
 *     not-yet-run steps never execute.
 *   - Refusal guard: destructive steps refuse without `force` plus a fresh
 *     backup receipt.
 *   - AC5: a real-shaped store at scale — the actual T13354 conduit-history
 *     tables (applied to every fresh fixture store by the drizzle journal)
 *     seeded with thousands of rows plus blob files — a no-op REBUILD of one
 *     history table (the T11649 recipe) through the harness, then rollback
 *     with byte/count equality.
 *
 * Every store lives in a temp project (createTestDb) whose store was opened
 * through the canonical chokepoint; the demo steps execute raw SQL because
 * they ARE the migration layer (raw DML in tests is seeding/migration-layer
 * code, per the db-open and raw-write gate conventions).
 *
 * @task T13448
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countForeignKeyViolations,
  fingerprintTable,
  type MigrationRunReport,
  type MigrationStep,
  type MigrationStepReport,
  rollbackMigrationStep,
  runMigrationSteps,
} from '../migration-safety.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

/** node:sqlite-only loader for the sqlite-vec extension (ESM-safe, gate 34). */
const _require = createRequire(import.meta.url);

let env: TestDbEnv;
let db: DatabaseSync;

/** Scale for the AC5 fixture — thousands of history rows over hundreds of docs. */
const SCALE = {
  attachments: 300,
  versionsPerAttachment: 8, // 2400 version rows
  approvalsPerAttachment: 2, // 600 approval rows
  contributorsPerAttachment: 2, // 600 contributor rows
  crdtPerAttachment: 2, // 600 crdt rows (blobs)
} as const;

/** Deterministic ISO timestamp for seeded rows (stable hashes across runs). */
function iso(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i)).toISOString();
}

/** Content of doc `i` — deterministic pseudo-bytes. */
function docContent(i: number): Buffer {
  return Buffer.from(`# Doc ${i}\n\n${'content '.repeat((i % 20) + 1)}`);
}

function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Seed the REAL T13354-shaped conduit history tables at scale on the fixture
 * store, plus a few blob files under `.cleo/blobs/blobs/` whose sha256 is the
 * `content_hash` stored in `conduit_attachments`.
 */
function seedDocsHistory(fixture: DatabaseSync, cleoDir: string, scale: number): void {
  const blobDir = join(cleoDir, 'blobs', 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const insAttachment = fixture.prepare(
    `INSERT INTO conduit_attachments
       (slug, conversation_id, from_agent_id, content, original_size, compressed_size,
        content_hash, format, title, tokens, storage_key, mode, version_count,
        current_version, created_at, uid, birth_fp)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'md', ?, ?, ?, 'published', ?, ?, ?, ?, ?)`,
  );
  const insVersion = fixture.prepare(
    `INSERT INTO conduit_attachment_versions
       (id, uid, birth_fp, attachment_uid, parent_version_uid, slug, version_number,
        author_agent_id, change_type, patch_text, storage_key, content_hash,
        original_size, compressed_size, tokens, change_summary, sections_modified,
        tokens_added, tokens_removed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'patch', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
  );
  const insApproval = fixture.prepare(
    `INSERT INTO conduit_attachment_approvals
       (id, uid, birth_fp, attachment_uid, version_uid, section_id, slug,
        reviewer_agent_id, status, comment, version_reviewed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'approved', ?, ?, ?, ?)`,
  );
  const insContributor = fixture.prepare(
    `INSERT INTO conduit_attachment_contributors
       (attachment_uid, slug, agent_id, version_count, total_tokens_added,
        total_tokens_removed, first_contribution_at, last_contribution_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const insCrdt = fixture.prepare(
    `INSERT INTO section_crdt_states
       (attachment_uid, section_id, snapshot, base_version_uid, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < scale; i++) {
    const content = docContent(i);
    const hash = contentHash(content);
    const slug = `doc-${i}`;
    const uid = `uid-doc-${i}`;
    const storageKey = `blob-${hash.slice(0, 16)}`;
    // The blob file the storage_key points at — rollback must leave it intact.
    writeFileSync(join(blobDir, storageKey), content);
    insAttachment.run(
      slug,
      `conv-${i % 7}`,
      `agent-${i % 3}`,
      content,
      content.length,
      content.length,
      hash,
      `Doc ${i}`,
      10 + i,
      storageKey,
      SCALE.versionsPerAttachment,
      SCALE.versionsPerAttachment,
      iso(i),
      uid,
      `fp-${i}`,
    );
    let parentUid: string | null = null;
    for (let v = 0; v < SCALE.versionsPerAttachment; v++) {
      const versionUid = `uid-ver-${i}-${v}`;
      insVersion.run(
        `ver-${i}-${v}`,
        versionUid,
        `fp-v-${i}-${v}`,
        uid,
        parentUid,
        slug,
        v + 1,
        `agent-${(i + v) % 3}`,
        `patch ${v} of doc ${i}`,
        storageKey,
        hash,
        content.length,
        content.length,
        10 + v,
        `summary ${v}`,
        v * 2,
        v,
        iso(v),
      );
      parentUid = versionUid;
    }
    for (let a = 0; a < SCALE.approvalsPerAttachment; a++) {
      insApproval.run(
        `appr-${i}-${a}`,
        `uid-appr-${i}-${a}`,
        `fp-a-${i}-${a}`,
        uid,
        `uid-ver-${i}-${SCALE.versionsPerAttachment - 1}`,
        slug,
        `reviewer-${a}`,
        `looks good ${a}`,
        SCALE.versionsPerAttachment,
        iso(a),
        iso(a),
      );
    }
    for (let c = 0; c < SCALE.contributorsPerAttachment; c++) {
      insContributor.run(
        uid,
        slug,
        `agent-${c}`,
        SCALE.versionsPerAttachment,
        SCALE.versionsPerAttachment * 2,
        iso(c),
        iso(SCALE.versionsPerAttachment - c),
      );
    }
    for (let s = 0; s < SCALE.crdtPerAttachment; s++) {
      insCrdt.run(uid, `sec-${s}`, Buffer.from(`crdt-state-${i}-${s}`), `uid-ver-${i}-0`, iso(s));
    }
  }
}

/** The T11649 no-op rebuild recipe, applied to one table — inside the
 * harness bracket, so it uses defer_foreign_keys (enforced at COMMIT); a raw
 * foreign_keys=OFF would be a no-op inside the transaction (T13609). */
function rebuildTableVerbatim(fixture: DatabaseSync, table: string, newTableSql: string): void {
  fixture.exec('PRAGMA defer_foreign_keys = ON');
  fixture.exec(newTableSql);
  fixture.exec(`INSERT INTO "__new_${table}" SELECT * FROM "${table}" ORDER BY rowid`);
  fixture.exec(`DROP TABLE "${table}"`);
  fixture.exec(`ALTER TABLE "__new_${table}" RENAME TO "${table}"`);
}

const CONTRIBUTORS_SCHEMA = `CREATE TABLE __new_conduit_attachment_contributors (
  attachment_uid text, slug text, agent_id text NOT NULL,
  version_count integer DEFAULT 0 NOT NULL,
  total_tokens_added integer DEFAULT 0 NOT NULL,
  total_tokens_removed integer DEFAULT 0 NOT NULL,
  first_contribution_at text NOT NULL, last_contribution_at text NOT NULL,
  CONSTRAINT conduit_attachment_contributors_pk PRIMARY KEY(attachment_uid, agent_id),
  CONSTRAINT fk_conduit_attachment_contributors_attachment_uid
    FOREIGN KEY (attachment_uid) REFERENCES conduit_attachments(uid) ON DELETE NO ACTION,
  CHECK (first_contribution_at GLOB '[0-9][0-9][0-9][0-9]-*'),
  CHECK (last_contribution_at GLOB '[0-9][0-9][0-9][0-9]-*')
)`;

/**
 * A destructive demo step: no-op rebuild of the contributors table (a leaf —
 * child of attachments, parent of nothing). Inside the harness bracket FKs
 * cannot be turned OFF, and DROP of an FK-PARENT table records a sticky
 * deferred violation at its implicit DELETE, so parent rebuilds must use the
 * save/null/restore recipe for their referencing children; a leaf rebuild
 * works with defer_foreign_keys alone.
 */
const rebuildContributorsStep: MigrationStep = {
  name: 'rebuild-contributors',
  description: 'no-op T11649 rebuild of conduit_attachment_contributors',
  destructive: true,
  run({ db: fixture }) {
    rebuildTableVerbatim(fixture, 'conduit_attachment_contributors', CONTRIBUTORS_SCHEMA);
  },
};

/** The last step report of a run (the step the runner ended on). */
function lastStep(report: MigrationRunReport): MigrationStepReport {
  const step = report.steps[report.steps.length - 1];
  if (!step) throw new Error('run produced no step reports');
  return step;
}

/** Hash a file (byte-equality assertions). */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Cleanup tolerant of the restore path having closed the in-process handles
 * (restoreStoreSnapshot quiescence, T13240): close best-effort, always remove
 * the temp dir.
 */
async function safeCleanup(e: TestDbEnv): Promise<void> {
  try {
    await e.cleanup();
  } catch {
    try {
      e.accessor.close();
    } catch {
      // already closed by the restore quiescence
    }
    resetDbState();
    rmSync(e.tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [
    { id: 'T001', title: 'existing task', type: 'task' },
    { id: 'T002', title: 'second task', type: 'task' },
  ]);
  const native = getNativeDb(env.tempDir);
  if (!native) throw new Error('expected a live native handle after createTestDb');
  db = native;
});

afterEach(async () => {
  await safeCleanup(env);
});

describe('runMigrationSteps (T13448)', () => {
  it('enforces backup → migrate → verify → report for each step (AC1)', async () => {
    seedDocsHistory(db, env.cleoDir, 20);
    const onStepReport = vi.fn();
    const insertStep: MigrationStep = {
      name: 'add-versions',
      description: 'append three versions to an existing doc',
      verify: { expectedDelta: { conduit_attachment_versions: 3 } },
      run({ db: fixture }) {
        const ins = fixture.prepare(
          `INSERT INTO conduit_attachment_versions
             (id, uid, birth_fp, attachment_uid, slug, version_number, author_agent_id,
              storage_key, content_hash, original_size, compressed_size, tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let v = 0; v < 3; v++) {
          ins.run(
            `ver-new-${v}`,
            `uid-ver-new-${v}`,
            `fp-new-${v}`,
            'uid-doc-0',
            'doc-0',
            100 + v,
            'agent-9',
            'blob-x',
            'hash-x',
            1,
            1,
            1,
            iso(v),
          );
        }
      },
    };

    const report = await runMigrationSteps([rebuildContributorsStep, insertStep], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      force: true,
      onStepReport,
    });

    expect(report.status).toBe('completed');
    expect(report.haltedStep).toBeNull();
    expect(report.failure).toBeNull();
    expect(report.steps).toHaveLength(2);
    expect(onStepReport).toHaveBeenCalledTimes(2);

    for (const stepReport of report.steps) {
      expect(stepReport.status).toBe('completed');
      // The backup receipt exists on disk: snapshot + sidecar.
      expect(stepReport.backup).not.toBeNull();
      const backup = stepReport.backup;
      if (!backup) throw new Error('unreachable');
      expect(existsSync(backup.snapshotPath)).toBe(true);
      const sidecar = JSON.parse(
        readFileSync(
          join(env.cleoDir, 'backups', 'sqlite', `${backup.backupId}.meta.json`),
          'utf-8',
        ),
      ) as { backupId: string; type: string; timestamp: string; files: string[] };
      expect(sidecar.type).toBe('migration');
      expect(sidecar.files).toContain('cleo.db');
      expect(Date.parse(sidecar.timestamp)).toBeGreaterThan(0);
      expect(backup.timestamp).toBe(sidecar.timestamp);
      expect(stepReport.failures).toEqual([]);
      expect(stepReport.foreignKeyViolations).toBe(0);
      expect(stepReport.runError).toBeNull();
      // Every pre-existing table was compared before/after.
      const versions = stepReport.tables.find((t) => t.table === 'conduit_attachment_versions');
      expect(versions).toBeDefined();
      expect(versions?.countOk).toBe(true);
      expect(stepReport.tables.every((t) => t.countOk)).toBe(true);
      // No table vanished, none appeared.
      expect(stepReport.removedTables).toEqual([]);
      expect(stepReport.addedTables).toEqual([]);
    }

    // The carried-table hash spot check ran on the zero-delta tables…
    const rebuildReport = report.steps[0];
    if (!rebuildReport) throw new Error('unreachable');
    const carried = rebuildReport.tables.find((t) => t.table === 'conduit_attachments');
    expect(carried?.hashOk).toBe(true);
    // …including the rebuilt table itself (the rebuild carries every row).
    const contributorsAfterRebuild = rebuildReport.tables.find(
      (t) => t.table === 'conduit_attachment_contributors',
    );
    expect(contributorsAfterRebuild?.hashOk).toBe(true);
    expect(contributorsAfterRebuild?.before.hash).toBe(contributorsAfterRebuild?.after?.hash);
    expect(contributorsAfterRebuild?.before.count).toBe(20 * SCALE.contributorsPerAttachment);

    // …and a declared-delta table is exempt from the hash check (AC2 contract).
    const insertReport = report.steps[1];
    if (!insertReport) throw new Error('unreachable');
    expect(insertReport.tables.find((t) => t.table === 'conduit_attachment_versions')?.hashOk).toBe(
      null,
    );
  });

  it('catches an unexplained row-count delta and halts, naming the step (AC4)', async () => {
    seedDocsHistory(db, env.cleoDir, 10);
    const spy = vi.fn();
    const tamper: MigrationStep = {
      name: 'tamper-versions',
      run({ db: fixture }) {
        fixture.exec(`DELETE FROM conduit_attachment_versions WHERE rowid <= 5`);
      },
    };
    const neverRuns: MigrationStep = { name: 'must-not-run', run: spy };

    const report = await runMigrationSteps([tamper, neverRuns], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });

    expect(report.status).toBe('halted');
    expect(report.haltedStep).toBe('tamper-versions');
    expect(report.failure).toContain('conduit_attachment_versions');
    expect(spy).not.toHaveBeenCalled();
    const step = lastStep(report);
    expect(step.status).toBe('failed');
    expect(step.failures.join('\n')).toContain('row count');
    // The rollback path is ready: receipt + before-fingerprints are here.
    expect(step.backup).not.toBeNull();
    expect(step.tables.length).toBeGreaterThan(0);
  });

  it('halts when a step throws, naming the step (AC4)', async () => {
    const boom: MigrationStep = {
      name: 'exploding-step',
      run() {
        throw new Error('migration body exploded');
      },
    };
    const report = await runMigrationSteps([boom], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(report.status).toBe('halted');
    expect(report.haltedStep).toBe('exploding-step');
    expect(lastStep(report).runError).toBe('migration body exploded');
  });

  it('runs PRAGMA foreign_key_check and fails a step that leaves a violation (AC2)', async () => {
    seedDocsHistory(db, env.cleoDir, 5);
    const orphan: MigrationStep = {
      name: 'orphan-version',
      verify: { expectedDelta: { conduit_attachment_versions: 1 } },
      run({ db: fixture }) {
        // Deferred FKs (T13609): the orphan insert succeeds inside the
        // transaction and is caught by the harness's foreign_key_check (and
        // would fail COMMIT) — then the whole step is rolled back.
        fixture.exec('PRAGMA defer_foreign_keys = ON');
        fixture
          .prepare(
            `INSERT INTO conduit_attachment_versions
             (id, uid, attachment_uid, slug, version_number, author_agent_id, storage_key,
              content_hash, original_size, compressed_size, tokens, created_at)
           VALUES ('ver-orphan', 'uid-ver-orphan', 'uid-does-not-exist', 'doc-0', 99,
                   'agent-x', 'k', 'h', 1, 1, 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run();
      },
    };
    const report = await runMigrationSteps([orphan], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(report.status).toBe('halted');
    const step = lastStep(report);
    expect(step.transaction).toBe('rolled-back');
    expect(step.foreignKeyViolations).toBeGreaterThanOrEqual(1);
    expect(step.failures.join('\n')).toContain('foreign_key_check');
    // The count delta WAS declared, so the failure is the FK check alone.
    expect(step.tables.find((t) => t.table === 'conduit_attachment_versions')?.countOk).toBe(true);
    // T13609: the failed step was rolled back — the live store is clean again
    // with no explicit rollback call.
    expect(countForeignKeyViolations(db)).toBe(0);
    const versions = db
      .prepare(`SELECT COUNT(*) AS n FROM conduit_attachment_versions WHERE id = 'ver-orphan'`)
      .get() as { n: number };
    expect(versions.n).toBe(0);
  });

  it('T13609 AC1/AC3: a failed step is never visible — the live store is unchanged with no rollback call', async () => {
    seedDocsHistory(db, env.cleoDir, 15);
    // A checkpointed WAL so file-byte equality is meaningful.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const liveStore = join(env.cleoDir, 'cleo.db');
    const preBytes = fileSha256(liveStore);
    const preVersions = fingerprintTable(db, 'conduit_attachment_versions');
    const preTasks = fingerprintTable(db, 'tasks_tasks');
    const preCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM conduit_attachment_versions`).get() as { n: number }
    ).n;

    // A half-migration: destructive deletes plus new rows, then a verify
    // failure (unexplained count delta). No explicit rollback call anywhere.
    const failing: MigrationStep = {
      name: 'half-migrated-step',
      run({ db: fixture }) {
        fixture.exec(`DELETE FROM conduit_attachment_versions WHERE rowid <= 40`);
        fixture
          .prepare(
            `INSERT INTO conduit_attachment_versions
               (id, uid, attachment_uid, slug, version_number, author_agent_id, storage_key,
                content_hash, original_size, compressed_size, tokens, created_at)
             VALUES ('ver-half', 'uid-ver-half', 'uid-doc-0', 'doc-0', 777, 'agent-x',
                     'k', 'h', 1, 1, 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run();
      },
    };
    const report = await runMigrationSteps([failing], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });

    expect(report.status).toBe('halted');
    expect(report.haltedStep).toBe('half-migrated-step');
    const step = lastStep(report);
    expect(step.transaction).toBe('rolled-back');

    // The store the runner left live IS the pre-step store.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(fileSha256(liveStore)).toBe(preBytes);
    expect(fingerprintTable(db, 'conduit_attachment_versions')).toEqual(preVersions);
    expect(fingerprintTable(db, 'tasks_tasks')).toEqual(preTasks);
    const postCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM conduit_attachment_versions`).get() as { n: number }
    ).n;
    expect(postCount).toBe(preCount);
    const half = db
      .prepare(`SELECT COUNT(*) AS n FROM conduit_attachment_versions WHERE id = 'ver-half'`)
      .get() as { n: number };
    expect(half.n).toBe(0);
  });

  it('T13609 AC1/AC3: a throwing step leaves the live store unchanged', async () => {
    seedDocsHistory(db, env.cleoDir, 8);
    const preVersions = fingerprintTable(db, 'conduit_attachment_versions');
    const exploding: MigrationStep = {
      name: 'throws-mid-write',
      run({ db: fixture }) {
        fixture.exec(`DELETE FROM conduit_attachment_approvals WHERE rowid <= 3`);
        throw new Error('mid-step explosion after destructive writes');
      },
    };
    const report = await runMigrationSteps([exploding], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(report.status).toBe('halted');
    const step = lastStep(report);
    expect(step.transaction).toBe('rolled-back');
    expect(step.runError).toContain('mid-step explosion');
    expect(fingerprintTable(db, 'conduit_attachment_versions')).toEqual(preVersions);
    const approvals = db
      .prepare(`SELECT COUNT(*) AS n FROM conduit_attachment_approvals`)
      .get() as { n: number };
    expect(approvals.n).toBe(8 * SCALE.approvalsPerAttachment);
  });

  it('T13609 AC2: a concurrent writer cannot interleave with the bracket', async () => {
    db.exec(`CREATE TABLE wt_probe (id INTEGER PRIMARY KEY, note TEXT)`);
    db.exec(`INSERT INTO wt_probe VALUES (1, 'carried')`);
    const probe: MigrationStep = {
      name: 'write-exclusion-probe',
      run({ dbPath }) {
        // A second connection on the same store file. The harness holds
        // BEGIN IMMEDIATE on the live handle for the whole fingerprint → run
        // → verify bracket, so this write must wait out busy_timeout and
        // fail — never land between the fingerprints and the verify.
        const other = new DatabaseSync(dbPath);
        try {
          other.exec('PRAGMA busy_timeout = 500');
          expect(() => other.exec(`INSERT INTO wt_probe VALUES (2, 'interleaved')`)).toThrow(
            /BUSY|locked/i,
          );
        } finally {
          other.close();
        }
      },
    };
    const report = await runMigrationSteps([probe], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(report.status).toBe('completed');
    expect(lastStep(report).transaction).toBe('committed');
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM wt_probe`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('T13626: a step that drops a before-skipped (unreadable) table fails and rolls back', async () => {
    // A vec0 virtual table created by a module-equipped SIDE connection. On
    // the harness handle (no sqlite-vec loaded) it is unreadable — the
    // before-capture records it in unreadableTables and never fingerprints
    // it. That is the blind spot: a step that loads the module and drops the
    // table would otherwise go undetected by the count/hash checks.
    const side = new DatabaseSync(join(env.cleoDir, 'cleo.db'), { allowExtension: true });
    try {
      const sqliteVec = _require('sqlite-vec') as { load: (d: DatabaseSync) => void };
      sqliteVec.load(side);
      side.exec('CREATE VIRTUAL TABLE skipped_vec_probe USING vec0(embedding float[4])');
      side.exec(`INSERT INTO skipped_vec_probe(rowid, embedding) VALUES (1, '[1,2,3,4]')`);
    } finally {
      side.close();
    }

    const dropping: MigrationStep = {
      name: 'drops-skipped-cache',
      run({ db: fixture }) {
        // The step loads the extension and drops the previously-unreadable
        // table — exactly what a "rebuild the cache" step would do.
        const sqliteVec = _require('sqlite-vec') as { load: (d: DatabaseSync) => void };
        sqliteVec.load(fixture);
        fixture.exec('DROP TABLE skipped_vec_probe');
      },
    };

    const report = await runMigrationSteps([dropping], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });

    expect(report.status).toBe('halted');
    expect(report.haltedStep).toBe('drops-skipped-cache');
    const step = lastStep(report);
    expect(step.transaction).toBe('rolled-back');
    // The guard names the dropped, previously-skipped table.
    expect(step.unreadableTables.map((t) => t.table)).toContain('skipped_vec_probe');
    expect(step.failures.join('\n')).toContain('skipped_vec_probe');
    // The step's drop was rolled back: the table is back in the live store.
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skipped_vec_probe'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain('skipped_vec_probe');
  });

  it('refuses destructive steps without force, even with a fresh receipt', async () => {
    seedDocsHistory(db, env.cleoDir, 5);
    const spy = vi.fn();
    const destructive: MigrationStep = {
      name: 'destructive-drop',
      destructive: true,
      run: spy,
    };
    const report = await runMigrationSteps([destructive], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(report.status).toBe('refused');
    expect(report.haltedStep).toBe('destructive-drop');
    expect(spy).not.toHaveBeenCalled();
    const step = lastStep(report);
    expect(step.status).toBe('refused');
    expect(step.transaction).toBe('rolled-back');
    expect(step.failures.join('\n')).toContain('force');
    // The refusal itself was backed up first: the receipt exists.
    expect(step.backup).not.toBeNull();
  });

  it('runs destructive steps when force is given (receipt is fresh by construction)', async () => {
    seedDocsHistory(db, env.cleoDir, 5);
    const report = await runMigrationSteps([rebuildContributorsStep], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      force: true,
    });
    expect(report.status).toBe('completed');
    expect(lastStep(report).status).toBe('completed');
  });

  it('throws only for invalid invocation (no steps)', async () => {
    await expect(
      runMigrationSteps([], { db, projectRoot: env.tempDir, cwd: env.tempDir }),
    ).rejects.toThrow(/at least one step/);
  });
});

describe('rollbackMigrationStep (T13448, AC3)', () => {
  it('restores the step backup and re-proves counts, hashes and bytes', async () => {
    seedDocsHistory(db, env.cleoDir, 25);
    const beforeVersions = fingerprintTable(db, 'conduit_attachment_versions');
    const beforeDoc0Hash = contentHash(docContent(0));

    const mutating: MigrationStep = {
      name: 'append-and-update',
      verify: {
        expectedDelta: { conduit_attachment_versions: 2, conduit_attachment_approvals: 1 },
      },
      run({ db: fixture }) {
        const ins = fixture.prepare(
          `INSERT INTO conduit_attachment_versions
             (id, uid, attachment_uid, slug, version_number, author_agent_id, storage_key,
              content_hash, original_size, compressed_size, tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let v = 0; v < 2; v++) {
          ins.run(
            `ver-rolled-${v}`,
            `uid-ver-rolled-${v}`,
            'uid-doc-0',
            'doc-0',
            900 + v,
            'agent-9',
            'k',
            'h',
            1,
            1,
            1,
            iso(v),
          );
        }
        fixture
          .prepare(
            `INSERT INTO conduit_attachment_approvals
               (id, uid, attachment_uid, slug, reviewer_agent_id, version_reviewed,
                created_at, updated_at)
             VALUES ('appr-rolled', 'uid-appr-rolled', 'uid-doc-0', 'doc-0', 'agent-9', 900,
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
      },
    };

    const run = await runMigrationSteps([mutating], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(run.status).toBe('completed');
    const step = lastStep(run);
    const backup = step.backup;
    if (!backup) throw new Error('expected a backup receipt');

    const rollback = await rollbackMigrationStep({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      step: step.step,
      backup,
      before: step.tables.map((t) => t.before),
    });

    expect(rollback.restored).toBe(true);
    expect(rollback.verified).toBe(true);
    expect(rollback.failures).toEqual([]);
    expect(rollback.keptBackupId).not.toBeNull();
    expect(rollback.undo).toContain('cleo restore backup');
    for (const table of rollback.tables) {
      expect(table.countOk).toBe(true);
      expect(table.hashOk).toBe(true);
    }

    // Byte equality: the live store file IS the verified snapshot copy.
    const liveStore = join(env.cleoDir, 'cleo.db');
    expect(fileSha256(liveStore)).toBe(fileSha256(backup.snapshotPath));

    // Row-level proof through a fresh handle: the appended rows are gone and
    // the carried content is intact. The restore closed the old singletons
    // (quiescence), so re-open through the chokepoint.
    await getDb(env.tempDir);
    const native = getNativeDb(env.tempDir);
    if (!native) throw new Error('expected a live native handle after rollback');
    const after = fingerprintTable(native, 'conduit_attachment_versions');
    expect(after.count).toBe(beforeVersions.count);
    expect(after.hash).toBe(beforeVersions.hash);
    const doc0 = native
      .prepare(`SELECT content_hash FROM conduit_attachments WHERE slug = 'doc-0'`)
      .get() as { content_hash: string };
    expect(doc0.content_hash).toBe(beforeDoc0Hash);
  });

  it('rolls back a failed step: the halted run report is the rollback input', async () => {
    seedDocsHistory(db, env.cleoDir, 10);
    const tamper: MigrationStep = {
      name: 'bad-rekey',
      run({ db: fixture }) {
        fixture.exec(`DELETE FROM conduit_attachment_approvals WHERE rowid <= 4`);
      },
    };
    const run = await runMigrationSteps([tamper], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
    });
    expect(run.status).toBe('halted');
    const step = lastStep(run);
    const backup = step.backup;
    if (!backup) throw new Error('expected a backup receipt');

    const rollback = await rollbackMigrationStep({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      step: step.step,
      backup,
      before: step.tables.map((t) => t.before),
    });
    expect(rollback.verified).toBe(true);
    const approvals = rollback.tables.find((t) => t.table === 'conduit_attachment_approvals');
    expect(approvals?.countOk).toBe(true);
    expect(approvals?.hashOk).toBe(true);
  });
});

describe('content fingerprints (T13448, AC2 support)', () => {
  it('is order-independent across a verbatim table rebuild', () => {
    db.exec(`CREATE TABLE fp_probe (id text PRIMARY KEY, body text, n integer)`);
    const ins = db.prepare(`INSERT INTO fp_probe VALUES (?, ?, ?)`);
    for (let i = 0; i < 50; i++) ins.run(`id-${i}`, `body ${i}`, i);
    const before = fingerprintTable(db, 'fp_probe');

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`CREATE TABLE __new_fp_probe (id text PRIMARY KEY, body text, n integer)`);
    db.exec(`INSERT INTO __new_fp_probe SELECT * FROM fp_probe ORDER BY rowid DESC`);
    db.exec(`DROP TABLE fp_probe`);
    db.exec(`ALTER TABLE __new_fp_probe RENAME TO fp_probe`);
    db.exec('PRAGMA foreign_keys = ON');

    const after = fingerprintTable(db, 'fp_probe');
    expect(after.count).toBe(before.count);
    expect(after.hash).toBe(before.hash);
  });

  it('samples oversized tables and detects content drift in the sample', () => {
    db.exec(`CREATE TABLE fp_big (id text PRIMARY KEY, body text)`);
    const ins = db.prepare(`INSERT INTO fp_big VALUES (?, ?)`);
    for (let i = 0; i < 500; i++) ins.run(`id-${i}`, `body ${i}`);
    const before = fingerprintTable(db, 'fp_big', 32);
    expect(before.full).toBe(false);
    expect(before.sampledRowids.length).toBeGreaterThan(0);
    expect(before.sampledRowids.length).toBeLessThanOrEqual(32);

    db.prepare(`UPDATE fp_big SET body = 'drifted' WHERE rowid = ?`).run(
      before.sampledRowids[0] as number,
    );
    const after = fingerprintTable(db, 'fp_big', 32);
    expect(after.hash).not.toBe(before.hash);
  });
});

describe('AC5 — harness against a real-shaped store at scale', () => {
  it('backup → migrate → verify → report, then rollback with byte/count equality', async () => {
    // Thousands of rows across the conduit docs/attachments/history family,
    // on top of the real tasks/brain/conduit schema a fresh store carries.
    seedDocsHistory(db, env.cleoDir, SCALE.attachments);
    const seededVersions = SCALE.attachments * SCALE.versionsPerAttachment; // 2400
    const beforeTamper = fingerprintTable(db, 'conduit_attachment_versions');
    expect(beforeTamper.count).toBe(seededVersions);
    expect(beforeTamper.full).toBe(false); // sampled spot check path exercised

    const liveStore = join(env.cleoDir, 'cleo.db');
    const preRunBytes = fileSha256(liveStore);

    const run = await runMigrationSteps([rebuildContributorsStep], {
      db,
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      force: true,
    });

    // backup → migrate → verify → report
    expect(run.status).toBe('completed');
    const step = lastStep(run);
    expect(step.backup).not.toBeNull();
    const backup = step.backup;
    if (!backup) throw new Error('unreachable');
    expect(step.foreignKeyViolations).toBe(0);
    expect(step.failures).toEqual([]);
    for (const table of step.tables) {
      expect(table.countOk).toBe(true);
      if (table.hashOk !== null) expect(table.hashOk).toBe(true);
    }
    // The whole real schema was in scope: tasks, brain, conduit family, journal.
    const names = step.tables.map((t) => t.table);
    expect(names).toContain('tasks_tasks');
    expect(names).toContain('conduit_attachments');
    expect(names).toContain('conduit_attachment_versions');
    expect(names).toContain('conduit_attachment_approvals');
    expect(names).toContain('section_crdt_states');

    // The migration itself worked: the rebuilt table still answers queries.
    const stillThere = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conduit_attachment_contributors WHERE attachment_uid = 'uid-doc-299'`,
      )
      .get() as { n: number };
    expect(stillThere.n).toBe(SCALE.contributorsPerAttachment);

    // rollback → byte/count equality
    const rollback = await rollbackMigrationStep({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      step: step.step,
      backup,
      before: step.tables.map((t) => t.before),
    });
    expect(rollback.restored).toBe(true);
    expect(rollback.verified).toBe(true);
    expect(rollback.failures).toEqual([]);
    expect(fileSha256(liveStore)).toBe(fileSha256(backup.snapshotPath));
    expect(fileSha256(liveStore)).not.toBe(preRunBytes); // the backup is the pre-step state

    // Counts and content hashes equal the pre-step snapshot…
    const versionsRow = rollback.tables.find((t) => t.table === 'conduit_attachment_versions');
    expect(versionsRow?.countOk).toBe(true);
    expect(versionsRow?.hashOk).toBe(true);
    // …and the blob files the store references are intact.
    const blobPath = join(
      env.cleoDir,
      'blobs',
      'blobs',
      `blob-${contentHash(docContent(299)).slice(0, 16)}`,
    );
    expect(fileSha256(blobPath)).toBe(contentHash(docContent(299)));
  });
});
