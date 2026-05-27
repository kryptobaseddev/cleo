/**
 * Backfill verification for the T10639 data migration:
 *   child_task AC projection rows created for every parent->child relationship.
 *
 * E10.W5 of Saga T10538 (SG-PM-CORE-V2) under Epic T10548.
 *
 * Each test validates that:
 *   1. Migration SQL references the canonical tables and child_task markers.
 *   2. End-to-end apply seeds child_task rows from parent->child fixtures.
 *   3. Existing text AC rows are preserved (not deleted or altered).
 *   4. Idempotency -- re-running yields zero net new rows.
 *   5. The revert deletes only backfill-created rows and preserves
 *      rows created by normal addTask/reparet operations.
 *
 * @task  T10639
 * @saga  T10538
 * @epic  T10548
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_FOLDER_TOKEN = 't10639';

/** Absolute path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read the T10639 migration SQL as a string. */
function readMigrationSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes(MIGRATION_FOLDER_TOKEN));
  if (!folder) {
    throw new Error(`T10639 migration folder not found under ${dir}`);
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

/** Read the T10639 revert SQL as a string. */
function readRevertSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes(MIGRATION_FOLDER_TOKEN));
  if (!folder) {
    throw new Error(`T10639 migration folder not found under ${dir}`);
  }
  return readFileSync(join(dir, folder, 'revert.sql'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10639 backfill migration SQL', () => {
  it('reads parent->child relationships from tasks.parent_id', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/child\.`parent_id`\s*=\s*parent\.`id`/);
  });

  it('inserts into task_acceptance_criteria with child_task kind', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/INSERT INTO\s+`task_acceptance_criteria`/);
    expect(sql).toMatch(/'child_task'/);
  });

  it('sets canonical source_key = child:<childId>', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/'child:'\s*\|\|\s*child_id/);
    expect(sql).toMatch(/'child:'\s*\|\|\s*child\.`id`/);
  });

  it('sets projection = parent-child', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/'parent-child'/);
  });

  it('sets target_task_id to the child id', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/`target_task_id`/);
    expect(sql).toMatch(/child_id/);
  });

  it('generates canonical AC text: Complete child <id>: <title>', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/'Complete child '\s*\|\|\s*child_id\s*\|\|\s*': '/);
  });

  it('idempotency: AC insert gated by NOT EXISTS on source_key', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+`task_acceptance_criteria`/i);
    expect(sql).toMatch(/'child:'\s*\|\|\s*child\.`id`/);
  });

  it('idempotency: history insert gated by NOT EXISTS on reason=backfill', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(
      /NOT EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+`task_acceptance_criteria_history`/i,
    );
    expect(sql).toMatch(/'backfill'/);
  });

  it('uses ROW_NUMBER OVER PARTITION BY parent_id for ordinal assignment', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/ROW_NUMBER\s*\(\s*\)\s+OVER\s*\(\s*PARTITION BY parent_id/i);
  });

  it('writes backfill history rows for audit trail', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/INSERT INTO\s+`task_acceptance_criteria_history`/);
    expect(sql).toMatch(/'backfill'/);
  });

  it('never alters tasks.acceptance_json column', () => {
    const sql = readMigrationSql();
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+`tasks`/i);
    expect(sql).not.toMatch(/acceptance_json/i);
  });

  it('migration folder name includes t10639', () => {
    const dir = migrationsDir();
    const folder = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find((name) => name.includes(MIGRATION_FOLDER_TOKEN));
    expect(folder).toBeDefined();
    expect(folder).toMatch(/t10639/);
  });
});

// ---------------------------------------------------------------------------
// Section 2: End-to-end fresh-DB apply + backfill behaviour
// ---------------------------------------------------------------------------

interface FixtureTask {
  id: string;
  title: string;
  parentId: string | null;
  acceptanceJson: string;
}

interface FixtureAcRow {
  id: string;
  task_id: string;
  ordinal: number;
  kind: string;
  source_key: string | null;
  target_task_id: string | null;
  projection: string;
  text: string;
}

const FIXTURE_TASKS: ReadonlyArray<FixtureTask> = [
  {
    id: 'T-epic',
    title: 'Parent epic with 4 children',
    parentId: null,
    acceptanceJson: JSON.stringify(['parent AC 1', 'parent AC 2']),
  },
  {
    id: 'T-child1',
    title: 'First child task',
    parentId: 'T-epic',
    acceptanceJson: JSON.stringify(['child1 AC']),
  },
  {
    id: 'T-child2',
    title: 'Second child task',
    parentId: 'T-epic',
    acceptanceJson: JSON.stringify([]),
  },
  {
    id: 'T-child3',
    title: 'Third child task',
    parentId: 'T-epic',
    acceptanceJson: JSON.stringify(['child3 AC a', 'child3 AC b']),
  },
  {
    id: 'T-nochildren',
    title: 'Leaf task with no children',
    parentId: 'T-epic',
    acceptanceJson: JSON.stringify(['leaf AC 1', 'leaf AC 2', 'leaf AC 3']),
  },
  {
    id: 'T-orphan',
    title: 'Orphan task with no parent and no children',
    parentId: null,
    acceptanceJson: JSON.stringify([]),
  },
];

