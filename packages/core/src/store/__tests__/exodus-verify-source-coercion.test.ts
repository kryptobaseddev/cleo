/**
 * AC2 regression guard — `verifyMigration` digests the SOURCE side through the
 * SAME value transforms `runExodusMigrate` applied, so equal logical data
 * digests EQUAL (`hashMatch === true`) on a coerced column (T11809).
 *
 * ## The bug this proves fixed
 *
 * The migration TRANSFORMS source values before they land in the consolidated
 * `cleo.db`: epoch-INTEGER timestamps → ISO-8601 TEXT (for ISO-GLOB target
 * columns), legacy enum aliases → canonical members, `Inf`/`-Inf`/`NaN` →
 * finite. Before T11809 the parity verifier digested the RAW source value
 * (integer `1717200000`) against the TRANSFORMED target value (ISO
 * `'2024-06-01T…'`), so every coerced column reported `hashMatch === false`
 * even on a perfectly lossless migration. That false-negative aborted the
 * exodus cutover and lost the writes accumulated during the migrating open —
 * the exact mechanism behind the reported nexus/signaldock "row drop".
 *
 * ## What this test asserts
 *
 *   (a) A source table with BOTH an epoch-INTEGER column mapped to an ISO-GLOB
 *       target AND a legacy enum-drift column migrates with
 *       `rowsCopied === sourceCount` (zero deficit — AC1).
 *   (b) `verifyMigration` returns `ok === true` AND `hashMatch === true` for
 *       that equal data — the digest now reflects the canonical (transformed)
 *       values on both sides (AC2).
 *
 * @task T11809 (exodus verify applies source-side coercion — hashMatch on equal data)
 * @epic T11249 (E6)
 * @saga T11242
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExodusPlan, LegacyDbDescriptor } from '../exodus/types.js';
import { verifyMigration } from '../exodus/verify-migration.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; open?: boolean },
  ) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// runExodusMigrate (FIX D) opens the TARGET DBs on a dedicated connection via
// openDualScopeDbAtPath — wire it to the pre-built fixture handles.
vi.mock('../dual-scope-db.js', () => ({
  openDualScopeDb: vi.fn(),
  openDualScopeDbAtPath: vi.fn(),
  resolveDualScopeDbPath: vi.fn(),
}));

/** ISO-8601 GLOB pattern the production CHECK constraints use (T11363). */
const ISO_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

const SOURCE_ROWS = 24;

/**
 * Seed a legacy `tasks.db` whose `architecture_decisions` table carries BOTH:
 *   - `decided_at` epoch-INTEGER (seconds + milliseconds mixed) → an ISO-GLOB
 *     `decided_at` target column (the exact real nexus/signaldock coercion shape
 *     — epoch INTEGER → ISO TEXT), and
 *   - `status` already-CANONICAL enum values that the consolidated CHECK accepts
 *     verbatim. They are present to prove the enum-normalize code path does not
 *     break the source-side digest, NOT to exercise enum DRIFT (which is a
 *     separate, pre-existing diagnostic gate orthogonal to the AC2 hashMatch
 *     coercion this test targets).
 */
function buildSource(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `CREATE TABLE "architecture_decisions" (id INTEGER PRIMARY KEY, status TEXT, decided_at INTEGER)`,
    );
    // All canonical members of the target CHECK enum — no drift.
    const statuses = ['accepted', 'proposed', 'superseded', 'deprecated'];
    for (let i = 1; i <= SOURCE_ROWS; i++) {
      const s = statuses[i % statuses.length];
      // Alternate seconds (≈1.7e9) and milliseconds (≈1.7e12) so the per-row
      // magnitude heuristic is exercised on both branches.
      const epoch = i % 2 === 0 ? 1_717_200_000 + i : 1_717_200_000_000 + i * 1000;
      db.exec(`INSERT INTO "architecture_decisions" VALUES (${i}, '${s}', ${epoch})`);
    }
  } finally {
    db.close();
  }
}

