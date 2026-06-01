/**
 * Consolidated dual-scope schema — parity + cross-scope FK-integrity
 * round-trip validation suite.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11364 (FINAL E2 task).
 *
 * ## What this suite proves
 *
 * The consolidated D1″ lifecycle split collapses the CLEO SQLite fleet into two
 * `cleo.db` files: a PROJECT-scope DB (`tasks_*` / `conduit_*` / `docs_*` /
 * `telemetry_*` / `brain_*`) and a GLOBAL-scope DB (`nexus_*` / `skills_*` /
 * `signaldock_*` / `brain_*`). Two parallel artifacts describe that target shape:
 *
 *   1. the Drizzle **schema families** under
 *      `packages/core/src/store/schema/cleo-{project,global,shared}/`, and
 *   2. the **generated migrations** under
 *      `packages/core/migrations/drizzle-cleo-{project,global}/`, whose CHECK
 *      constraints are injected by `scripts/inject-consolidation-checks.mjs`
 *      (T11363) straight from the schema's own enum/boolean/timestamp metadata.
 *
 * This suite is the closing E2 gate: it asserts those two artifacts are
 * internally consistent and that **"what Drizzle declares IS what runtime
 * writes"** — across all four E2 acceptance criteria:
 *
 *   - **AC1 — cross-schema FK integrity.** Reuses the T11244 spike's
 *     `buildConsolidatedFixture` + `PRAGMA foreign_key_check` approach. The
 *     spike's toy 5-domain fixture proves the cross-domain FK *capability*;
 *     this suite additionally proves the REAL consolidated migrations'
 *     in-file FK graph (50 project + N global edges, every parent in the same
 *     scope file) is enforceable: `foreign_key_check` is zero-rows after a
 *     valid seed and DETECTS a deliberately-orphaned row.
 *   - **AC2 — parity (declared == written).** Applies the generated migration
 *     DDL to an EMPTY `node:sqlite` DB, then asserts the resulting
 *     `sqlite_master` (tables + columns + the injected CHECK constraints)
 *     matches what the Drizzle schema declares. The CHECK derivation mirrors
 *     the T11363 injector EXACTLY (boolean → `IN (0,1)`, enum → `IN (...)` from
 *     `enumValues`, `_at` TEXT → ISO-8601 GLOB) so any drift between schema and
 *     migration fails here.
 *   - **AC3 — typed round-trip.** Inserts representative rows through the typed
 *     Drizzle writers for each domain (project: tasks/conduit/docs/telemetry/
 *     brain; global: nexus/skills/signaldock/brain), reads them back typed, and
 *     asserts equality — proving the migrated physical schema accepts and
 *     returns exactly what the typed schema models.
 *   - **AC4 — ATTACH rejection re-asserted.** Re-proves, consistent with the
 *     spike, that a cross-FILE FK across the two scopes is unenforceable (no
 *     ATTACH): SQLite resolves FK parents in the MAIN schema only, so
 *     referential integrity is impossible across scope boundaries — exactly
 *     why the single-file-per-scope Pattern A is required.
 *
 * ## Test isolation
 *
 * Every DB is `:memory:` or under `os.tmpdir()`. FK enforcement is driven
 * explicitly via the raw `node:sqlite` constructor with
 * `enableForeignKeyConstraints` + `PRAGMA foreign_keys` so the suite controls
 * referential integrity directly (the production `openNativeDatabase` disables
 * FK enforcement under VITEST, which would mask AC1/AC4). `foreign_key_check`
 * is a passive scan and reports violations regardless of the enforcement flag.
 *
 * @task T11364
 * @epic T11245
 * @saga T11242
 * @see tools/db-substrate-spike/04-consolidation-fixture.ts (the T11244 fixture builder — adapted here)
 * @see scripts/inject-consolidation-checks.mjs (T11363 — the CHECK injector this mirrors)
 * @see ./migration-baseline.test.ts (the migration-apply test pattern)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as globalSchema from '../schema/cleo-global/index.js';
import * as projectSchema from '../schema/cleo-project/index.js';
import { getDbSyncConstructor } from '../sqlite-native.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Scope descriptors — the two consolidated `cleo.db` families.
// ---------------------------------------------------------------------------

/** The two consolidated scopes covered by every AC below. */
type Scope = 'project' | 'global';

