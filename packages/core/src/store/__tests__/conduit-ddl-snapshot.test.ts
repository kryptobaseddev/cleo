/**
 * Conduit DDL snapshot + functional FTS5 gate — the AC4 deliverable for the
 * COMPLETE-CUTOVER of the conduit runtime onto the prefixed `conduit_*` tables.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · task T11578 (AC4).
 *
 * ## What this suite proves
 *
 * After the AC4 cutover, the conduit domain's physical shape inside the
 * consolidated project `cleo.db` is the union of:
 *
 *   1. the 14 PREFIXED `conduit_*` tables created by the consolidated cleo-project
 *      migration (`drizzle-cleo-project/…t11363-consolidation-cleo-project`), and
 *   2. the `conduit_messages_fts` FTS5 virtual table + its three sync triggers
 *      (`conduit_messages_ai/ad/au`) created by the `drizzle-conduit` forward
 *      migration — the FTS5 quartet the consolidated migration cannot model.
 *
 * The suite applies BOTH migration layers (in the same order `ensureConduitDb`
 * does — consolidated first, conduit FTS second) to a fresh in-memory
 * `DatabaseSync` via the canonical `migrateSanitized` statement-splitting
 * pipeline, then:
 *
 *   - **DDL snapshot.** Captures `type,name,sql` for every `conduit_*` / `*_fts*`
 *     object from `sqlite_master`, normalizes whitespace, and `toMatchSnapshot()`.
 *     The committed `.snap` baseline locks the post-cutover shape so a future
 *     drift (a bare table sneaking back, a trigger pointed at `messages`, a lost
 *     `content=` option) fails loudly.
 *   - **Functional FTS5 round-trip.** Inserts a row into `conduit_messages`,
 *     asserts the AFTER-INSERT trigger populated `conduit_messages_fts`, then runs
 *     `MATCH 'hello'` and asserts the row is returned — proving the renamed FTS
 *     index's `content='conduit_messages'` option + triggers point at the right
 *     content table.
 *
 * Test isolation: every DB is `:memory:`. FK enforcement is ON so the
 * conduit_messages → conduit_conversations FK is honoured (a parent conversation
 * is seeded first). The real user's project root is never touched.
 *
 * @task T11578
 * @epic T11245
 * @saga T11242
 * @see ./consolidated-schema-parity-fk.test.ts (migration-apply pattern this mirrors)
 * @see ../conduit-sqlite.ts (runtime — sentinel = `conduit_messages`)
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
      // Drop comment-only statements (baseline markers) — mirrors
      // migration-manager.sanitizeMigrationStatements.isExecutableStatement.
      const stripped = s
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
      return stripped !== '';
    });
  for (const statement of statements) db.exec(statement);
}

/**
 * Build a fresh in-memory `cleo.db` with the post-cutover conduit shape: the
 * consolidated cleo-project migration (creates the 14 prefixed `conduit_*`
 * tables) followed by the conduit FTS migration (adds `conduit_messages_fts` +
 * triggers) — the exact two-layer order `ensureConduitDb` applies.
 *
 * @returns An open FK-enforcing in-memory handle.
 */
function buildPostCutoverConduitDb(): DatabaseSync {
  const Ctor = getDbSyncConstructor();
  const db = new Ctor(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON;');
  for (const body of readMigrationBodies(migrationsDir('drizzle-cleo-project'))) {
    applyMigrationBody(db, body);
  }
  for (const body of readMigrationBodies(migrationsDir('drizzle-conduit'))) {
    applyMigrationBody(db, body);
  }
  return db;
}

/** Collapse runs of whitespace so the snapshot is robust to formatting drift. */
function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;
  return sql.replace(/\s+/g, ' ').trim();
}

describe('T11578 AC4 — conduit DDL snapshot (post-cutover prefixed shape + FTS5)', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = buildPostCutoverConduitDb();
  });

  afterAll(() => {
    db.close();
  });

  it('conduit_* + *_fts* sqlite_master shape matches the committed baseline', () => {
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (name LIKE 'conduit_%' OR name LIKE '%_fts%')
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

  it('the FTS5 index is renamed conduit_messages_fts and its content table is conduit_messages', () => {
    const fts = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conduit_messages_fts'")
      .get() as { sql: string } | undefined;
    expect(fts).toBeDefined();
    expect(fts?.sql).toContain("content='conduit_messages'");
    expect(fts?.sql).toContain("content_rowid='rowid'");

    // No legacy bare FTS index / triggers should survive the cutover.
    const bare = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('messages_fts','messages_ai','messages_ad','messages_au')",
      )
      .all() as Array<{ name: string }>;
    expect(bare).toHaveLength(0);
  });

  it('AFTER-INSERT trigger populates conduit_messages_fts and MATCH returns the row', () => {
    // Seed a parent conversation first (FK conduit_messages → conduit_conversations).
    // Timestamps are canonical TEXT ISO-8601 (the CHECK enforces the ISO GLOB).
    db.exec(`INSERT INTO conduit_conversations (id, participants, created_at, updated_at)
             VALUES ('conv-fts', '["a","b"]', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z')`);
    db.exec(`INSERT INTO conduit_messages
             (id, conversation_id, from_agent_id, to_agent_id, content, created_at)
             VALUES ('msg-fts', 'conv-fts', 'agent-a', 'agent-b', 'hello world', '2026-06-02T00:00:00.000Z')`);

    // The conduit_messages_ai trigger should have indexed the row into the FTS table.
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM conduit_messages_fts').get() as {
      n: number;
    };
    expect(ftsCount.n).toBeGreaterThan(0);

    // MATCH against the FTS index returns the seeded message.
    const hit = db
      .prepare(
        `SELECT m.id AS id FROM conduit_messages m
         WHERE m.rowid IN (SELECT rowid FROM conduit_messages_fts WHERE conduit_messages_fts MATCH 'hello')`,
      )
      .get() as { id: string } | undefined;
    expect(hit?.id).toBe('msg-fts');
  });
});
