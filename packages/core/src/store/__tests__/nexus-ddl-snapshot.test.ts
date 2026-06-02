/**
 * Nexus DDL snapshot + functional FTS5 / partition gate — the AC3 deliverable for
 * the COMPLETE-CUTOVER of the nexus runtime onto the prefixed `nexus_*` tables.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · task T11578 (AC3).
 *
 * ## What this suite proves
 *
 * After the AC3 cutover, the nexus domain's physical shape inside the
 * consolidated GLOBAL `cleo.db` is the union of:
 *
 *   1. the 10 PREFIXED `nexus_*` base tables created by the consolidated
 *      cleo-global migration (`drizzle-cleo-global/…t11363-consolidation-cleo-global`),
 *      and
 *   2. the `nexus_symbols_fts` FTS5 virtual table + its three `nexus_nodes` sync
 *      triggers (`nexus_nodes_fts_ai/ad/au`), the `nexus_relation_weights`
 *      plasticity-partition sibling, and the `_nexus_meta` health-probe table —
 *      all created by the `drizzle-nexus` DELTA migration (the FTS5 quartet +
 *      partition + sentinel the consolidated migration cannot model).
 *
 * The suite applies BOTH migration layers (in the same order `getNexusDb` does —
 * consolidated first, nexus delta second) to a fresh in-memory `DatabaseSync` via
 * the canonical statement-splitting pipeline, then:
 *
 *   - **DDL snapshot.** Captures `type,name,sql` for every `nexus_*` / `*_fts*`
 *     object from `sqlite_master`, normalizes whitespace, and `toMatchSnapshot()`.
 *     The committed `.snap` baseline locks the post-cutover shape so a future
 *     drift (a bare table sneaking back, a trigger pointed at the wrong table, a
 *     lost CHECK) fails loudly.
 *   - **Functional FTS5 round-trip.** Inserts a row into `nexus_nodes`, asserts
 *     the AFTER-INSERT trigger populated `nexus_symbols_fts`, then runs a MATCH
 *     and asserts the row is returned — proving the FTS index + triggers point at
 *     the right content (`nexus_nodes.label`/`file_path`).
 *   - **Plasticity partition.** Asserts the consolidated `nexus_relations` (which
 *     ships with inline plasticity columns in the T11363 shape) is the input, and
 *     that the runtime `ensureNexusRelationWeights` (exercised separately by
 *     `migration-fresh-no-repair.nexus.test.ts`) yields the narrow shape — here we
 *     assert the sibling `nexus_relation_weights` table exists post-delta.
 *
 * Test isolation: the DB is `:memory:`. The real user's cleo.db is never touched.
 *
 * @task T11578
 * @epic T11245
 * @saga T11242
 * @see ./conduit-ddl-snapshot.test.ts (the AC4 sibling this mirrors)
 * @see ../nexus-sqlite.ts (runtime — sentinel = `_nexus_meta`)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDbSyncConstructor } from '../sqlite-native.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a `drizzle-<name>` migrations dir relative to this test file. */
function migrationsDir(name: string): string {
  // Test:       packages/core/src/store/__tests__/
  // Migrations: packages/core/migrations/<name>/
  return join(__dirname, '..', '..', '..', 'migrations', name);
}

/**
 * Read every `<dir>/<timestamp_name>/migration.sql` body in ascending
 * folder-name (timestamp) order — the same chronological order the runtime
 * applies them.
 *
 * @param dir - A `drizzle-<name>` migrations directory.
 * @returns Migration SQL bodies in ascending folder order.
 */
function readMigrationBodies(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((folder) => readFileSync(join(dir, folder, 'migration.sql'), 'utf8'));
}

/**
 * Apply a drizzle-kit migration body to an open handle: split on the canonical
 * `--> statement-breakpoint` delimiter, drop comment-only / whitespace-only
 * chunks (the `migrateSanitized` contract), and execute each remaining statement.
 *
 * @param db - The open `node:sqlite` handle.
 * @param body - The full `migration.sql` body.
 */