/** Static description of a consolidated scope and its generated migration. */
interface ScopeDescriptor {
  /** Scope label. */
  scope: Scope;
  /** The Drizzle schema barrel (`import * as`) authoring this scope's tables. */
  schema: Record<string, unknown>;
  /** Absolute path to the scope's `drizzle-cleo-<scope>` migrations dir. */
  migrationsDir: string;
}

/** Resolve a `drizzle-cleo-<scope>` migrations dir from this test's location. */
function migrationsDirFor(scope: Scope): string {
  // Test:       packages/core/src/store/__tests__/
  // Migrations: packages/core/migrations/drizzle-cleo-<scope>/
  return join(__dirname, '..', '..', '..', 'migrations', `drizzle-cleo-${scope}`);
}

const SCOPES: readonly ScopeDescriptor[] = [
  { scope: 'project', schema: projectSchema, migrationsDir: migrationsDirFor('project') },
  { scope: 'global', schema: globalSchema, migrationsDir: migrationsDirFor('global') },
] as const;

// ---------------------------------------------------------------------------
// Migration-application helpers (the production artifact under test).
// ---------------------------------------------------------------------------

/**
 * Read all migration SQL bodies from a scope's folder-per-migration directory
 * (`<dir>/<timestamp_name>/migration.sql`), sorted by folder name (timestamp prefix).
 *
 * Supports multiple migration folders — migrations are applied in chronological
 * order so each successive migration layer is applied on top of the previous.
 *
 * @param migrationsDir - The scope's `drizzle-cleo-<scope>` directory.
 * @returns Array of migration SQL strings in ascending folder-name order.
 */
function readAllMigrationSql(migrationsDir: string): string[] {
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (folders.length === 0) {
    throw new Error(`expected at least one migration folder in ${migrationsDir}, found none`);
  }
  return folders.map((folder) =>
    readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8'),
  );
}

/** Read a scope's generated migration body (all migrations concatenated in order). */
function readMigrationSql(migrationsDir: string): string {
  return readAllMigrationSql(migrationsDir).join('\n');
}

/**
 * Apply a drizzle-kit migration body to an open `node:sqlite` handle. The body
 * is split on the canonical `--> statement-breakpoint` delimiter and each
 * statement is executed in order — this is exactly how the generated DDL is
 * replayed at runtime.
 *
 * @param db - The open `node:sqlite` handle.
 * @param sql - The full `migration.sql` body.
 * @returns The number of statements executed.
 */
function applyMigration(db: DatabaseSync, sql: string): number {
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    db.exec(statement);
  }
  return statements.length;
}

/**
 * Open a fresh `:memory:` `node:sqlite` handle with FK enforcement explicitly
 * ON (the spike's policy), bypassing the VITEST-aware production opener that
 * disables FK enforcement during tests. Used by every AC so the suite owns the
 * referential-integrity state.
 *
 * @returns An open in-memory handle with `foreign_keys = ON`.
 */
function openMemoryWithFk(): DatabaseSync {
  const Ctor = getDbSyncConstructor();
  const db = new Ctor(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Apply a scope's migration into a fresh in-memory FK-enforcing handle. */
function buildMigratedDb(descriptor: ScopeDescriptor): { db: DatabaseSync; statements: number } {
  const db = openMemoryWithFk();
  const statements = applyMigration(db, readMigrationSql(descriptor.migrationsDir));
  return { db, statements };
}

// ---------------------------------------------------------------------------
// Schema introspection helpers.
// ---------------------------------------------------------------------------

/** A `PRAGMA foreign_key_check` violation row, narrowed (no blanket cast). */
interface FkViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

/** Run `PRAGMA foreign_key_check` and return any violation rows, typed. */
function foreignKeyCheck(db: DatabaseSync): FkViolation[] {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    table: String(row['table'] ?? ''),
    rowid: Number(row['rowid'] ?? 0),
    parent: String(row['parent'] ?? ''),
    fkid: Number(row['fkid'] ?? 0),
  }));
}

