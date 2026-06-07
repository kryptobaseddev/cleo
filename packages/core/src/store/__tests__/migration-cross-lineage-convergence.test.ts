/**
 * Regression tests for the cross-lineage journal-convergence OOM root fix (T11829).
 *
 * ## Root cause
 *
 * The consolidated `cleo.db` has ONE shared `__drizzle_migrations` journal but is
 * reconciled by MULTIPLE migration lineages (drizzle-tasks, drizzle-cleo-project,
 * drizzle-nexus, drizzle-brain, drizzle-conduit, drizzle-agent-registry). Before
 * this fix, each lineage's `reconcileJournal` built `localHashes` from ONLY its own
 * folder, so Sub-case B classified EVERY sibling lineage's journal rows as "true
 * orphans" and DELETEd them. The next sibling open then deleted THIS lineage's rows
 * — the journal NEVER converged (oscillated), every open re-thrashed the WAL writer
 * lock under busy_timeout=30000, and uncapped concurrent processes summed past host
 * RAM → OOM/SIGKILL. The live DB exhibited this: only the 2 nexus rows survived.
 *
 * ## What these tests lock
 *
 * 1. Two lineages reconciled SEQUENTIALLY against ONE shared journal — BOTH
 *    lineages' rows SURVIVE. (Without the union-guard fix this FAILS: the second
 *    lineage deletes the first lineage's rows as orphans.)
 * 2. A genuine TRUE orphan (a hash belonging to NO lineage) is still deleted —
 *    the fix must not make the journal a graveyard.
 * 3. The UNIQUE(hash) index + INSERT OR IGNORE makes a residual re-probe a no-op
 *    (idempotent convergence): re-running reconcile does not grow the journal.
 *
 * @task T11829
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve a drizzle migrations folder relative to this test file. */
function migFolder(setName: string): string {
  // Test lives at packages/core/src/store/__tests__/ ; migrations at packages/core/migrations/<set>
  return join(__dirname, '..', '..', '..', 'migrations', setName);
}

/**
 * Create the shared `__drizzle_migrations` journal table in the Drizzle v1-beta
 * shape (id/hash/created_at/name/applied_at) — the same DDL reconcileJournal
 * bootstraps.
 */
function createJournalTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `);
}

/** Insert every migration of a lineage folder into the journal as already-applied. */
function seedJournalWithLineage(db: DatabaseSync, folder: string): string[] {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.hash)) continue;
    seen.add(m.hash);
    db.exec(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${(m.name ?? '').replace(/'/g, "''")}')`,
    );
  }
  return [...seen];
}

/** Read all hashes currently in the journal. */
function journalHashes(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
    hash: string;
  }>;
  return new Set(rows.map((r) => r.hash));
}