/**
 * Build the consolidated TARGET with the REAL CHECK + ISO-GLOB constraints the
 * production `tasks_architecture_decisions` declares.
 */
function buildTarget(projectPath: string, globalPath: string): void {
  const db = new DatabaseSync(projectPath);
  try {
    db.exec(
      `CREATE TABLE "tasks_architecture_decisions" (
        id INTEGER PRIMARY KEY,
        status TEXT CHECK ("status" IN ('accepted', 'proposed', 'superseded', 'deprecated')),
        decided_at TEXT CHECK ("decided_at" IS NULL OR "decided_at" GLOB ${ISO_GLOB})
      )`,
    );
  } finally {
    db.close();
  }
  new DatabaseSync(globalPath).close();
}

/**
 * Seed a legacy `tasks.db` whose `architecture_decisions` carries BOTH an
 * epoch-INTEGER `decided_at` (→ ISO-GLOB target) AND a `status` column with
 * legacy enum DRIFT aliases (`'Accepted'`/`'ACCEPTED'`/`'approved'`) that the
 * migration NORMALISES to `'accepted'`. Exercises the AC1 invariant
 * (`rowsCopied === sourceCount` despite both coercion classes) + the AC2
 * hashMatch on the coerced+normalized column.
 */
function buildDriftSource(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `CREATE TABLE "architecture_decisions" (id INTEGER PRIMARY KEY, status TEXT, decided_at INTEGER)`,
    );
    const statuses = ['accepted', 'Accepted', 'ACCEPTED', 'approved', 'proposed', 'superseded'];
    for (let i = 1; i <= SOURCE_ROWS; i++) {
      const s = statuses[i % statuses.length];
      const epoch = i % 2 === 0 ? 1_717_200_000 + i : 1_717_200_000_000 + i * 1000;
      db.exec(`INSERT INTO "architecture_decisions" VALUES (${i}, '${s}', ${epoch})`);
    }
  } finally {
    db.close();
  }
}

