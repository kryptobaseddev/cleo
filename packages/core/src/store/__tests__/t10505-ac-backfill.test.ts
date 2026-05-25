/**
 * Backfill verification for the T10505 data migration:
 *   `task_acceptance_criteria` populated from legacy `tasks.acceptance_json`.
 *
 * Wave 2b of Epic T10381 (E-AC-MIGRATION) under Saga T10377
 * (SG-IVTR-AC-BINDING). PR 4 of 8 in the AC-binding migration train.
 *
 * Each test validates that:
 *   1. Migration SQL content references the canonical inputs/outputs
 *      and contains the documented idempotency + whitespace guards.
 *   2. End-to-end fresh-DB apply seeds rows from a representative
 *      `acceptance_json` fixture (mixed shapes: text-only, object-form,
 *      whitespace-only, empty, malformed, NULL).
 *   3. Idempotency — re-running the entire migration suite from the
 *      same data folder yields zero net new rows (per AC2).
 *   4. Ordinal assignment is 1-based and preserves JSON array order.
 *   5. History rows are created with `reason='backfill'` for each
 *      backfilled AC and the `previous_text` matches the AC text
 *      (per AC3).
 *   6. Whitespace-only and empty-string array elements are skipped
 *      with no AC rows created (per AC4 + AC5).
 *   7. Empty/null `acceptance_json` produces zero AC rows (per AC4).
 *   8. The legacy `tasks.acceptance_json` column survives the
 *      migration intact (per AC7).
 *
 * @adr  ADR-079-r1 §2.1 §2.2 §D6
 * @task T10505
 * @epic T10381
 * @saga T10377
 * @decision D013
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

const MIGRATION_FOLDER_TOKEN = 't10505';

/** Absolute path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read the T10505 migration SQL as a string. */
function readMigrationSql(): string {
  const dir = migrationsDir();
  const folder = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .find((name) => name.includes(MIGRATION_FOLDER_TOKEN));
  if (!folder) {
    throw new Error(`T10505 migration folder not found under ${dir}`);
  }
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks
// ---------------------------------------------------------------------------

describe('T10505 backfill migration SQL', () => {
  it('reads from tasks.acceptance_json', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/`acceptance_json`/);
    expect(sql).toMatch(/json_each\s*\(/);
  });

  it('inserts into task_acceptance_criteria', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/INSERT INTO\s+`task_acceptance_criteria`/);
  });

  it('inserts backfill rows into task_acceptance_criteria_history', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/INSERT INTO\s+`task_acceptance_criteria_history`/);
    expect(sql).toMatch(/'backfill'/);
  });

  it('idempotency: AC insert is gated by NOT EXISTS', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+`task_acceptance_criteria`/i);
  });

  it('idempotency: history insert is gated by NOT EXISTS on reason=backfill', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(
      /NOT EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+`task_acceptance_criteria_history`/i,
    );
  });

  it('uses ROW_NUMBER OVER PARTITION BY task_id for ordinal assignment', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/ROW_NUMBER\s*\(\s*\)\s+OVER\s*\(\s*PARTITION BY/i);
  });

  it('guards malformed acceptance_json via CASE-wrapped json_each input', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/json_valid/i);
    expect(sql).toMatch(/json_type/i);
  });

  it('skips whitespace-only entries via trim and WHERE ac_text != ""', () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/trim\s*\(/i);
    expect(sql).toMatch(/ac_text\s*!=\s*''/);
  });

  it('NEVER alters or drops tasks.acceptance_json (AC7)', () => {
    const sql = readMigrationSql();
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+`?tasks`?[\s\S]*acceptance_json/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+`?acceptance_json`?/i);
  });
});

// ---------------------------------------------------------------------------
// Section 2: End-to-end fresh-DB apply + backfill behaviour
// ---------------------------------------------------------------------------

/**
 * Representative `acceptance_json` fixture covering every shape the
 * backfill is expected to handle. Inserted BEFORE the migration runs
 * so the AC table is empty at backfill-time (matching production
 * upgrade conditions).
 */
