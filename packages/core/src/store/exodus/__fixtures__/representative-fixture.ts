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
 *     target `text` column with an ISO-8601 GLOB CHECK constraint.
 *   - **Legacy enum aliases** (`'Accepted'`, `'mcp'`, `'observation'`) that fail
 *     the target CHECK unless the migration normalises them.
 *   - **A self-referential FK** (`tasks.parent_id → tasks.id`) copied
 *     child-before-parent to exercise the FK-defer path.
 *
 * The matching consolidated target schemas are built with the REAL CHECK and
 * GLOB constraints the production schema declares, so a regression in the
 * coercion/normalisation layer surfaces as a row deficit caught by
 * {@link verifyMigration}.
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
 * Build the legacy `tasks.db` source fixture with representative drift.
 *
 * @param path - Absolute path for the legacy tasks source DB.
 */
function buildTasksSource(path: string): void {
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
  } finally {
    db.close();
  }
}

/**
 * Build the legacy `brain.db` source fixture with representative drift.
 *
 * @param path - Absolute path for the legacy brain source DB.
 */
function buildBrainSource(path: string): void {
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
 */
function buildTargetSchema(projectPath: string, globalPath: string): void {
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
    // brain_observations: type CHECK enum + created_at ISO GLOB.
    db.exec(
      `CREATE TABLE "brain_observations" (
        id INTEGER PRIMARY KEY,
        type TEXT CHECK ("type" IN ('discovery', 'decision', 'refactor', 'insight')),
        created_at TEXT CHECK ("created_at" IS NULL OR "created_at" GLOB ${ISO_GLOB})
      )`,
    );
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
 * @param dir - Directory the fixture files are written into. Must already exist.
 * @returns Absolute paths of every fixture artifact.
 *
 * @task T11551 (DHQ-045 · AC3)
 */
export function buildRepresentativeFixture(dir: string): {
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

  buildTasksSource(tasksDbPath);
  buildBrainSource(brainDbPath);
  buildTargetSchema(projectDbPath, globalDbPath);

  return { tasksDbPath, brainDbPath, projectDbPath, globalDbPath };
}
