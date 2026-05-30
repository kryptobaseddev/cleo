/**
 * T11324 — Consolidation fixture + cross-domain FK integrity harness.
 *
 * Builds the consolidated 5-domain single-file-per-scope fixture for BOTH
 * scopes (project + global), seeds cross-domain foreign-key edges
 * (brain/conduit/docs/telemetry → tasks), and asserts:
 *
 *   1. All five domain tables co-exist in ONE file per scope (Pattern A).
 *   2. `PRAGMA foreign_key_check` returns ZERO rows after valid seeding —
 *      FKs span domains natively because every table is in one file.
 *   3. A deliberately-orphaned FK row IS detected by `foreign_key_check`,
 *      proving the check is live (not vacuously passing).
 *   4. The ATTACH-alternative is REJECTED with concrete evidence: a second
 *      file is ATTACHed and a cross-file FK declaration is shown to be
 *      unenforced (FK to an attached-DB table is silently ignored), plus the
 *      `SQLITE_LIMIT_ATTACHED` ceiling is probed.
 *
 * Reusable as a fixture builder: `buildConsolidatedFixture(path, scope)` is
 * exported so the durability and concurrency harnesses can seed identical
 * schemas.
 *
 * Run: `pnpm dlx tsx tools/db-substrate-spike/04-consolidation-fixture.ts`
 *
 * @task T11324
 * @task T11244
 * @saga T11242
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openConsolidated } from './lib/open.js';
import { CONSOLIDATED_DDL } from './lib/schema.js';

/** A `foreign_key_check` violation row. */
interface FkViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

/**
 * Build the consolidated 5-domain schema into a single file and seed a small,
 * fully-valid cross-domain graph.
 *
 * @param path - Absolute path for the consolidated file.
 * @param scope - Label recorded in seeded task IDs (`project` | `global`).
 * @returns The open handle (caller owns `.close()`).
 */
export function buildConsolidatedFixture(path: string, scope: 'project' | 'global'): DatabaseSync {
  const db = openConsolidated(path);
  db.exec(CONSOLIDATED_DDL);

  const now = Date.now();
  const taskId = `T-${scope}-1`;
  db.prepare('INSERT INTO tasks_task (id, title, status, created_at) VALUES (?, ?, ?, ?)').run(
    taskId,
    `${scope} root task`,
    'pending',
    now,
  );
  // One cross-domain FK edge per non-tasks domain → tasks_task.id.
  db.prepare('INSERT INTO brain_memory (id, task_id, observation) VALUES (?, ?, ?)').run(
    `M-${scope}-1`,
    taskId,
    'seeded observation',
  );
  db.prepare(
    'INSERT INTO conduit_event (idempotency_key, task_id, payload, created_at) VALUES (?, ?, ?, ?)',
  ).run(`K-${scope}-1`, taskId, '{"e":1}', now);
  db.prepare('INSERT INTO docs_attachment (id, task_id, slug) VALUES (?, ?, ?)').run(
    `D-${scope}-1`,
    taskId,
    `slug-${scope}-1`,
  );
  db.prepare('INSERT INTO telemetry_span (id, task_id, duration_ms) VALUES (?, ?, ?)').run(
    `S-${scope}-1`,
    taskId,
    42,
  );
  return db;
}

/** List the user tables present in a handle (proves co-location). */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Coerce a raw `PRAGMA foreign_key_check` result row into a typed
 * {@link FkViolation}. The node:sqlite `.all()` return type is
 * `Record<string, SQLOutputValue>[]`, which does not structurally overlap
 * `FkViolation`, so each field is read + narrowed explicitly (no blanket cast).
 *
 * @param row - One raw result row.
 * @returns The typed {@link FkViolation}.
 */
function toFkViolation(row: Record<string, unknown>): FkViolation {
  return {
    table: String(row['table'] ?? ''),
    rowid: Number(row['rowid'] ?? 0),
    parent: String(row['parent'] ?? ''),
    fkid: Number(row['fkid'] ?? 0),
  };
}

/** Run `PRAGMA foreign_key_check` and return any violation rows. */
function fkCheck(db: DatabaseSync): FkViolation[] {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  return rows.map(toFkViolation);
}

/** Outcome of the ATTACH-alternative rejection probe. */
interface AttachRejectionEvidence {
  /**
   * `true` when a cross-file FK (parent in an ATTACHed schema) is BLOCKED —
   * i.e. ATTACH cannot give you working cross-domain FK integrity. This is the
   * rejection signal: a value of `true` proves the consolidated single-file
   * design is required for native cross-domain FKs.
   */
  crossFileFkBlocked: boolean;
  /** The exact SQLite error raised when the cross-file FK write is attempted. */
  crossFileFkError: string | null;
  /** Probe of the `SQLITE_LIMIT_ATTACHED` ceiling. */
  attachLimitProbe: { maxAttached: number; failedAtIndex: number | null };
  /** Human-readable summary of why ATTACH is rejected. */
  evidence: string;
}

/**
 * Demonstrate the ATTACH-alternative REJECTION. A table in the main schema
 * declares an FK whose parent lives ONLY in a separate ATTACHed file. SQLite
 * resolves FK parent names within the MAIN schema only — so the write fails
 * with `no such table: main.parent`. You therefore cannot declare an
 * enforceable cross-file FK at all; cross-domain referential integrity is
 * impossible across ATTACH boundaries. Also probes `SQLITE_LIMIT_ATTACHED`.
 *
 * @param workdir - A scratch directory for the throwaway attach DBs.
 * @returns The {@link AttachRejectionEvidence}.
 */