const FIXTURE_TASKS: ReadonlyArray<{
  id: string;
  title: string;
  acceptanceJson: string | null;
  expectedAcCount: number;
  expectedTexts: ReadonlyArray<string>;
}> = [
  {
    id: 'T-multi',
    title: 'multiple plain-text ACs',
    acceptanceJson: JSON.stringify(['first AC', 'second AC', 'third AC']),
    expectedAcCount: 3,
    expectedTexts: ['first AC', 'second AC', 'third AC'],
  },
  {
    id: 'T-single',
    title: 'single AC',
    acceptanceJson: JSON.stringify(['only AC']),
    expectedAcCount: 1,
    expectedTexts: ['only AC'],
  },
  {
    id: 'T-object',
    title: 'object-form ACs with criteria field',
    acceptanceJson: JSON.stringify([{ criteria: 'object AC one' }, { criteria: 'object AC two' }]),
    expectedAcCount: 2,
    expectedTexts: ['object AC one', 'object AC two'],
  },
  {
    id: 'T-mixed',
    title: 'mixed string + object',
    acceptanceJson: JSON.stringify(['plain AC', { criteria: 'object AC' }]),
    expectedAcCount: 2,
    expectedTexts: ['plain AC', 'object AC'],
  },
  {
    id: 'T-whitespace',
    title: 'whitespace-only entries interleaved with valid ones',
    acceptanceJson: JSON.stringify(['  ', '\t\n', 'real AC', '']),
    expectedAcCount: 1,
    expectedTexts: ['real AC'],
  },
  {
    id: 'T-empty-array',
    title: 'empty acceptance_json array',
    acceptanceJson: JSON.stringify([]),
    expectedAcCount: 0,
    expectedTexts: [],
  },
  {
    id: 'T-null',
    title: 'NULL acceptance_json',
    acceptanceJson: null,
    expectedAcCount: 0,
    expectedTexts: [],
  },
  {
    id: 'T-malformed',
    title: 'malformed acceptance_json (not valid JSON)',
    acceptanceJson: 'this is not JSON',
    expectedAcCount: 0,
    expectedTexts: [],
  },
  {
    id: 'T-trim',
    title: 'AC text that needs trimming',
    acceptanceJson: JSON.stringify(['  padded  ', '\nnewlines\n']),
    expectedAcCount: 2,
    expectedTexts: ['padded', 'newlines'],
  },
];

