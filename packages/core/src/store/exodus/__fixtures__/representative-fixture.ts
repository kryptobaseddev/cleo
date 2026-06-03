/**
 * SCHEMA-REAL representative migration fixture (T11551 · DHQ-045 · AC3).
 *
 * The exodus zero-loss campaign happened because the original unit fixtures
 * used MATCHING NAMES + canonical enums (`CREATE TABLE x (id, val)`), so they
 * missed every real-schema failure: epoch-INTEGER timestamps in a `text`+GLOB
 * column, legacy enum aliases failing a CHECK, and unprefixed→prefixed table
 * names. This module builds a fixture that reproduces those exact hazards so
 * the migration is exercised against representative data — NOT a name-matched
 * toy.
 *
 * The fixture builds two legacy source DBs (`tasks.db`, `brain.db`) whose
 * tables carry:
 *
 *   - **Unprefixed names** that must map to domain-prefixed targets
 *     (`tasks` → `tasks_tasks`, `architecture_decisions` →
 *     `tasks_architecture_decisions`).
 *   - **Epoch-INTEGER timestamps** (seconds AND milliseconds) destined for a
 *     TASKS-domain target `text` column with an ISO-8601 GLOB CHECK constraint.
 *   - **Legacy enum aliases** (`'Accepted'`, `'mcp'`) that fail the TASKS-domain
 *     target CHECK unless the migration normalises them.
 *   - **A self-referential FK** (`tasks.parent_id → tasks.id`) copied
 *     child-before-parent to exercise the FK-defer path.
 *
 * The matching consolidated TASKS-domain target schemas are built with the REAL
 * CHECK and GLOB constraints the production schema declares, so a regression in
 * the coercion/normalisation layer surfaces as a row deficit caught by
 * {@link verifyMigration}.
 *
 * **Brain domain (T11647):** the consolidated `brain_*` target now matches the
 * LEGACY RUNTIME shape — INTEGER epoch-ms timestamps and NO SQL CHECK
 * constraints. So the fixture's `brain_observations` target carries no `type`
 * CHECK and an INTEGER `created_at`: every legacy `type` value (`'observation'`,
 * `'proposal'`, `'pattern'`) and the raw epoch-ms timestamp copy through VERBATIM
 * — zero coercion, zero deficit. This is what proves the brain data-loss /
 * corruption fix end-to-end against representative data.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard · AC3)
 * @epic T10878
 * @saga T11242
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; open?: boolean },
  ) => DatabaseSyncType;
};

/** ISO-8601 GLOB pattern the production CHECK constraints use (T11363). */
const ISO_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

/**
 * The number of base-table rows the fixture seeds per (source) table.
 * Exposed so the CI runner can assert an exact post-migration row count.
 *
 * @public
 */
export const FIXTURE_EXPECTED_ROWS = {
  tasks_tasks: 30,
  tasks_architecture_decisions: 12,
  tasks_token_usage: 25,
  brain_observations: 40,
} as const;

/**
 * Options for {@link buildRepresentativeFixture} that inject the derived/internal
 * + pre-existing-orphan hazards the T11572 parity-gate fixes guard. Default off
 * so the base zero-loss parity test is unaffected.
 *
 * @public
 */
export interface RepresentativeFixtureOptions {
  /**
   * When `true`, the legacy `brain.db` source also gets a real FTS5 virtual
   * table (`brain_decisions_fts` + its `_data/_idx/_docsize/_config` shadow
   * tables) and the `_conduit_meta` / `_conduit_migrations` internal bookkeeping
   * tables — none of which have a consolidated counterpart. A correct migration
   * SKIPS them (no N→0 deficit). The consolidated target schema additionally
   * gains a `brain_decisions` base table so the FTS source has real base data.
   * (T11572 BLOCKER 1.)
   */
  readonly withDerivedAndInternalTables?: boolean;
  /**
   * When `true`, the legacy `tasks.db` source gets a `task_relations` table
   * carrying a PRE-EXISTING FK orphan (a row referencing a `tasks.id` that does
   * not exist — like the real `tasks_task_relations` rows pointing at deleted
   * tasks). The same orphan is faithfully copied to the target (zero loss); the
   * parity gate must TOLERATE it. (T11572 BLOCKER 2.)
   */
  readonly withPreExistingSourceOrphan?: boolean;
}

