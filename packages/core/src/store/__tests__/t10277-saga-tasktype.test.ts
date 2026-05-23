/**
 * T10329 (Saga T10326 W1.B / Epic T10277) — saga TaskType migration regression lock.
 *
 * Validates the invariants of `20260523213708_t10277-saga-tasktype`:
 *
 *   1. Forward migration adds a CHECK constraint on `tasks.type` enumerating
 *      ('saga','epic','task','subtask') and an I5 CHECK enforcing
 *      `type != 'saga' OR parent_id IS NULL` (ADR-073 §1.2 I5).
 *   2. Rows matching the pre-T10329 saga encoding (`type='epic' AND
 *      parent_id IS NULL AND 'saga' IN labels_json`) are flipped to
 *      `type='saga'` AND the 'saga' label is stripped from labels_json.
 *   3. Re-applying the migration is a no-op (idempotent).
 *   4. The revert script restores byte-identical row state for fixtures
 *      that seed 'saga' as the first label (the conventional encoding).
 *   5. The new CHECK on `(type='saga' implies parent_id IS NULL)` rejects
 *      inserts that violate I5 at the storage layer.
 *
 * @task T10329
 * @epic T10277
 * @saga T10326
 * @see .cleo/adrs/ADR-083-saga-as-tasktype.md §2.5
 * @see .cleo/adrs/ADR-073-above-epic-naming.md §1.2 I5
 * @see packages/core/migrations/drizzle-tasks/20260523213708_t10277-saga-tasktype/
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_DIR = '20260523213708_t10277-saga-tasktype';

function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function readSql(name: 'migration.sql' | 'revert.sql'): string {
  return readFileSync(join(migrationsDir(), MIGRATION_DIR, name), 'utf-8');
}

function runStatements(nativeDb: import('node:sqlite').DatabaseSync, sql: string): void {
  const statements = sql.split('--> statement-breakpoint');
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    nativeDb.exec(trimmed);
  }
}

/**
 * Materialise the pre-T10329 `tasks` schema by hand. We model only the
 * columns + constraints that exist at the post-T1899 baseline; this
 * mirrors what a freshly-applied migration chain produces up to (but
 * not including) T10329.
 *
 * The `sessions` table is needed for the FK reference to compile; we
 * elide its full shape because the migration does not touch it.
 *
 * @internal
 */