describe('exodus verify source-side coercion (T11809 · AC2)', () => {
  let tmpDir: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-exodus-coercion-'));
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('epoch-coerced table: rowsCopied==sourceCount (AC1) AND verify hashMatch=true (AC2)', async () => {
    const tasksDbPath = join(tmpDir, 'tasks.db');
    const projectDbPath = join(tmpDir, 'cleo-project.db');
    const globalDbPath = join(tmpDir, 'cleo-global.db');
    buildSource(tasksDbPath);
    buildTarget(projectDbPath, globalDbPath);

    const projectDb = new DatabaseSync(projectDbPath);
    const globalDb = new DatabaseSync(globalDbPath);
    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open for assertions */
      },
    });

    const dualScope = await import('../dual-scope-db.js');
    vi.mocked(dualScope.openDualScopeDbAtPath).mockImplementation(
      (scope: string, dbPath: string) => {
        const native = dbPath === globalDbPath || scope === 'global' ? globalDb : projectDb;
        return Promise.resolve(makeFakeHandle(native) as never);
      },
    );
    vi.mocked(dualScope.resolveDualScopeDbPath).mockImplementation((scope: string) =>
      scope === 'project' ? projectDbPath : globalDbPath,
    );

    const { runExodusMigrate } = await import('../exodus/migrate.js');

    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: tasksDbPath, targetScope: 'project' },
    ];
    const plan: ExodusPlan = {
      sources,
      totalSourceBytes: 0,
      largestSourceBytes: 0,
      requiredBytes: 0,
      stagingCopyThresholdBytes: 256 * 1024 * 1024,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath,
      globalDbPath,
    };

    const migrateResult = await runExodusMigrate(plan, false, undefined);
    expect(migrateResult.ok, migrateResult.error ?? '').toBe(true);

    // AC1: zero deficit — every source row landed despite epoch + enum coercion.
    const decisions = migrateResult.tables.find(
      (t) => t.sourceDb === 'tasks' && t.tableName === 'architecture_decisions',
    );
    expect(decisions, 'architecture_decisions copy result missing').toBeDefined();
    expect(decisions?.skipped).toBe(false);
    expect(decisions?.reason, 'no row-drop reason expected').toBeUndefined();
    expect(decisions?.rowsCopied).toBe(SOURCE_ROWS);

    const targetCount = (
      projectDb.prepare(`SELECT COUNT(*) AS c FROM "tasks_architecture_decisions"`).get() as {
        c: number;
      }
    ).c;
    expect(targetCount).toBe(SOURCE_ROWS);

    // AC2: verify confirms ok AND hashMatch=true — the source digest now reflects
    // the SAME canonical (epoch→ISO, enum-normalized) values the target stores.
    const verify = verifyMigration(sources, projectDbPath, globalDbPath);
    expect(verify.ok, verify.error ?? '').toBe(true);
    expect(verify.enumDrift).toHaveLength(0);

    const entry = verify.tables.find((t) => t.targetTable === 'tasks_architecture_decisions');
    expect(entry, 'verify entry for tasks_architecture_decisions missing').toBeDefined();
    expect(entry?.sourceCount).toBe(SOURCE_ROWS);
    expect(entry?.targetCount).toBe(SOURCE_ROWS);
    expect(entry?.countMatch, 'count parity').toBe(true);
    // The crux of T11809: BEFORE the fix this was FALSE (raw epoch/enum source vs
    // coerced target). AFTER the fix the source is digested through the same
    // transforms, so equal data digests equal.
    expect(entry?.hashMatch, 'hashMatch on equal coerced data').toBe(true);

    projectDb.close();
    globalDb.close();
  });

  it('a GENUINE content drift on a coerced column still fails hashMatch (no over-masking)', async () => {
    // Same fixture, but corrupt ONE target enum value AFTER migration so the
    // canonical values genuinely diverge. The source-side transform must NOT
    // mask a real content difference.
    const tasksDbPath = join(tmpDir, 'tasks.db');
    const projectDbPath = join(tmpDir, 'cleo-project.db');
    const globalDbPath = join(tmpDir, 'cleo-global.db');
    buildSource(tasksDbPath);
    buildTarget(projectDbPath, globalDbPath);

    const projectDb = new DatabaseSync(projectDbPath);
    const globalDb = new DatabaseSync(globalDbPath);
    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open */
      },
    });
    const dualScope = await import('../dual-scope-db.js');
    vi.mocked(dualScope.openDualScopeDbAtPath).mockImplementation(
      (scope: string, dbPath: string) => {
        const native = dbPath === globalDbPath || scope === 'global' ? globalDb : projectDb;
        return Promise.resolve(makeFakeHandle(native) as never);
      },
    );
    vi.mocked(dualScope.resolveDualScopeDbPath).mockImplementation((scope: string) =>
      scope === 'project' ? projectDbPath : globalDbPath,
    );

    const { runExodusMigrate } = await import('../exodus/migrate.js');
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: tasksDbPath, targetScope: 'project' },
    ];
    const plan: ExodusPlan = {
      sources,
      totalSourceBytes: 0,
      largestSourceBytes: 0,
      requiredBytes: 0,
      stagingCopyThresholdBytes: 256 * 1024 * 1024,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath,
      globalDbPath,
    };
    const migrateResult = await runExodusMigrate(plan, false, undefined);
    expect(migrateResult.ok, migrateResult.error ?? '').toBe(true);

    // Corrupt one target row's status to a DIFFERENT canonical value (still
    // passes the CHECK) so the content genuinely differs from the source.
    projectDb.exec(`UPDATE "tasks_architecture_decisions" SET status = 'deprecated' WHERE id = 1`);

    const verify = verifyMigration(sources, projectDbPath, globalDbPath);
    const entry = verify.tables.find((t) => t.targetTable === 'tasks_architecture_decisions');
    expect(entry?.countMatch).toBe(true);
    // Genuine content drift on a coerced column is NOT masked by the transform.
    expect(entry?.hashMatch).toBe(false);
    expect(verify.ok).toBe(false);

    projectDb.close();
    globalDb.close();
  });

  it('epoch + ENUM-DRIFT column: rowsCopied==sourceCount (AC1) AND coerced+normalized hashMatch=true (AC2)', async () => {
    // Source carries BOTH an epoch-INTEGER column (→ ISO-GLOB target) AND legacy
    // enum DRIFT aliases ('Accepted'/'ACCEPTED'/'approved') that migrate
    // NORMALISES to 'accepted'. This is the task's exact AC1 shape. The enumDrift
    // DIAGNOSTIC (a separate, pre-existing gate) reports the raw source aliases,
    // so verify.ok is expected to be false — but the AC1 zero-deficit invariant
    // and the AC2 per-table hashMatch (source digested through the SAME
    // epoch→ISO + enum-normalize transforms) both hold.
    const tasksDbPath = join(tmpDir, 'tasks.db');
    const projectDbPath = join(tmpDir, 'cleo-project.db');
    const globalDbPath = join(tmpDir, 'cleo-global.db');
    buildDriftSource(tasksDbPath);
    buildTarget(projectDbPath, globalDbPath);

    const projectDb = new DatabaseSync(projectDbPath);
    const globalDb = new DatabaseSync(globalDbPath);
    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open */
      },
    });
    const dualScope = await import('../dual-scope-db.js');
    vi.mocked(dualScope.openDualScopeDbAtPath).mockImplementation(
      (scope: string, dbPath: string) => {
        const native = dbPath === globalDbPath || scope === 'global' ? globalDb : projectDb;
        return Promise.resolve(makeFakeHandle(native) as never);
      },
    );
    vi.mocked(dualScope.resolveDualScopeDbPath).mockImplementation((scope: string) =>
      scope === 'project' ? projectDbPath : globalDbPath,
    );

    const { runExodusMigrate } = await import('../exodus/migrate.js');
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: tasksDbPath, targetScope: 'project' },
    ];
    const plan: ExodusPlan = {
      sources,
      totalSourceBytes: 0,
      largestSourceBytes: 0,
      requiredBytes: 0,
      stagingCopyThresholdBytes: 256 * 1024 * 1024,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath,
      globalDbPath,
    };
    const migrateResult = await runExodusMigrate(plan, false, undefined);
    expect(migrateResult.ok, migrateResult.error ?? '').toBe(true);

    // AC1: zero deficit — every source row landed despite epoch + enum coercion.
    const decisions = migrateResult.tables.find(
      (t) => t.sourceDb === 'tasks' && t.tableName === 'architecture_decisions',
    );
    expect(decisions?.skipped).toBe(false);
    expect(decisions?.reason).toBeUndefined();
    expect(decisions?.rowsCopied).toBe(SOURCE_ROWS);
    const targetCount = (
      projectDb.prepare(`SELECT COUNT(*) AS c FROM "tasks_architecture_decisions"`).get() as {
        c: number;
      }
    ).c;
    expect(targetCount).toBe(SOURCE_ROWS);

    const verify = verifyMigration(sources, projectDbPath, globalDbPath);

    // AC2: the per-table content digest MATCHES — the source side was digested
    // through the same epoch→ISO + enum-normalize transforms the target stores.
    const entry = verify.tables.find((t) => t.targetTable === 'tasks_architecture_decisions');
    expect(entry?.countMatch).toBe(true);
    expect(entry?.hashMatch, 'hashMatch on coerced + normalized data').toBe(true);

    // The enum-drift DIAGNOSTIC still flags the raw source aliases (a separate,
    // pre-existing gate orthogonal to the AC2 hashMatch coercion). This documents
    // that interaction — it is NOT a row deficit.
    const drift = verify.enumDrift.find(
      (d) => d.targetTable === 'tasks_architecture_decisions' && d.column === 'status',
    );
    expect(drift, 'enum-drift diagnostic still reports raw source aliases').toBeDefined();

    projectDb.close();
    globalDb.close();
  });
});