/**
 * Base-table rows for the optional hazard tables (only seeded when the matching
 * {@link RepresentativeFixtureOptions} flag is set). Exposed so a test that
 * enables the hazards can assert exact parity on them too.
 *
 * @public
 */
export const FIXTURE_HAZARD_EXPECTED_ROWS = {
  /** brain_decisions base rows (content table behind the FTS5 index). */
  brain_decisions: 20,
  /** task_relations rows: 4 clean + 2 pre-existing orphans = 6. */
  tasks_task_relations: 6,
} as const;

/**
 * Build the legacy `tasks.db` source fixture with representative drift.
 *
 * @param path - Absolute path for the legacy tasks source DB.
 * @param opts - Optional hazard injection (T11572).
 */
function buildTasksSource(path: string, opts: RepresentativeFixtureOptions = {}): void {
  const db = new DatabaseSync(path);
  try {
    // --- tasks (unprefixed → tasks_tasks) with a self-referential FK + epoch ms ---
    db.exec(
      `CREATE TABLE "tasks" (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER
      )`,
    );
    // Insert child rows BEFORE parents to exercise the FK-defer path.
    for (let i = FIXTURE_EXPECTED_ROWS.tasks_tasks; i >= 1; i--) {
      const parent = i > 1 ? `'T${i - 1}'` : 'NULL';
      // created_at in epoch MILLISECONDS (e.g. 1_717_200_000_000)
      const ms = 1_717_200_000_000 + i * 1000;
      db.exec(`INSERT INTO "tasks" VALUES ('T${i}', 'task ${i}', ${parent}, ${ms})`);
    }

    // --- architecture_decisions with legacy enum aliases for status ---
    db.exec(
      `CREATE TABLE "architecture_decisions" (id INTEGER PRIMARY KEY, status TEXT, decided_at INTEGER)`,
    );
    const statuses = ['accepted', 'Accepted', 'ACCEPTED', 'approved', 'proposed', 'superseded'];
    for (let i = 1; i <= FIXTURE_EXPECTED_ROWS.tasks_architecture_decisions; i++) {
      const s = statuses[i % statuses.length];
      // decided_at in epoch SECONDS (e.g. 1_717_200_000)
      const sec = 1_717_200_000 + i;
      db.exec(`INSERT INTO "architecture_decisions" VALUES (${i}, '${s}', ${sec})`);
    }

    // --- token_usage with legacy 'mcp' transport alias ---
    db.exec(`CREATE TABLE "token_usage" (id INTEGER PRIMARY KEY, transport TEXT)`);
    const transports = ['cli', 'api', 'agent', 'mcp', 'unknown'];
    for (let i = 1; i <= FIXTURE_EXPECTED_ROWS.tasks_token_usage; i++) {
      db.exec(`INSERT INTO "token_usage" VALUES (${i}, '${transports[i % transports.length]}')`);
    }

    // --- task_relations with a PRE-EXISTING source FK orphan (T11572 BLOCKER 2) ---
    // Mirrors the real `tasks_task_relations` rows that reference deleted tasks.
    // 4 clean rows (parent + child both real) + 2 orphan rows (to_id is a task id
    // that was never inserted). FK enforcement is OFF so the orphans can be
    // seeded; the orphan travels with the row on copy (zero loss).
    if (opts.withPreExistingSourceOrphan) {
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(
        `CREATE TABLE "task_relations" (
          id INTEGER PRIMARY KEY,
          from_id TEXT REFERENCES "tasks"(id),
          to_id TEXT REFERENCES "tasks"(id),
          kind TEXT
        )`,
      );
      // 4 clean rows referencing real tasks T1..T5.
      for (let i = 1; i <= 4; i++) {
        db.exec(`INSERT INTO "task_relations" VALUES (${i}, 'T${i}', 'T${i + 1}', 'related')`);
      }
      // 2 PRE-EXISTING orphans: to_id points at tasks that do NOT exist.
      db.exec(
        `INSERT INTO "task_relations" VALUES (5, 'T1', 'T-RECONCILE-FOLLOWUP-v2026.5.38-2', 'related')`,
      );
      db.exec(
        `INSERT INTO "task_relations" VALUES (6, 'T2', 'T-RECONCILE-FOLLOWUP-v2026.5.38-3', 'related')`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Build the legacy `brain.db` source fixture with representative drift.
 *
 * @param path - Absolute path for the legacy brain source DB.
 * @param opts - Optional hazard injection (T11572).
 */
function buildBrainSource(path: string, opts: RepresentativeFixtureOptions = {}): void {
  const db = new DatabaseSync(path);
  try {
    // brain_observations already domain-prefixed (identity map) with legacy
    // 'observation' type alias and epoch-ms created_at.
    db.exec(
      `CREATE TABLE "brain_observations" (id INTEGER PRIMARY KEY, type TEXT, created_at INTEGER)`,
    );
    const types = ['discovery', 'observation', 'decision', 'proposal', 'refactor', 'pattern'];
    for (let i = 1; i <= FIXTURE_EXPECTED_ROWS.brain_observations; i++) {
      const ms = 1_717_200_000_000 + i * 1000;
      db.exec(
        `INSERT INTO "brain_observations" VALUES (${i}, '${types[i % types.length]}', ${ms})`,
      );
    }

    // --- DERIVED (FTS5) + INTERNAL (conduit meta) tables (T11572 BLOCKER 1) ---
    // These have NO consolidated counterpart; a correct migration SKIPS them
    // rather than counting them as an N→0 deficit.
    if (opts.withDerivedAndInternalTables) {
      // brain_decisions: the FTS5 content table (real base data).
      db.exec(
        `CREATE TABLE "brain_decisions" (id INTEGER PRIMARY KEY, decision TEXT, rationale TEXT)`,
      );
      for (let i = 1; i <= FIXTURE_HAZARD_EXPECTED_ROWS.brain_decisions; i++) {
        db.exec(`INSERT INTO "brain_decisions" VALUES (${i}, 'decision-${i}', 'rationale-${i}')`);
      }
      // Real FTS5 index → materialises brain_decisions_fts + _data/_idx/_docsize/
      // _config shadow tables (rows that do NOT map 1:1 to base rows).
      db.exec(
        `CREATE VIRTUAL TABLE "brain_decisions_fts" USING fts5(decision, rationale, content="brain_decisions", content_rowid="id")`,
      );
      db.exec(`INSERT INTO "brain_decisions_fts"("brain_decisions_fts") VALUES('rebuild')`);
      // Internal bookkeeping tables (conduit-sqlite's schema-version + ledger).
      db.exec(`CREATE TABLE "_conduit_meta" (key TEXT PRIMARY KEY, value TEXT)`);
      db.exec(`INSERT INTO "_conduit_meta" VALUES ('schema_version', '7')`);
      db.exec(
        `CREATE TABLE "_conduit_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`,
      );
      db.exec(`INSERT INTO "_conduit_migrations" VALUES (1, 'init', '2026-01-01T00:00:00Z')`);
    }
  } finally {
    db.close();
  }
}

/**
 * Build the consolidated TARGET schema with the REAL CHECK + GLOB constraints
 * the production dual-scope schema declares for the fixture's tables.
 *
 * Only the project-scope DB receives tables here (the fixture's brain source is
 * project-scoped in this representative set). The global DB is created empty.
 *
 * @param projectPath - Absolute path for the consolidated project cleo.db.
 * @param globalPath  - Absolute path for the consolidated global cleo.db.
 * @param opts        - Optional hazard injection (T11572) — adds the matching
 *   target tables (`tasks_task_relations`, `brain_decisions`) so the hazard
 *   source data has a consolidated home to copy INTO.
 */
function buildTargetSchema(
  projectPath: string,
  globalPath: string,
  opts: RepresentativeFixtureOptions = {},
): void {
  const db = new DatabaseSync(projectPath);
  try {
    // tasks_tasks: created_at is text + ISO GLOB; self-FK on parent_id.
    db.exec(
      `CREATE TABLE "tasks_tasks" (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parent_id TEXT REFERENCES "tasks_tasks"(id),
        created_at TEXT CHECK ("created_at" IS NULL OR "created_at" GLOB ${ISO_GLOB})
      )`,
    );
    // tasks_architecture_decisions: status CHECK enum + decided_at ISO GLOB.
    db.exec(
      `CREATE TABLE "tasks_architecture_decisions" (
        id INTEGER PRIMARY KEY,
        status TEXT CHECK ("status" IN ('accepted', 'proposed', 'superseded', 'deprecated')),
        decided_at TEXT CHECK ("decided_at" IS NULL OR "decided_at" GLOB ${ISO_GLOB})
      )`,
    );
    // tasks_token_usage: transport CHECK enum (no 'mcp').
    db.exec(
      `CREATE TABLE "tasks_token_usage" (
        id INTEGER PRIMARY KEY,
        transport TEXT CHECK ("transport" IN ('cli', 'api', 'agent', 'unknown'))
      )`,
    );
    // brain_observations: LEGACY RUNTIME shape (T11647) — NO CHECK on `type`,
    // INTEGER epoch-ms `created_at`. The consolidated brain target equals the
    // runtime shape (no SQL CHECKs), so every legacy `type` value and the raw
    // epoch-ms timestamp copy through VERBATIM (zero coercion, zero deficit).
    db.exec(
      `CREATE TABLE "brain_observations" (
        id INTEGER PRIMARY KEY,
        type TEXT,
        created_at INTEGER
      )`,
    );

    // tasks_task_relations: self-FK to tasks_tasks via from_id/to_id. The
    // pre-existing source orphan (to_id pointing at a missing task) copies
    // through and surfaces under PRAGMA foreign_key_check — but is tolerated
    // because the SOURCE already had it (T11572 BLOCKER 2).
    if (opts.withPreExistingSourceOrphan) {
      db.exec(
        `CREATE TABLE "tasks_task_relations" (
          id INTEGER PRIMARY KEY,
          from_id TEXT REFERENCES "tasks_tasks"(id),
          to_id TEXT REFERENCES "tasks_tasks"(id),
          kind TEXT
        )`,
      );
    }
    // brain_decisions: consolidated home for the FTS5 content table. The derived
    // FTS shadow tables + _conduit_meta have NO target — they are skipped, not
    // migrated (T11572 BLOCKER 1).
    if (opts.withDerivedAndInternalTables) {
      db.exec(
        `CREATE TABLE "brain_decisions" (id INTEGER PRIMARY KEY, decision TEXT, rationale TEXT)`,
      );
    }
  } finally {
    db.close();
  }
  // Empty global DB (the representative set keeps everything project-scoped).
  new DatabaseSync(globalPath).close();
}

/**
 * Materialise the full representative fixture: two legacy source DBs and the
 * consolidated target DBs with production-grade CHECK/GLOB/FK constraints.
 *
 * @param dir  - Directory the fixture files are written into. Must already exist.
 * @param opts - Optional T11572 hazard injection (FTS5/meta derived tables +
 *   pre-existing source FK orphan). Omitting it preserves the original
 *   zero-loss base fixture exactly.
 * @returns Absolute paths of every fixture artifact.
 *
 * @task T11551 (DHQ-045 · AC3)
 * @task T11572 (parity-gate hazards — FTS5/meta exclusion + source-orphan tolerance)
 */
export function buildRepresentativeFixture(
  dir: string,
  opts: RepresentativeFixtureOptions = {},
): {
  readonly tasksDbPath: string;
  readonly brainDbPath: string;
  readonly projectDbPath: string;
  readonly globalDbPath: string;
} {
  const { join } = _require('node:path') as typeof import('node:path');
  const tasksDbPath = join(dir, 'tasks.db');
  const brainDbPath = join(dir, 'brain.db');
  const projectDbPath = join(dir, 'cleo-project.db');
  const globalDbPath = join(dir, 'cleo-global.db');

  buildTasksSource(tasksDbPath, opts);
  buildBrainSource(brainDbPath, opts);
  buildTargetSchema(projectDbPath, globalDbPath, opts);

  return { tasksDbPath, brainDbPath, projectDbPath, globalDbPath };
}