function applyPreT10329Schema(dbPath: string): import('node:sqlite').DatabaseSync {
  const nativeDb = new DatabaseSync(dbPath);
  // Sessions stub — minimum for the FK target to exist.
  nativeDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE tasks (
      id text PRIMARY KEY,
      title text NOT NULL,
      description text,
      status text DEFAULT 'pending' NOT NULL,
      priority text DEFAULT 'medium' NOT NULL,
      type text,
      parent_id text,
      phase text,
      size text,
      position integer,
      position_version integer DEFAULT 0,
      labels_json text DEFAULT '[]',
      notes_json text DEFAULT '[]',
      acceptance_json text DEFAULT '[]',
      files_json text DEFAULT '[]',
      origin text,
      blocked_by text,
      epic_lifecycle text,
      no_auto_complete integer,
      created_at text DEFAULT (datetime('now')) NOT NULL,
      updated_at text,
      completed_at text,
      cancelled_at text,
      cancellation_reason text,
      archived_at text,
      archive_reason text CHECK (
        archive_reason IS NULL OR archive_reason IN (
          'verified','reconciled','superseded','shadowed','cancelled','completed-unverified'
        )
      ),
      cycle_time_days integer,
      verification_json text,
      created_by text,
      modified_by text,
      session_id text,
      pipeline_stage text,
      assignee text,
      ivtr_state text,
      role TEXT NOT NULL DEFAULT 'work'
        CHECK (role IN ('work','research','experiment','bug','spike','release')),
      scope TEXT NOT NULL DEFAULT 'feature'
        CHECK (scope IN ('project','feature','unit')),
      severity TEXT
        CHECK (severity IS NULL OR severity IN ('P0','P1','P2','P3')),
      CONSTRAINT fk_tasks_parent_id FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE SET NULL,
      CONSTRAINT fk_tasks_session_id FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );
  `);
  return nativeDb;
}

type SagaSeed = {
  id: string;
  title: string;
  labels: string[];
};

/**
 * Seed five canonical saga rows in the pre-T10329 encoding:
 *   type='epic', parent_id=NULL, labels_json starts with 'saga'.
 *
 * Putting 'saga' at index 0 lets the revert (which PREPENDs the saga
 * label) restore byte-identical labels_json.
 */
const SAGA_FIXTURES: ReadonlyArray<SagaSeed> = [
  { id: 'SG-001', title: 'Saga One', labels: ['saga'] },
  { id: 'SG-002', title: 'Saga Two', labels: ['saga', 'arch'] },
  { id: 'SG-003', title: 'Saga Three', labels: ['saga', 'arch', 'foundation'] },
  { id: 'SG-004', title: 'Saga Four', labels: ['saga', 'release-theme'] },
  { id: 'SG-005', title: 'Saga Five', labels: ['saga', 'a', 'b', 'c'] },
];

/** Non-saga control rows that must round-trip untouched. */
const CONTROL_FIXTURES = [
  {
    id: 'E-001',
    title: 'Plain Epic',
    type: 'epic',
    parent_id: null,
    labels: ['foundation'],
  },
  {
    id: 'T-001',
    title: 'Plain Task',
    type: 'task',
    parent_id: 'E-001',
    labels: ['work'],
  },
  // An epic that happens to be a CHILD epic — must NOT be promoted to saga
  // even if it has 'saga' in its labels (parent_id is non-null).
  {
    id: 'E-002',
    title: 'Child Epic with stray saga label',
    type: 'epic',
    parent_id: 'E-001',
    labels: ['saga', 'misc'],
  },
] as const;

function seedFixtures(nativeDb: import('node:sqlite').DatabaseSync): void {
  // Insert in order — children reference parents, so parents first.
  const insert = nativeDb.prepare(`
    INSERT INTO tasks (id, title, type, parent_id, labels_json, status, priority, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 'medium', '2026-05-23T00:00:00Z')
  `);
  // Sagas (no parent).
  for (const s of SAGA_FIXTURES) {
    insert.run(s.id, s.title, 'epic', null, JSON.stringify(s.labels));
  }
  // Controls — order matters for FK: E-001 first.
  for (const c of CONTROL_FIXTURES) {
    insert.run(c.id, c.title, c.type, c.parent_id, JSON.stringify(c.labels));
  }
}

type Snapshot = Map<string, Record<string, unknown>>;

/**
 * Capture every column of every row in `tasks`, keyed by id. Used to
 * compare pre-migration vs post-revert state for byte-identical assertion.
 */
function snapshotTasks(nativeDb: import('node:sqlite').DatabaseSync): Snapshot {
  const rows = nativeDb.prepare('SELECT * FROM tasks ORDER BY id').all() as Array<
    Record<string, unknown>
  >;
  const out: Snapshot = new Map();
  for (const r of rows) {
    out.set(String(r.id), { ...r });
  }
  return out;
}

describe('T10329 saga TaskType migration', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10329-mig-'));
    nativeDb = applyPreT10329Schema(join(tempDir, 'tasks.db'));
    seedFixtures(nativeDb);
  });

  afterEach(() => {
    try {
      nativeDb.close();
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('forward: promotes label-encoded sagas to type=saga + strips the saga label', () => {
    runStatements(nativeDb, readSql('migration.sql'));

    for (const s of SAGA_FIXTURES) {
      const row = nativeDb
        .prepare('SELECT type, labels_json, parent_id FROM tasks WHERE id = ?')
        .get(s.id) as { type: string; labels_json: string; parent_id: string | null };
      expect(row.type).toBe('saga');
      expect(row.parent_id).toBeNull();
      const labels = JSON.parse(row.labels_json) as string[];
      expect(labels).not.toContain('saga');
      // The non-saga labels must be preserved verbatim in original order.
      const expectedRest = s.labels.filter((l) => l !== 'saga');
      expect(labels).toEqual(expectedRest);
    }
  });

  it('forward: leaves non-saga rows untouched (controls)', () => {
    runStatements(nativeDb, readSql('migration.sql'));

    const e1 = nativeDb
      .prepare('SELECT type, labels_json, parent_id FROM tasks WHERE id = ?')
      .get('E-001') as { type: string; labels_json: string; parent_id: string | null };
    expect(e1.type).toBe('epic');
    expect(JSON.parse(e1.labels_json)).toEqual(['foundation']);
    expect(e1.parent_id).toBeNull();

    const t1 = nativeDb
      .prepare('SELECT type, labels_json, parent_id FROM tasks WHERE id = ?')
      .get('T-001') as { type: string; labels_json: string; parent_id: string | null };
    expect(t1.type).toBe('task');
    expect(JSON.parse(t1.labels_json)).toEqual(['work']);
    expect(t1.parent_id).toBe('E-001');

    // Child epic with a stray 'saga' label MUST NOT be promoted because it
    // has a non-null parent_id. The label is also preserved (we only strip
    // it from genuine promotions).
    const e2 = nativeDb
      .prepare('SELECT type, labels_json, parent_id FROM tasks WHERE id = ?')
      .get('E-002') as { type: string; labels_json: string; parent_id: string | null };
    expect(e2.type).toBe('epic');
    expect(JSON.parse(e2.labels_json)).toEqual(['saga', 'misc']);
    expect(e2.parent_id).toBe('E-001');
  });

  it('round-trip: up then down restores byte-identical row state', () => {
    const before = snapshotTasks(nativeDb);

    runStatements(nativeDb, readSql('migration.sql'));
    // Sanity — sagas are promoted in the middle state.
    expect(
      (
        nativeDb.prepare("SELECT COUNT(*) AS n FROM tasks WHERE type = 'saga'").get() as {
          n: number;
        }
      ).n,
    ).toBe(SAGA_FIXTURES.length);

    runStatements(nativeDb, readSql('revert.sql'));
    const after = snapshotTasks(nativeDb);

    expect(after.size).toBe(before.size);
    for (const [id, beforeRow] of before) {
      const afterRow = after.get(id);
      expect(afterRow, `row ${id} missing post-revert`).toBeDefined();
      // Every column must match byte-for-byte.
      expect(afterRow).toEqual(beforeRow);
    }
  });

  it('idempotent: re-running the forward migration is a no-op', () => {
    runStatements(nativeDb, readSql('migration.sql'));
    const afterFirst = snapshotTasks(nativeDb);

    // Drizzle would skip the table rebuild on replay (journal hash match);
    // we cannot rerun the CREATE TABLE __new_tasks because tasks already
    // has the new shape. Test instead that the DATA-mutation steps (3+4)
    // are individually idempotent: applying just those statements again
    // must not change any row.
    const sql = readSql('migration.sql');
    // Extract only the saga-promotion UPDATEs (Step 3 + Step 4). After
    // splitting on the statement breakpoint marker, each chunk contains
    // a leading SQL-comment block (`-- ── Step N …`) followed by the
    // actual DML. We strip comment lines before pattern-matching.
    const stripComments = (s: string): string =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
    const dataMutations = sql
      .split('--> statement-breakpoint')
      .map(stripComments)
      .filter((s) => /^UPDATE\s+`tasks`/i.test(s))
      .join(';\n');
    expect(dataMutations).toContain("SET `type` = 'saga'");
    expect(dataMutations).toContain('labels_json');

    nativeDb.exec(dataMutations);
    const afterSecond = snapshotTasks(nativeDb);

    expect(afterSecond.size).toBe(afterFirst.size);
    for (const [id, firstRow] of afterFirst) {
      expect(afterSecond.get(id)).toEqual(firstRow);
    }
  });

  it('I5 CHECK: rejects insert of type=saga with non-null parent_id', () => {
    runStatements(nativeDb, readSql('migration.sql'));

    // Seed a candidate parent first so the FK target exists.
    nativeDb.exec(`
      INSERT INTO tasks (id, title, type, parent_id, status, priority, created_at)
      VALUES ('SG-PARENT', 'parent saga', 'saga', NULL, 'pending', 'medium', '2026-05-23');
    `);

    // Attempting to insert a saga with a non-null parent_id must fail the
    // I5 CHECK constraint.
    expect(() => {
      nativeDb.exec(`
        INSERT INTO tasks (id, title, type, parent_id, status, priority, created_at)
        VALUES ('SG-CHILD', 'illegal child saga', 'saga', 'SG-PARENT', 'pending', 'medium', '2026-05-23');
      `);
    }).toThrow(/CHECK constraint failed.*chk_tasks_saga_no_parent|CHECK constraint failed/i);
  });

  it('ENUM CHECK: rejects insert of type with an unknown value', () => {
    runStatements(nativeDb, readSql('migration.sql'));

    expect(() => {
      nativeDb.exec(`
        INSERT INTO tasks (id, title, type, parent_id, status, priority, created_at)
        VALUES ('X-001', 'bogus', 'kanban', NULL, 'pending', 'medium', '2026-05-23');
      `);
    }).toThrow(/CHECK constraint failed/i);
  });

  it('ENUM CHECK: permits NULL type (legacy compatibility)', () => {
    runStatements(nativeDb, readSql('migration.sql'));

    // Some rows historically have NULL type — the CHECK allows that.
    expect(() => {
      nativeDb.exec(`
        INSERT INTO tasks (id, title, type, parent_id, status, priority, created_at)
        VALUES ('LEGACY-001', 'no type', NULL, NULL, 'pending', 'medium', '2026-05-23');
      `);
    }).not.toThrow();
  });

  it('forward: tolerates malformed labels_json without aborting', () => {
    // Insert a saga-candidate with malformed labels (json_valid returns 0).
    // The migration's json_valid() guard must skip it rather than fail.
    nativeDb.exec(`
      INSERT INTO tasks (id, title, type, parent_id, labels_json, status, priority, created_at)
      VALUES ('BAD-001', 'malformed labels', 'epic', NULL, 'not-json{{', 'pending', 'medium', '2026-05-23');
    `);

    expect(() => runStatements(nativeDb, readSql('migration.sql'))).not.toThrow();

    const row = nativeDb
      .prepare('SELECT type, labels_json FROM tasks WHERE id = ?')
      .get('BAD-001') as { type: string; labels_json: string };
    // Type stays 'epic' (the guard skipped it); labels_json preserved verbatim.
    expect(row.type).toBe('epic');
    expect(row.labels_json).toBe('not-json{{');
  });
});

// Migration files are read via fs at runtime so changes to the SQL are
// always picked up by this test without rebuilding.