function applyMigrationBody(db: DatabaseSync, body: string): void {
  const statements = body
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => {
      if (s === '') return false;
      const stripped = s
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
      return stripped !== '';
    });
  for (const statement of statements) db.exec(statement);
}

/**
 * Build a fresh in-memory `cleo.db` with the post-cutover nexus shape: the
 * consolidated cleo-global migration (creates the 10 prefixed `nexus_*` base
 * tables) followed by the nexus delta migration (adds `nexus_symbols_fts` +
 * triggers + `nexus_relation_weights` + `_nexus_meta`) — the exact two-layer
 * order `getNexusDb` applies.
 *
 * @returns An open in-memory handle.
 */
function buildPostCutoverNexusDb(): DatabaseSync {
  const Ctor = getDbSyncConstructor();
  const db = new Ctor(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const body of readMigrationBodies(migrationsDir('drizzle-cleo-global'))) {
    applyMigrationBody(db, body);
  }
  for (const body of readMigrationBodies(migrationsDir('drizzle-nexus'))) {
    applyMigrationBody(db, body);
  }
  return db;
}

/** Collapse runs of whitespace so the snapshot is robust to formatting drift. */
function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;
  return sql.replace(/\s+/g, ' ').trim();
}

describe('T11578 AC3 — nexus DDL snapshot (post-cutover prefixed shape + FTS5)', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = buildPostCutoverNexusDb();
  });

  afterAll(() => {
    db.close();
  });

  it('nexus_* + *_fts* sqlite_master shape matches the committed baseline', () => {
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (name LIKE 'nexus_%' OR name LIKE '%_fts%')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;

    const normalized = rows.map((r) => ({
      type: r.type,
      name: r.name,
      sql: normalizeSql(r.sql),
    }));

    expect(normalized).toMatchSnapshot();
  });

  it('the four bare legacy registry tables do NOT survive the cutover', () => {
    const bare = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('project_registry','project_id_aliases','user_profile','sigils')",
      )
      .all() as Array<{ name: string }>;
    expect(bare).toHaveLength(0);
  });

  it('the prefixed registry/identity tables exist (nexus_project_registry, nexus_user_profile, nexus_sigils, nexus_project_id_aliases)', () => {
    for (const name of [
      'nexus_project_registry',
      'nexus_project_id_aliases',
      'nexus_user_profile',
      'nexus_sigils',
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) as { name: string } | undefined;
      expect(row?.name, `expected prefixed table ${name} to exist`).toBe(name);
    }
  });

  it('the FTS5 index nexus_symbols_fts + its three nexus_nodes triggers exist', () => {
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nexus_symbols_fts'")
      .get() as { name: string } | undefined;
    expect(fts?.name).toBe('nexus_symbols_fts');

    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'nexus_nodes_fts_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).toEqual([
      'nexus_nodes_fts_ad',
      'nexus_nodes_fts_ai',
      'nexus_nodes_fts_au',
    ]);
  });

  it('the nexus_relation_weights plasticity-partition sibling + _nexus_meta sentinel exist', () => {
    for (const name of ['nexus_relation_weights', '_nexus_meta']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) as { name: string } | undefined;
      expect(row?.name, `expected ${name} to exist`).toBe(name);
    }
  });

  it('AFTER-INSERT trigger populates nexus_symbols_fts and MATCH returns the row', () => {
    // nexus_nodes carries a `project_id` (the runtime keeps a single global handle);
    // kind/indexed_at must satisfy the consolidated CHECK constraints.
    db.exec(
      `INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, indexed_at)
       VALUES ('n-fts', 'proj-1', 'function', 'parseFile', 'src/core/parser.ts', '2026-06-02T00:00:00.000Z')`,
    );

    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM nexus_symbols_fts').get() as {
      n: number;
    };
    expect(ftsCount.n).toBeGreaterThan(0);

    const hit = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH 'parseFile'`)
      .get() as { node_id: string } | undefined;
    expect(hit?.node_id).toBe('n-fts');
  });
});