describe('T10505 backfill end-to-end on fresh tasks.db', () => {
  let tempDir: string;
  let nativeDb: import('node:sqlite').DatabaseSync;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10505-'));
  });

  afterEach(() => {
    try {
      nativeDb?.close();
    } catch {
      // Already closed.
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Apply only the schema-creation migrations (NOT T10505 itself),
   * seed the fixture, then apply T10505. This matches the production
   * upgrade path: legacy data exists, schema migrations run, backfill
   * is the final step.
   *
   * Note: drizzle-orm's `migrate()` applies ALL pending migrations in
   * one shot, so we cannot interleave seeding mid-stream. Instead we
   * apply the full set, then manually clear AC rows + seed the source
   * tasks + re-run the backfill SQL — which is what production looks
   * like when a fresh-install user later upgrades to a CLEO version
   * that already had legacy `acceptance_json` data.
   *
   * To simulate the realistic "schema-then-backfill" sequence we
   * (a) run all migrations, (b) DELETE the AC + history rows that the
   * backfill produced from any test-fixture or empty source, (c) seed
   * the fixture tasks, (d) re-execute the backfill SQL directly. Step
   * (d) tests the SQL itself; the journal already records T10505 as
   * applied, so a re-`migrate()` call would be a no-op.
   */
  async function applyMigrationsAndBackfill(dbPath: string): Promise<void> {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // The migrate() call above already executed T10505 against an
    // empty tasks table — there were no rows to backfill. Clear out
    // any artefacts and seed the fixture.
    nativeDb.exec('DELETE FROM `task_acceptance_criteria_history`;');
    nativeDb.exec('DELETE FROM `task_acceptance_criteria`;');
    nativeDb.exec('DELETE FROM `tasks`;');

    const insertTask = nativeDb.prepare(
      'INSERT INTO `tasks` (`id`, `title`, `status`, `priority`, `acceptance_json`) VALUES (?, ?, ?, ?, ?)',
    );
    for (const fixture of FIXTURE_TASKS) {
      insertTask.run(fixture.id, fixture.title, 'pending', 'medium', fixture.acceptanceJson);
    }

    // Re-apply just the T10505 backfill SQL by reading the file
    // directly. This is what we are actually testing.
    const sql = readMigrationSql();
    nativeDb.exec(sql);
  }

  it('creates AC rows for every non-empty, non-whitespace acceptance_json entry', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-ac-rows.db'));

    for (const fixture of FIXTURE_TASKS) {
      const rows = nativeDb
        .prepare(
          'SELECT `id`, `task_id`, `ordinal`, `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? ORDER BY `ordinal`',
        )
        .all(fixture.id) as Array<{ id: string; task_id: string; ordinal: number; text: string }>;

      expect(rows.length, `${fixture.id} (${fixture.title}) AC count`).toBe(
        fixture.expectedAcCount,
      );
      expect(
        rows.map((r) => r.text),
        `${fixture.id} (${fixture.title}) AC texts`,
      ).toEqual([...fixture.expectedTexts]);
    }
  });

  it('assigns ordinals 1,2,3,... per task preserving JSON array order (AC1)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-ordinals.db'));

    const multiAc = nativeDb
      .prepare(
        'SELECT `ordinal`, `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? ORDER BY `ordinal`',
      )
      .all('T-multi') as Array<{ ordinal: number; text: string }>;

    expect(multiAc).toEqual([
      { ordinal: 1, text: 'first AC' },
      { ordinal: 2, text: 'second AC' },
      { ordinal: 3, text: 'third AC' },
    ]);
  });

  it('generates a UUIDv4-shaped id per AC row (AC1)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-uuid.db'));

    const rows = nativeDb.prepare('SELECT `id` FROM `task_acceptance_criteria`').all() as Array<{
      id: string;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const row of rows) {
      expect(row.id, `id ${row.id} matches UUIDv4 shape`).toMatch(uuidV4Pattern);
    }

    // Uniqueness across the AC table.
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });

  it('records a backfill history row per AC with previous_text matching the AC text (AC3)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-history.db'));

    const acRows = nativeDb
      .prepare('SELECT `id`, `text` FROM `task_acceptance_criteria`')
      .all() as Array<{ id: string; text: string }>;
    const historyRows = nativeDb
      .prepare(
        "SELECT `ac_id`, `previous_text`, `reason` FROM `task_acceptance_criteria_history` WHERE `reason` = 'backfill'",
      )
      .all() as Array<{ ac_id: string; previous_text: string; reason: string }>;

    expect(historyRows.length).toBe(acRows.length);

    // Every AC has exactly one matching history row with previous_text = ac.text.
    const histByAc = new Map(historyRows.map((h) => [h.ac_id, h]));
    for (const ac of acRows) {
      const hist = histByAc.get(ac.id);
      expect(hist, `history row exists for AC ${ac.id}`).toBeDefined();
      expect(hist?.previous_text).toBe(ac.text);
      expect(hist?.reason).toBe('backfill');
    }
  });

  it('is idempotent: re-running the SQL yields zero new rows (AC2)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-idempotency.db'));

    const acCountBefore = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria`').get() as {
        c: number;
      }
    ).c;
    const historyCountBefore = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria_history`').get() as {
        c: number;
      }
    ).c;

    expect(acCountBefore).toBeGreaterThan(0);
    expect(historyCountBefore).toBe(acCountBefore);

    // Re-run the same backfill SQL.
    const sql = readMigrationSql();
    nativeDb.exec(sql);

    const acCountAfter = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria`').get() as {
        c: number;
      }
    ).c;
    const historyCountAfter = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria_history`').get() as {
        c: number;
      }
    ).c;

    expect(acCountAfter).toBe(acCountBefore);
    expect(historyCountAfter).toBe(historyCountBefore);

    // A third application also stays stable.
    nativeDb.exec(sql);
    const acCountThird = (
      nativeDb.prepare('SELECT count(*) AS c FROM `task_acceptance_criteria`').get() as {
        c: number;
      }
    ).c;
    expect(acCountThird).toBe(acCountBefore);
  });

  it('skips whitespace-only and empty-string entries (AC5)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-whitespace.db'));

    const whitespaceTaskAcs = nativeDb
      .prepare(
        'SELECT `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? ORDER BY `ordinal`',
      )
      .all('T-whitespace') as Array<{ text: string }>;

    // Only the single "real AC" entry should survive — the three
    // whitespace-only/empty siblings are dropped.
    expect(whitespaceTaskAcs.length).toBe(1);
    expect(whitespaceTaskAcs[0]?.text).toBe('real AC');
  });

  it('skips NULL and empty acceptance_json (AC4)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-empty.db'));

    const nullCount = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `task_id` = ?')
        .get('T-null') as { c: number }
    ).c;
    const emptyCount = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `task_id` = ?')
        .get('T-empty-array') as { c: number }
    ).c;
    const malformedCount = (
      nativeDb
        .prepare('SELECT count(*) AS c FROM `task_acceptance_criteria` WHERE `task_id` = ?')
        .get('T-malformed') as { c: number }
    ).c;

    expect(nullCount).toBe(0);
    expect(emptyCount).toBe(0);
    expect(malformedCount).toBe(0);
  });

  it('preserves the legacy tasks.acceptance_json column (AC7)', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-preserve.db'));

    // The column still exists.
    const cols = nativeDb.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('acceptance_json');

    // The legacy values are intact for every fixture row.
    for (const fixture of FIXTURE_TASKS) {
      const row = nativeDb
        .prepare('SELECT `acceptance_json` FROM `tasks` WHERE `id` = ?')
        .get(fixture.id) as { acceptance_json: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.acceptance_json).toBe(fixture.acceptanceJson);
    }
  });

  it('trims surrounding whitespace from preserved AC text', async () => {
    await applyMigrationsAndBackfill(join(tempDir, 'tasks-trim.db'));

    const trimTaskAcs = nativeDb
      .prepare(
        'SELECT `text` FROM `task_acceptance_criteria` WHERE `task_id` = ? ORDER BY `ordinal`',
      )
      .all('T-trim') as Array<{ text: string }>;

    expect(trimTaskAcs).toEqual([{ text: 'padded' }, { text: 'newlines' }]);
  });
});