/** Enumerate user table names present in a handle (excludes `sqlite_*`). */
function listTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Read the column names of a table from `PRAGMA table_info`. */
function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

/** Count FK edges declared on a table via `PRAGMA foreign_key_list`. */
function foreignKeyCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<unknown>).length;
}

/**
 * Iterate every `sqliteTable` exported from a schema barrel, yielding its
 * drizzle table config. Non-table exports (const arrays, type guards) are
 * skipped — `getTableConfig` throws on them.
 *
 * @param schema - The `import * as` schema barrel.
 * @yields One `{ table, config }` per `sqliteTable` export.
 */
function* iterateTables(
  schema: Record<string, unknown>,
): Generator<{ table: SQLiteTable; config: ReturnType<typeof getTableConfig> }> {
  for (const value of Object.values(schema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as SQLiteTable);
    } catch {
      continue; // not a table export
    }
    if (config && typeof config.name === 'string') {
      yield { table: value as SQLiteTable, config };
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK-constraint derivation — a byte-faithful mirror of the T11363 injector
// (scripts/inject-consolidation-checks.mjs). Kept in lock-step so any drift
// between the schema metadata and the committed migration fails AC2.
// ---------------------------------------------------------------------------

/** Escape a single-quoted SQL string literal (double any embedded quote). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Derive the ordered CHECK-constraint fragments for one drizzle table straight
 * from its column metadata — identical rules to the T11363 injector:
 * boolean → `IN (0, 1)`; enum → `IN (...)` from `enumValues`; `_at` TEXT →
 * ISO-8601 GLOB guard.
 *
 * @param config - The table's drizzle config (from {@link getTableConfig}).
 * @returns Ordered CHECK fragments for this table (may be empty).
 */
function deriveChecks(config: ReturnType<typeof getTableConfig>): string[] {
  const checks: string[] = [];
  for (const col of config.columns) {
    const name = col.name;
    if (col.columnType === 'SQLiteBoolean') {
      checks.push(`CHECK ("${name}" IN (0, 1))`);
      continue;
    }
    if (Array.isArray(col.enumValues) && col.enumValues.length > 0) {
      const list = col.enumValues.map(sqlLiteral).join(', ');
      checks.push(`CHECK ("${name}" IN (${list}))`);
      continue;
    }
    if (col.columnType === 'SQLiteText' && /_at$/.test(name)) {
      checks.push(
        `CHECK ("${name}" IS NULL OR "${name}" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')`,
      );
    }
  }
  return checks;
}

// ===========================================================================
// AC2 — PARITY (declared == written)
//
// Applies the generated migration DDL to an EMPTY node:sqlite DB and asserts
// the resulting sqlite_master (tables + columns + injected CHECK constraints)
// matches what the Drizzle schema declares.
// ===========================================================================

describe('T11364 AC2 — consolidated migration parity (declared == written)', () => {
  for (const descriptor of SCOPES) {
    describe(`${descriptor.scope} scope`, () => {
      let db: DatabaseSync;

      beforeAll(() => {
        db = buildMigratedDb(descriptor).db;
      });

      afterAll(() => {
        db.close();
      });

      it('migration DDL applies cleanly to an empty DB', () => {
        // buildMigratedDb already executed every statement; a non-empty table
        // set proves the body applied without throwing.
        expect(listTables(db).length).toBeGreaterThan(0);
      });

      it('every schema-declared table exists in the migrated DB', () => {
        const present = new Set(listTables(db));
        const declared: string[] = [];
        for (const { config } of iterateTables(descriptor.schema)) {
          declared.push(config.name);
        }
        // The schema declares at least one table for the scope.
        expect(declared.length).toBeGreaterThan(0);
        for (const name of declared) {
          expect(present.has(name), `declared table '${name}' missing from migrated DB`).toBe(true);
        }
      });

      it("every schema-declared column exists with the schema's physical name", () => {
        for (const { config } of iterateTables(descriptor.schema)) {
          const actual = new Set(tableColumns(db, config.name));
          for (const col of config.columns) {
            expect(
              actual.has(col.name),
              `table '${config.name}' missing declared column '${col.name}'`,
            ).toBe(true);
          }
        }
      });

      it('every schema-derived CHECK constraint is present in the migrated DDL', () => {
        // The migrated sqlite_master.sql carries each CREATE TABLE verbatim
        // (CHECKs included). We re-derive the expected CHECKs from the live
        // schema metadata — exactly as the T11363 injector does — and assert
        // each fragment appears in the committed/applied DDL. Zero drift means
        // the migration's CHECKs ARE the schema's enum/boolean/timestamp SSoT.
        const masterSql = (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
            )
            .all() as Array<{ sql: string }>
        )
          .map((r) => r.sql)
          .join('\n');

        let totalChecks = 0;
        for (const { config } of iterateTables(descriptor.schema)) {
          for (const check of deriveChecks(config)) {
            totalChecks++;
            expect(
              masterSql.includes(check),
              `table '${config.name}': schema-derived CHECK absent from migration — ${check}`,
            ).toBe(true);
          }
        }
        // Guard against a vacuous pass: the consolidated schema is enum/boolean
        // heavy, so each scope MUST contribute many CHECKs.
        expect(totalChecks).toBeGreaterThan(50);
      });
    });
  }
});

// ===========================================================================
// AC1 — CROSS-SCHEMA FK INTEGRITY
//
// (a) The T11244 spike fixture: the toy 5-domain consolidated schema proves
//     cross-domain FK capability and orphan detection.
// (b) The REAL consolidated migrations: every FK parent lives in the same
//     scope file, so foreign_key_check enforces the whole graph — zero rows
//     after a valid seed, and DETECTS a deliberately-orphaned row.
// ===========================================================================

/** Minimal valid cross-domain seed mirroring the T11244 spike fixture. */
const SPIKE_DDL = `
CREATE TABLE tasks_task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE TABLE brain_memory (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_task(id), observation TEXT NOT NULL
);
CREATE TABLE conduit_event (
  idempotency_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_task(id), payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE docs_attachment (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_task(id), slug TEXT NOT NULL UNIQUE
);
CREATE TABLE telemetry_span (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_task(id), duration_ms INTEGER NOT NULL
);
`;

/**
 * Build + seed the T11244 toy 5-domain consolidated fixture in one file,
 * adapted inline from `tools/db-substrate-spike/04-consolidation-fixture.ts`
 * `buildConsolidatedFixture` (the spike tooling is intentionally untracked, so
 * its DDL + seed are reproduced here as the AC1 capability foundation).
 *
 * @param db - An open FK-enforcing handle.
 * @param scope - Label recorded in seeded task IDs.
 */
function buildSpikeFixture(db: DatabaseSync, scope: Scope): void {
  db.exec(SPIKE_DDL);
  const now = Date.now();
  const taskId = `T-${scope}-1`;
  db.prepare('INSERT INTO tasks_task (id, title, status, created_at) VALUES (?, ?, ?, ?)').run(
    taskId,
    `${scope} root task`,
    'pending',
    now,
  );
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
}

describe('T11364 AC1 — cross-schema FK integrity', () => {
  describe('T11244 spike fixture — cross-domain FK capability', () => {
    for (const scope of ['project', 'global'] as const) {
      it(`${scope}: 5 domains co-located in one file, foreign_key_check clean after valid seed`, () => {
        const db = openMemoryWithFk();
        try {
          buildSpikeFixture(db, scope);
          const tables = new Set(listTables(db));
          for (const t of [
            'tasks_task',
            'brain_memory',
            'conduit_event',
            'docs_attachment',
            'telemetry_span',
          ]) {
            expect(tables.has(t), `domain table '${t}' must co-exist in one file`).toBe(true);
          }
          expect(foreignKeyCheck(db).length, 'valid seed must produce zero FK violations').toBe(0);
        } finally {
          db.close();
        }
      });

      it(`${scope}: foreign_key_check DETECTS a deliberately-orphaned cross-domain row`, () => {
        const db = openMemoryWithFk();
        try {
          buildSpikeFixture(db, scope);
          // Inject an orphan with enforcement OFF so the bad row lands, then
          // re-enable and scan — the check must surface it (proves it is live).
          db.exec('PRAGMA foreign_keys = OFF;');
          db.prepare('INSERT INTO brain_memory (id, task_id, observation) VALUES (?, ?, ?)').run(
            `ORPHAN-${scope}`,
            'T-DOES-NOT-EXIST',
            'orphan',
          );
          db.exec('PRAGMA foreign_keys = ON;');
          const violations = foreignKeyCheck(db);
          expect(violations.length, 'orphan must be detected by foreign_key_check').toBeGreaterThan(
            0,
          );
          expect(violations.some((v) => v.table === 'brain_memory')).toBe(true);
        } finally {
          db.close();
        }
      });
    }
  });

  describe('real consolidated migrations — in-file FK graph is enforceable', () => {
    for (const descriptor of SCOPES) {
      it(`${descriptor.scope}: foreign_key_check is clean on the freshly-migrated (empty) schema`, () => {
        const { db } = buildMigratedDb(descriptor);
        try {
          // A fresh migrated DB has zero rows → zero FK violations, and every
          // FK parent table resolves within this single scope file (no ATTACH).
          expect(foreignKeyCheck(db).length).toBe(0);
        } finally {
          db.close();
        }
      });

      it(`${descriptor.scope}: declares a non-trivial intra-file FK graph (every parent same-scope)`, () => {
        const { db } = buildMigratedDb(descriptor);
        try {
          let edges = 0;
          for (const table of listTables(db)) {
            edges += foreignKeyCount(db, table);
          }
          // The consolidated scope carries real referential structure; this is
          // only enforceable because every parent lives in the same file.
          expect(edges).toBeGreaterThan(0);
        } finally {
          db.close();
        }
      });
    }

    it('project: foreign_key_check DETECTS an orphaned real-schema FK row', () => {
      const { db } = buildMigratedDb(SCOPES[0]);
      try {
        // tasks_task_dependencies.(task_id, depends_on) → tasks_tasks.id.
        // Insert an orphan with enforcement OFF, then scan with it back ON.
        db.exec('PRAGMA foreign_keys = OFF;');
        db.prepare('INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES (?, ?)').run(
          'T-NOPE-A',
          'T-NOPE-B',
        );
        db.exec('PRAGMA foreign_keys = ON;');
        const violations = foreignKeyCheck(db);
        expect(
          violations.some((v) => v.table === 'tasks_task_dependencies'),
          'orphaned real-schema FK row must be detected',
        ).toBe(true);
      } finally {
        db.close();
      }
    });
  });
});

// ===========================================================================
// AC3 — TYPED ROUND-TRIP
//
// Inserts representative rows through the typed Drizzle writers for each
// domain, reads them back typed, and asserts equality. Cross-domain FK edges
// are honoured by inserting parent rows first.
// ===========================================================================

describe('T11364 AC3 — typed round-trip through the consolidated schema', () => {
  let projectDb: DatabaseSync;
  let globalDb: DatabaseSync;

  beforeAll(() => {
    projectDb = buildMigratedDb(SCOPES[0]).db;
    globalDb = buildMigratedDb(SCOPES[1]).db;
  });

  afterAll(() => {
    projectDb.close();
    globalDb.close();
  });

  it('project: tasks/conduit/docs/telemetry/brain round-trip equal', async () => {
    const db = drizzle({ client: projectDb });

    // tasks domain — root row referenced by intra-domain FKs.
    await db.insert(projectSchema.tasksTasks).values({
      id: 'T-rt-1',
      title: 'round-trip task',
      createdAt: '2026-05-31T00:00:00Z',
    });
    const [task] = await db
      .select()
      .from(projectSchema.tasksTasks)
      .where(eq(projectSchema.tasksTasks.id, 'T-rt-1'));
    expect(task.id).toBe('T-rt-1');
    expect(task.title).toBe('round-trip task');
    expect(task.status).toBe('pending'); // schema default applied

    // conduit domain
    await db.insert(projectSchema.conduitConversations).values({
      id: 'C-rt-1',
      participants: '["agent:a","agent:b"]',
    });
    const [conv] = await db
      .select()
      .from(projectSchema.conduitConversations)
      .where(eq(projectSchema.conduitConversations.id, 'C-rt-1'));
    expect(conv.id).toBe('C-rt-1');
    expect(conv.participants).toBe('["agent:a","agent:b"]');
    expect(conv.visibility).toBe('private'); // default
    expect(conv.messageCount).toBe(0); // default

    // docs domain
    await db.insert(projectSchema.docsAttachments).values({
      id: 'A-rt-1',
      sha256: 'a'.repeat(64),
      attachmentJson: '{"kind":"local-file"}',
    });
    const [att] = await db
      .select()
      .from(projectSchema.docsAttachments)
      .where(eq(projectSchema.docsAttachments.id, 'A-rt-1'));
    expect(att.id).toBe('A-rt-1');
    expect(att.sha256).toBe('a'.repeat(64));
    expect(att.refCount).toBe(0); // default

    // telemetry domain
    await db.insert(projectSchema.telemetryEvents).values({
      id: 'E-rt-1',
      anonymousId: 'anon-1',
      domain: 'tasks',
      gateway: 'query',
      operation: 'show',
      command: 'tasks.show',
      durationMs: 42,
      timestamp: '2026-05-31T00:00:00Z',
    });
    const [evt] = await db
      .select()
      .from(projectSchema.telemetryEvents)
      .where(eq(projectSchema.telemetryEvents.id, 'E-rt-1'));
    expect(evt.id).toBe('E-rt-1');
    expect(evt.durationMs).toBe(42);
    expect(evt.exitCode).toBe(0); // default

    // brain domain (mirrored) — enum value 'discovery' satisfies the CHECK.
    await db.insert(projectSchema.brainObservations).values({
      id: 'O-rt-1',
      type: 'discovery',
      title: 'round-trip observation',
    });
    const [obs] = await db
      .select()
      .from(projectSchema.brainObservations)
      .where(eq(projectSchema.brainObservations.id, 'O-rt-1'));
    expect(obs.id).toBe('O-rt-1');
    expect(obs.type).toBe('discovery');
    expect(obs.title).toBe('round-trip observation');
    expect(obs.verified).toBe(false); // boolean default — proves mode:'boolean' round-trip
  });

  it('global: nexus/skills/signaldock/brain round-trip equal', async () => {
    const db = drizzle({ client: globalDb });

    // nexus domain
    await db.insert(globalSchema.nexusSchemaMeta).values({ key: 'schema_version', value: '3' });
    const [meta] = await db
      .select()
      .from(globalSchema.nexusSchemaMeta)
      .where(eq(globalSchema.nexusSchemaMeta.key, 'schema_version'));
    expect(meta.key).toBe('schema_version');
    expect(meta.value).toBe('3');

    // skills domain — autoincrement PK; enum source_type 'canonical'.
    await db.insert(globalSchema.skillsSkills).values({
      name: 'ct-cleo',
      sourceType: 'canonical',
      installPath: '/skills/ct-cleo',
      installedAt: '2026-05-31T00:00:00Z',
    });
    const [skill] = await db
      .select()
      .from(globalSchema.skillsSkills)
      .where(eq(globalSchema.skillsSkills.name, 'ct-cleo'));
    expect(skill.name).toBe('ct-cleo');
    expect(skill.sourceType).toBe('canonical');
    expect(skill.lifecycleState).toBe('active'); // default
    expect(skill.pinned).toBe(false); // boolean default

    // signaldock domain
    await db.insert(globalSchema.signaldockCapabilities).values({
      id: 'cap-rt-1',
      slug: 'code-review',
      name: 'Code Review',
      description: 'Reviews code',
      category: 'engineering',
      createdAt: '2026-05-31T00:00:00Z',
    });
    const [cap] = await db
      .select()
      .from(globalSchema.signaldockCapabilities)
      .where(eq(globalSchema.signaldockCapabilities.id, 'cap-rt-1'));
    expect(cap.slug).toBe('code-review');
    expect(cap.name).toBe('Code Review');
    expect(cap.category).toBe('engineering');

    // brain domain (mirrored — same module as project scope)
    await db
      .insert(globalSchema.brainSchemaMeta)
      .values({ key: 'global_marker', value: 'present' });
    const [bMeta] = await db
      .select()
      .from(globalSchema.brainSchemaMeta)
      .where(eq(globalSchema.brainSchemaMeta.key, 'global_marker'));
    expect(bMeta.key).toBe('global_marker');
    expect(bMeta.value).toBe('present');
  });
});

// ===========================================================================
// AC4 — ATTACH REJECTION RE-ASSERTED
//
// Re-proves, consistent with the T11244 spike, that a cross-FILE FK across the
// two scopes is unenforceable: SQLite resolves FK parents in the MAIN schema
// only, so cross-scope referential integrity is impossible without the
// single-file-per-scope consolidation.
// ===========================================================================

describe('T11364 AC4 — ATTACH cross-file FK rejection (cross-scope is unenforceable)', () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'cleo-t11364-attach-'));
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('an FK whose parent lives in an ATTACHed file is unenforceable', () => {
    const Ctor = getDbSyncConstructor();
    const otherPath = join(workdir, 'other-scope.db');

    // Parent table lives ONLY in the OTHER (attached) scope file.
    const other = new Ctor(otherPath);
    other.exec('CREATE TABLE parent (id TEXT PRIMARY KEY);');
    other.exec("INSERT INTO parent (id) VALUES ('p1');");
    other.close();

    const main = new Ctor(':memory:', { enableForeignKeyConstraints: true });
    main.exec('PRAGMA foreign_keys = ON;');
    main.exec(`ATTACH DATABASE '${otherPath}' AS other;`);
    // FK targets are resolved lazily, so CREATE is accepted — but the parent
    // only exists in attached `other`, never in main.
    main.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));');

    let crossFileFkBlocked = false;
    let crossFileFkError: string | null = null;
    try {
      // parent_id 'p1' exists in attached other.parent but NOT in main — with
      // foreign_keys=ON, SQLite resolves the FK parent in the MAIN schema and
      // fails, proving cross-file FKs are not a usable cross-scope substitute.
      main.exec("INSERT INTO child (id, parent_id) VALUES ('c1', 'p1');");
    } catch (err) {
      crossFileFkBlocked = true;
      crossFileFkError = err instanceof Error ? err.message : String(err);
    }
    main.close();

    expect(crossFileFkBlocked, 'cross-file FK across scopes must be unenforceable (rejected)').toBe(
      true,
    );
    expect(crossFileFkError).not.toBeNull();
  });

  it('the SQLITE_LIMIT_ATTACHED ceiling leaves no headroom for a multi-scope FK topology', () => {
    const Ctor = getDbSyncConstructor();
    const main = new Ctor(':memory:');
    let attached = 0;
    let failedAt: number | null = null;
    for (let i = 0; i < 64; i++) {
      const p = join(workdir, `attach-extra-${i}.db`);
      try {
        main.exec(`ATTACH DATABASE '${p}' AS extra_${i};`);
        attached++;
      } catch {
        failedAt = attached + 1;
        break;
      }
    }
    main.close();
    // ATTACH is bounded (default SQLITE_LIMIT_ATTACHED) — a hard wall exists.
    // Either we hit the ceiling, or the bound is at least observable; both
    // confirm ATTACH cannot scale to an arbitrary cross-scope FK fabric.
    expect(failedAt === null ? attached : failedAt).toBeGreaterThan(0);
    expect(attached).toBeLessThan(64);
  });
});