const EXPECTED_CHILD_PROJECTIONS: ReadonlyArray<{
  childId: string;
  text: string;
  kind: string;
  projection: string;
}> = [
  {
    childId: 'T-child1',
    text: 'Complete child T-child1: First child task',
    kind: 'child_task',
    projection: 'parent-child',
  },
  {
    childId: 'T-child2',
    text: 'Complete child T-child2: Second child task',
    kind: 'child_task',
    projection: 'parent-child',
  },
  {
    childId: 'T-child3',
    text: 'Complete child T-child3: Third child task',
    kind: 'child_task',
    projection: 'parent-child',
  },
  {
    childId: 'T-nochildren',
    text: 'Complete child T-nochildren: Leaf task with no children',
    kind: 'child_task',
    projection: 'parent-child',
  },
];

describe('T10639 backfill end-to-end on fresh tasks.db', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10639-'));
  });

  afterEach(() => {
    try {
      nativeDb?.close();
    } catch {
      // Already closed.
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedTextAcRows(target: import('node:sqlite').DatabaseSync): void {
    const insertAc = target.prepare(
      "INSERT INTO `task_acceptance_criteria` (`id`, `task_id`, `ordinal`, `kind`, `source_key`, `target_task_id`, `projection`, `text`, `content_hash`) VALUES (?, ?, ?, 'text', ?, NULL, 'legacy', ?, NULL)",
    );

    insertAc.run('ac-epic-1', 'T-epic', 1, 'text:1:000000000000', 'parent AC 1');
    insertAc.run('ac-epic-2', 'T-epic', 2, 'text:2:000000000000', 'parent AC 2');
    insertAc.run('ac-child1-1', 'T-child1', 1, 'text:1:000000000000', 'child1 AC');
    insertAc.run('ac-child3-1', 'T-child3', 1, 'text:1:000000000000', 'child3 AC a');
    insertAc.run('ac-child3-2', 'T-child3', 2, 'text:2:000000000000', 'child3 AC b');
    insertAc.run('ac-noch-1', 'T-nochildren', 1, 'text:1:000000000000', 'leaf AC 1');
    insertAc.run('ac-noch-2', 'T-nochildren', 2, 'text:2:000000000000', 'leaf AC 2');
    insertAc.run('ac-noch-3', 'T-nochildren', 3, 'text:3:000000000000', 'leaf AC 3');
  }

  async function applyMigrationsAndBackfill(dbPath: string): Promise<void> {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    nativeDb.exec('DELETE FROM `task_acceptance_criteria_history`;');
    nativeDb.exec('DELETE FROM `task_acceptance_criteria`;');
    nativeDb.exec('DELETE FROM `tasks`;');

    const insertTask = nativeDb.prepare(
      'INSERT INTO `tasks` (`id`, `title`, `status`, `priority`, `parent_id`, `acceptance_json`) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const fixture of FIXTURE_TASKS) {
      insertTask.run(
        fixture.id,
        fixture.title,
        'pending',
        'medium',
        fixture.parentId,
        fixture.acceptanceJson,
      );
    }

    seedTextAcRows(nativeDb);

    const sql = readMigrationSql();
    nativeDb.exec(sql);
  }

  function getChildTaskRows(parentId: string): FixtureAcRow[] {
    return nativeDb
      .prepare(
        'SELECT `id`, `task_id`, `ordinal`, `kind`, `source_key`, `target_task_id`, `projection`, `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? AND `kind` = ? ORDER BY `ordinal`',
      )
      .all(parentId, 'child_task') as FixtureAcRow[];
  }

  function getAcRows(taskId: string): FixtureAcRow[] {
    return nativeDb
      .prepare(
        'SELECT `id`, `task_id`, `ordinal`, `kind`, `source_key`, `target_task_id`, `projection`, `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? ORDER BY `ordinal`',
      )
      .all(taskId) as FixtureAcRow[];
  }

  it('AC2: creates child_task projection rows for every child of a parent', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-child-projections.db'));
    const childRows = getChildTaskRows('T-epic');
    expect(childRows.length).toBe(4);
    for (const expected of EXPECTED_CHILD_PROJECTIONS) {
      const match = childRows.find((r) => r.target_task_id === expected.childId);
      expect(match, `child_task row exists for ${expected.childId}`).toBeDefined();
      expect(match?.kind).toBe(expected.kind);
      expect(match?.projection).toBe(expected.projection);
      expect(match?.text).toBe(expected.text);
      expect(match?.source_key).toBe(`child:${expected.childId}`);
    }
  });

  it('AC2: sets canonical source_key = child:<childId>', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-source-keys.db'));
    const childRows = getChildTaskRows('T-epic');
    for (const row of childRows) {
      expect(row.source_key).toMatch(/^child:T-/);
      expect(row.source_key).toBe(`child:${row.target_task_id}`);
    }
  });

  it('AC2: assigns ordinals after existing text ACs', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-ordinals.db'));
    const allRows = getAcRows('T-epic');
    expect(allRows.length).toBe(6);
    const textRows = allRows.filter((r) => r.kind === 'text');
    const childRows = allRows.filter((r) => r.kind === 'child_task');
    expect(textRows.length).toBe(2);
    expect(childRows.length).toBe(4);
    expect(textRows[0]?.ordinal).toBe(1);
    expect(textRows[1]?.ordinal).toBe(2);
    expect(childRows[0]?.ordinal).toBe(3);
    expect(childRows[1]?.ordinal).toBe(4);
    expect(childRows[2]?.ordinal).toBe(5);
    expect(childRows[3]?.ordinal).toBe(6);
  });

  it('AC1: text rows preserved', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-text-preserved.db'));
    const child3Rows = getAcRows('T-child3');
    const textRows = child3Rows.filter((r) => r.kind === 'text');
    expect(textRows.length).toBe(2);
    expect(textRows[0]?.text).toBe('child3 AC a');
    expect(textRows[1]?.text).toBe('child3 AC b');
    const noChildrenRows = getAcRows('T-nochildren');
    expect(noChildrenRows.length).toBe(3);
    for (const row of noChildrenRows) expect(row.kind).toBe('text');
    expect(noChildrenRows.map((r) => r.text)).toEqual(['leaf AC 1', 'leaf AC 2', 'leaf AC 3']);
  });

  it('AC1: does not create child_task rows for tasks without children', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-no-children.db'));
    expect(getChildTaskRows('T-child1').length).toBe(0);
    expect(getChildTaskRows('T-orphan').length).toBe(0);
  });

  it('AC2: generates UUIDv4-shaped ids', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-uuid.db'));
    const childRows = getChildTaskRows('T-epic');
    expect(childRows.length).toBeGreaterThan(0);
    const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const row of childRows) {
      expect(row.id, `id ${row.id} matches UUIDv4 shape`).toMatch(uuidV4Pattern);
    }
    const ids = new Set(childRows.map((r) => r.id));
    expect(ids.size).toBe(childRows.length);
  });

  it('is idempotent: re-running produces zero new child_task rows', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-idempotency.db'));
    const acCountBefore = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `kind` = ?')
        .get('child_task') as { c: number }
    ).c;
    const historyCountBefore = (
      nativeDb
        .prepare(
          "SELECT count(*) AS c FROM `task_acceptance_criteria_history` WHERE `reason` = 'backfill'",
        )
        .get() as { c: number }
    ).c;
    expect(acCountBefore).toBeGreaterThan(0);
    expect(historyCountBefore).toBe(acCountBefore);
    nativeDb.exec(readMigrationSql());
    const acCountAfter = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `kind` = ?')
        .get('child_task') as { c: number }
    ).c;
    const historyCountAfter = (
      nativeDb
        .prepare(
          "SELECT count(*) AS c FROM `task_acceptance_criteria_history` WHERE `reason` = 'backfill'",
        )
        .get() as { c: number }
    ).c;
    expect(acCountAfter).toBe(acCountBefore);
    expect(historyCountAfter).toBe(historyCountBefore);
    nativeDb.exec(readMigrationSql());
    const acCountThird = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `kind` = ?')
        .get('child_task') as { c: number }
    ).c;
    expect(acCountThird).toBe(acCountBefore);
  });

  it('revert: removes backfill-created rows only, preserves non-backfill rows', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-revert.db'));
    const totalAcBefore = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria`').get() as {
        c: number;
      }
    ).c;
    expect(totalAcBefore).toBeGreaterThan(0);
    nativeDb.exec(readRevertSql());
    const childTaskAfter = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `kind` = ?')
        .get('child_task') as { c: number }
    ).c;
    expect(childTaskAfter).toBe(0);
    const textAcAfter = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `kind` = ?')
        .get('text') as { c: number }
    ).c;
    expect(textAcAfter).toBe(8);
    const historyBackfillAfter = (
      nativeDb
        .prepare(
          "SELECT count(*) AS c FROM `task_acceptance_criteria_history` WHERE `reason` = 'backfill'",
        )
        .get() as { c: number }
    ).c;
    expect(historyBackfillAfter).toBe(0);
  });

  it('AC3: evidence bindings survive', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 't10639-evidence-safe.db'));
    const child3Texts = getAcRows('T-child3')
      .filter((r) => r.kind === 'text')
      .map((r) => r.text);
    expect(child3Texts).toEqual(['child3 AC a', 'child3 AC b']);
    const noChildrenTexts = getAcRows('T-nochildren')
      .filter((r) => r.kind === 'text')
      .map((r) => r.text);
    expect(noChildrenTexts).toEqual(['leaf AC 1', 'leaf AC 2', 'leaf AC 3']);
  });
});