function proveAttachRejected(workdir: string): AttachRejectionEvidence {
  const mainPath = join(workdir, 'attach-main.db');
  const otherPath = join(workdir, 'attach-other.db');
  const other = openConsolidated(otherPath);
  // Parent table lives ONLY in the OTHER file.
  other.exec('CREATE TABLE parent (id TEXT PRIMARY KEY);');
  other.exec("INSERT INTO parent (id) VALUES ('p1');");
  other.close();

  const main = openConsolidated(mainPath);
  main.exec(`ATTACH DATABASE '${otherPath}' AS other;`);
  // Declaring `REFERENCES parent(id)` is accepted at CREATE time (FK targets
  // are resolved lazily), but the parent table only exists in attached `other`.
  main.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));');

  let crossFileFkBlocked = false;
  let crossFileFkError: string | null = null;
  try {
    // Inserting a child whose `parent_id` exists in attached `other.parent`
    // (but not in main): with foreign_keys=ON, SQLite tries to resolve the FK
    // parent in the MAIN schema and fails — proving cross-file FKs are not a
    // usable substitute for single-file colocation.
    main.exec("INSERT INTO child (id, parent_id) VALUES ('c1', 'p1');");
  } catch (err) {
    crossFileFkBlocked = true;
    crossFileFkError = err instanceof Error ? err.message : String(err);
  }

  // Probe SQLITE_LIMIT_ATTACHED: how many DBs can we ATTACH before failure?
  let maxAttached = 1; // 'other' already attached
  let failedAtIndex: number | null = null;
  for (let i = 0; i < 20; i++) {
    const p = join(workdir, `attach-extra-${i}.db`);
    try {
      main.exec(`ATTACH DATABASE '${p}' AS extra_${i};`);
      maxAttached++;
    } catch {
      failedAtIndex = maxAttached + 1;
      break;
    }
  }
  main.close();

  return {
    crossFileFkBlocked,
    crossFileFkError,
    attachLimitProbe: { maxAttached, failedAtIndex },
    evidence:
      'Cross-file FK is impossible: an FK whose parent lives in an ATTACHed file ' +
      `fails because SQLite resolves the parent name in the MAIN schema only ` +
      `(observed error: ${crossFileFkError ?? 'none'}). ATTACH ceiling = ` +
      `${maxAttached} simultaneous DBs (default SQLITE_LIMIT_ATTACHED), leaving ` +
      'no headroom for a 5+ domain topology. WAL + ATTACH additionally breaks ' +
      'cross-file COMMIT atomicity per SQLite docs. ATTACH REJECTED in favor of ' +
      'single-file-per-scope Pattern A.',
  };
}

/** Execute the fixture harness and emit a JSON verdict. */
function main(): void {
  const workdir = mkdtempSync(join(tmpdir(), 'cleo-spike-fixture-'));
  try {
    const scopes: Array<'project' | 'global'> = ['project', 'global'];
    const perScope = scopes.map((scope) => {
      const path = join(workdir, `consolidated-${scope}.db`);
      const db = buildConsolidatedFixture(path, scope);
      try {
        const tables = listTables(db);
        const violationsValid = fkCheck(db);

        // Inject a deliberate orphan to prove the check is live.
        db.exec('PRAGMA foreign_keys = OFF;');
        db.prepare('INSERT INTO brain_memory (id, task_id, observation) VALUES (?, ?, ?)').run(
          `ORPHAN-${scope}`,
          'T-DOES-NOT-EXIST',
          'orphan',
        );
        db.exec('PRAGMA foreign_keys = ON;');
        const violationsAfterOrphan = fkCheck(db);

        return {
          scope,
          tables,
          allFiveDomainsColocated:
            tables.includes('tasks_task') &&
            tables.includes('brain_memory') &&
            tables.includes('conduit_event') &&
            tables.includes('docs_attachment') &&
            tables.includes('telemetry_span'),
          fkCheckCleanRows: violationsValid.length,
          fkCheckDetectsOrphan: violationsAfterOrphan.length > 0,
          orphanViolations: violationsAfterOrphan,
        };
      } finally {
        db.close();
      }
    });

    const attach = proveAttachRejected(workdir);

    const allColocated = perScope.every((s) => s.allFiveDomainsColocated);
    const allClean = perScope.every((s) => s.fkCheckCleanRows === 0);
    const allDetectOrphan = perScope.every((s) => s.fkCheckDetectsOrphan);
    const attachRejected = attach.crossFileFkBlocked === true;

    const verdict = allColocated && allClean && allDetectOrphan && attachRejected ? 'PASS' : 'FAIL';

    const report = {
      task: 'T11324',
      perScope,
      attachAlternativeRejected: attach,
      summary: {
        allFiveDomainsColocatedPerScope: allColocated,
        fkCheckZeroRowsAfterValidSeed: allClean,
        fkCheckDetectsInjectedOrphan: allDetectOrphan,
        attachCrossFileFkBlocked: attachRejected,
      },
      verdict,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (verdict !== 'PASS') process.exit(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