describe('reconcileJournal — cross-lineage convergence (T11829 OOM root fix)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-xlineage-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('two lineages sharing ONE journal: BOTH lineages rows SURVIVE sequential reconciles', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');
    const projectFolder = migFolder('drizzle-cleo-project');

    // Hashes each lineage declares on disk.
    const tasksHashes = new Set(
      readMigrationFiles({ migrationsFolder: tasksFolder }).map((m) => m.hash),
    );
    const projectHashes = new Set(
      readMigrationFiles({ migrationsFolder: projectFolder }).map((m) => m.hash),
    );

    const dbPath = join(tempDir, 'shared-journal.db');
    const nativeDb = openNativeDatabase(dbPath);
    try {
      // The consolidated DB has both lineages' sentinel/existence tables.
      // `tasks` is the drizzle-tasks existence table; `tasks_tasks` is the
      // drizzle-cleo-project existence table. Both must exist so Scenario 2 fires.
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks_tasks" ("id" text PRIMARY KEY)');

      // One shared journal, seeded with BOTH lineages' rows (as a real
      // consolidated DB would have after both migration sets applied).
      createJournalTable(nativeDb);
      seedJournalWithLineage(nativeDb, tasksFolder);
      seedJournalWithLineage(nativeDb, projectFolder);

      const before = journalHashes(nativeDb);
      // Sanity: both lineages present before any reconcile.
      expect([...tasksHashes].every((h) => before.has(h))).toBe(true);
      expect([...projectHashes].every((h) => before.has(h))).toBe(true);

      // Reconcile lineage A (tasks) WITH the sibling set (the fix). Without the
      // union-guard this would delete every drizzle-cleo-project row as an orphan.
      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', [projectFolder]);

      const afterTasks = journalHashes(nativeDb);
      // The OTHER lineage's rows must survive the tasks reconcile.
      expect([...projectHashes].every((h) => afterTasks.has(h))).toBe(true);
      // This lineage's rows obviously survive too.
      expect([...tasksHashes].every((h) => afterTasks.has(h))).toBe(true);

      // Reconcile lineage B (project) WITH the sibling set. Symmetrically must not
      // delete the tasks rows.
      reconcileJournal(nativeDb, projectFolder, 'tasks_tasks', 'dual-scope-db[project]', [
        tasksFolder,
      ]);

      const afterProject = journalHashes(nativeDb);
      expect([...tasksHashes].every((h) => afterProject.has(h))).toBe(true);
      expect([...projectHashes].every((h) => afterProject.has(h))).toBe(true);
    } finally {
      nativeDb.close();
    }
  });

  it('Sub-case B: WITHOUT siblings a real sibling-lineage row IS deleted; WITH siblings it SURVIVES', async () => {
    // Drives the actual deletion path (Sub-case B) deterministically. Sub-case B
    // only fires when at least one of THIS lineage's local hashes is MISSING from
    // the journal (otherwise Sub-case A skips all deletion). We seed the journal
    // with: this lineage MINUS one hash (→ forces Sub-case B) + a single REAL
    // sibling-lineage hash. The sibling hash is a genuine drizzle-cleo-project
    // migration hash that has NO matching DDL in this bare DB, so the post-delete
    // re-probe cannot re-stamp it — making the deletion observable.
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');
    const projectFolder = migFolder('drizzle-cleo-project');

    const tasksMigrations = readMigrationFiles({ migrationsFolder: tasksFolder });
    const projectMigrations = readMigrationFiles({ migrationsFolder: projectFolder });
    // A real sibling hash whose DDL is NOT present in our bare DB (so it cannot be
    // re-stamped by the DDL re-probe after deletion).
    const siblingHash = projectMigrations[projectMigrations.length - 1]?.hash as string;
    expect(siblingHash).toBeTruthy();

    /** Build a DB in Sub-case B with this-lineage-minus-one + the sibling row. */
    const buildSubcaseB = (db: DatabaseSync): void => {
      db.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      createJournalTable(db);
      // Seed all tasks hashes EXCEPT the last one → at least one local hash is
      // missing from the journal → Sub-case B (true-orphan deletion) fires.
      const seen = new Set<string>();
      for (const m of tasksMigrations.slice(0, -1)) {
        if (seen.has(m.hash)) continue;
        seen.add(m.hash);
        db.exec(
          `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${(m.name ?? '').replace(/'/g, "''")}')`,
        );
      }
      // The sibling-lineage row that the cross-lineage guard must protect.
      db.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${siblingHash}', 1, 'sibling-project-row')`,
      );
    };

    // (a) WITHOUT siblings — the sibling row is an orphan and is DELETED.
    const dbNo = openNativeDatabase(join(tempDir, 'subcaseb-no-sib.db'));
    try {
      buildSubcaseB(dbNo);
      expect(journalHashes(dbNo).has(siblingHash)).toBe(true);
      reconcileJournal(dbNo, tasksFolder, 'tasks', 'sqlite'); // no siblings
      expect(journalHashes(dbNo).has(siblingHash)).toBe(false); // deleted → the bug
    } finally {
      dbNo.close();
    }

    // (b) WITH siblings — the same row is in the union and SURVIVES (the fix).
    const dbYes = openNativeDatabase(join(tempDir, 'subcaseb-with-sib.db'));
    try {
      buildSubcaseB(dbYes);
      expect(journalHashes(dbYes).has(siblingHash)).toBe(true);
      reconcileJournal(dbYes, tasksFolder, 'tasks', 'sqlite', [projectFolder]);
      expect(journalHashes(dbYes).has(siblingHash)).toBe(true); // survives → fixed
    } finally {
      dbYes.close();
    }
  });

  it('a GENUINE orphan (hash in no lineage) is still deleted even with siblings (Sub-case B)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');
    const projectFolder = migFolder('drizzle-cleo-project');
    const tasksMigrations = readMigrationFiles({ migrationsFolder: tasksFolder });

    const dbPath = join(tempDir, 'true-orphan.db');
    const nativeDb = openNativeDatabase(dbPath);
    try {
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      createJournalTable(nativeDb);
      // Seed all-but-one tasks hash → forces Sub-case B (otherwise Sub-case A skips
      // all deletion when every local hash is present).
      const seen = new Set<string>();
      for (const m of tasksMigrations.slice(0, -1)) {
        if (seen.has(m.hash)) continue;
        seen.add(m.hash);
        nativeDb.exec(
          `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${(m.name ?? '').replace(/'/g, "''")}')`,
        );
      }
      // A hash that belongs to NEITHER lineage — a true orphan with no DDL to
      // re-probe, so it must be permanently deleted.
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('deadbeef_not_any_lineage', 1, 'phantom')`,
      );
      expect(journalHashes(nativeDb).has('deadbeef_not_any_lineage')).toBe(true);

      // Reconcile WITH the sibling set. The true orphan is in no lineage's union,
      // so it must be deleted even though siblings are protected.
      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', [projectFolder]);

      const after = journalHashes(nativeDb);
      expect(after.has('deadbeef_not_any_lineage')).toBe(false);
    } finally {
      nativeDb.close();
    }
  });
});

describe('reconcileJournal — UNIQUE(hash) + INSERT OR IGNORE idempotency (T11829)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-idem-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a UNIQUE index on hash and a re-probe is a no-op (journal does not grow)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');

    const dbPath = join(tempDir, 'idempotent.db');
    const nativeDb = openNativeDatabase(dbPath);
    try {
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      createJournalTable(nativeDb);
      seedJournalWithLineage(nativeDb, tasksFolder);

      // First reconcile establishes the UNIQUE index.
      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', []);

      // The UNIQUE index must now exist.
      const idx = nativeDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_drizzle_migrations_hash'`,
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe('idx_drizzle_migrations_hash');

      const countAfterFirst = (
        nativeDb.prepare('SELECT COUNT(*) AS c FROM "__drizzle_migrations"').get() as { c: number }
      ).c;

      // Re-run reconcile twice more — the journal row count MUST be stable.
      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', []);
      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', []);

      const countAfterRepeat = (
        nativeDb.prepare('SELECT COUNT(*) AS c FROM "__drizzle_migrations"').get() as { c: number }
      ).c;
      expect(countAfterRepeat).toBe(countAfterFirst);
    } finally {
      nativeDb.close();
    }
  });

  it('INSERT OR IGNORE cannot create duplicate-hash rows once the UNIQUE index exists', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');
    const firstHash = readMigrationFiles({ migrationsFolder: tasksFolder })[0]?.hash;
    expect(firstHash).toBeTruthy();

    const dbPath = join(tempDir, 'no-dups.db');
    const nativeDb = openNativeDatabase(dbPath);
    try {
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      createJournalTable(nativeDb);
      seedJournalWithLineage(nativeDb, tasksFolder);

      reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', []);

      // Attempting a duplicate INSERT OR IGNORE for an existing hash is a no-op.
      nativeDb.exec(
        `INSERT OR IGNORE INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${firstHash}', 999, 'dup-attempt')`,
      );

      const dupCount = (
        nativeDb
          .prepare('SELECT COUNT(*) AS c FROM "__drizzle_migrations" WHERE hash = ?')
          .get(firstHash) as { c: number }
      ).c;
      expect(dupCount).toBe(1);
    } finally {
      nativeDb.close();
    }
  });

  it('one-time dedup collapses pre-existing duplicate-hash rows before the UNIQUE index is created', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const tasksFolder = migFolder('drizzle-tasks');
    const firstHash = readMigrationFiles({ migrationsFolder: tasksFolder })[0]?.hash as string;

    const dbPath = join(tempDir, 'pre-dups.db');
    const nativeDb = openNativeDatabase(dbPath);
    try {
      nativeDb.exec('CREATE TABLE IF NOT EXISTS "tasks" ("id" text PRIMARY KEY)');
      createJournalTable(nativeDb);
      // Seed a journal that ALREADY has a duplicate hash (a historically-thrashed
      // journal). CREATE UNIQUE INDEX would fail on this without the dedup pass.
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${firstHash}', 1, 'a'), ('${firstHash}', 2, 'b')`,
      );
      expect(
        (
          nativeDb
            .prepare('SELECT COUNT(*) AS c FROM "__drizzle_migrations" WHERE hash = ?')
            .get(firstHash) as { c: number }
        ).c,
      ).toBe(2);

      // reconcile must dedup, then create the UNIQUE index without throwing.
      expect(() => reconcileJournal(nativeDb, tasksFolder, 'tasks', 'sqlite', [])).not.toThrow();

      // Exactly one row remains for the duplicated hash; index exists.
      expect(
        (
          nativeDb
            .prepare('SELECT COUNT(*) AS c FROM "__drizzle_migrations" WHERE hash = ?')
            .get(firstHash) as { c: number }
        ).c,
      ).toBe(1);
      const idx = nativeDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_drizzle_migrations_hash'`,
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe('idx_drizzle_migrations_hash');
    } finally {
      nativeDb.close();
    }
  });
});
