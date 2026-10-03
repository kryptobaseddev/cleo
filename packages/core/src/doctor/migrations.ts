/**
 * `cleo doctor migrations`: the migration journal of each store, read-only
 * (journal spec §2.3a rule 2, "journal safety check"; R5-3 T12796).
 *
 * Every S2+ acceptance run reads the live journal count through this report,
 * never through a literal: per scope, the journal's row count and head row,
 * and per lineage sharing that journal, how many of its migration files are
 * applied, which are pending, and any drift (a journal row with a local
 * migration's name but a different hash, the #1719 condition). Rows no known
 * lineage explains are listed too.
 *
 * A journal rebuilt from empty on a store that already held its schema (a
 * vault restore before T13104 emptied it) is named, with how many rows the
 * migrator stamped applied without running their SQL.
 *
 * The store is opened as a read-only snapshot; nothing is written.
 *
 * @module
 * @task T12796
 * @task T13104
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type DualScope, resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import {
  CONSOLIDATED_JOURNAL_LINEAGES,
  resolveCorePackageMigrationsFolder,
} from '../store/resolve-migrations-folder.js';

/** Lineages the project store's journal runs (the consolidated one first). */
export const PROJECT_LINEAGES: readonly string[] = [
  'drizzle-cleo-project',
  'drizzle-tasks',
  'drizzle-brain',
  'drizzle-nexus',
  'drizzle-conduit',
];

/** Lineages the global store's journal runs. */
export const GLOBAL_LINEAGES: readonly string[] = [
  'drizzle-cleo-global',
  'drizzle-agent-registry',
  'drizzle-skills',
  'drizzle-telemetry',
];

/** Each scope's consolidated lineage: its first migration opens a journal built on an empty store. */
const BASELINE_LINEAGE: Readonly<Record<DualScope, string>> = {
  project: 'drizzle-cleo-project',
  global: 'drizzle-cleo-global',
};

/** A journal rebuilt on a store that already held its schema (T13104). */
export interface RebuiltJournalReport {
  /** Rows recorded applied without their SQL having run on this file (`applied_at` NULL). */
  readonly stamped: number;
  /** What happened and what it means. */
  readonly detail: string;
}

/** One lineage's standing in a journal. */
export interface LineageMigrationReport {
  readonly lineage: string;
  /** Migration files in the installed folder. */
  readonly local: number;
  /** Local files whose hash is in the journal. */
  readonly applied: number;
  /** Local files whose name is not in the journal. */
  readonly pending: string[];
}

/** One journal row, as the report shows it. */
export interface JournalRowReport {
  readonly id: number;
  readonly name: string | null;
  readonly hash: string;
}

/** A store's migration journal. */
export interface ScopeMigrationReport {
  readonly scope: DualScope;
  readonly dbPath: string;
  readonly exists: boolean;
  /** Rows in `__drizzle_migrations`. */
  readonly journalRows: number;
  /** The row with the largest id. */
  readonly head: JournalRowReport | null;
  readonly lineages: LineageMigrationReport[];
  /** Rows named like a local migration whose hash differs (#1719 drift). */
  readonly drift: Array<JournalRowReport & { fileHash: string; lineage: string }>;
  /** Rows no installed lineage knows (a newer build, or a foreign lineage). */
  readonly unknown: JournalRowReport[];
  /**
   * Set when the journal opens with the consolidated baseline stamped applied
   * (`applied_at` NULL) instead of run: the migrator rebuilt it from empty on a
   * store that already held the schema. `null` otherwise.
   */
  readonly rebuilt: RebuiltJournalReport | null;
}

/** The report of every scope. */
export interface MigrationsReport {
  readonly scopes: ScopeMigrationReport[];
}

interface LocalMigration {
  readonly name: string;
  readonly hash: string;
}

/** The lineage's migration files, hashed as drizzle's readMigrationFiles hashes them. */
function localMigrations(folder: string): LocalMigration[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((d) => existsSync(join(folder, d, 'migration.sql')))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      hash: createHash('sha256')
        .update(readFileSync(join(folder, name, 'migration.sql')).toString())
        .digest('hex'),
    }));
}

/**
 * Inspect one store's journal. Read-only.
 *
 * @param scope - Which store.
 * @param dbPath - The store file.
 * @param lineages - Lineages to report (installed folders). Every consolidated
 *   lineage still counts as known for drift and unknown rows.
 * @param folderOf - Folder resolver (tests pass their own).
 */
export function inspectJournal(
  scope: DualScope,
  dbPath: string,
  lineages: readonly string[] = CONSOLIDATED_JOURNAL_LINEAGES,
  folderOf: (lineage: string) => string = resolveCorePackageMigrationsFolder,
): ScopeMigrationReport {
  const base = {
    scope,
    dbPath,
    journalRows: 0,
    head: null,
    lineages: [],
    drift: [],
    unknown: [],
    rebuilt: null,
  };
  if (!existsSync(dbPath)) return { ...base, exists: false };
  const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
  try {
    const db = snap.db;
    const hasJournal =
      db
        .prepare(
          "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
        )
        .get() !== undefined;
    if (!hasJournal) return { ...base, exists: true };
    const columns = new Set(
      (
        db.prepare('PRAGMA main.table_info("__drizzle_migrations")').all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    const hasName = columns.has('name');
    const rows = db
      .prepare(
        `SELECT id, ${hasName ? 'name' : 'NULL AS name'}, hash FROM main."__drizzle_migrations" ORDER BY id`,
      )
      .all() as unknown as JournalRowReport[];
    const byHash = new Set(rows.map((r) => r.hash));
    const byName = new Map(rows.filter((r) => r.name).map((r) => [r.name as string, r]));
    // Every hash any installed lineage defines: a row whose hash is here is
    // accounted for, even when another lineage has a file of the same name
    // (drizzle-cleo-project and drizzle-cleo-global share some names).
    const known = new Set<string>();
    const locals = new Map<string, LocalMigration[]>();
    for (const lineage of new Set([...lineages, ...CONSOLIDATED_JOURNAL_LINEAGES])) {
      const local = localMigrations(folderOf(lineage));
      if (lineages.includes(lineage)) locals.set(lineage, local);
      for (const m of local) known.add(m.hash);
    }
    const reports: LineageMigrationReport[] = [];
    const drift: ScopeMigrationReport['drift'] = [];
    for (const [lineage, local] of locals) {
      const applied = local.filter((m) => byHash.has(m.hash)).length;
      if (applied === 0) continue; // a lineage this journal never ran
      reports.push({
        lineage,
        local: local.length,
        applied,
        pending: local.filter((m) => !byName.has(m.name) && !byHash.has(m.hash)).map((m) => m.name),
      });
      for (const m of local) {
        const row = byName.get(m.name);
        if (row && !known.has(row.hash)) drift.push({ ...row, fileHash: m.hash, lineage });
      }
    }
    return {
      scope,
      dbPath,
      exists: true,
      journalRows: rows.length,
      head: rows.at(-1) ?? null,
      lineages: reports,
      drift,
      unknown: rows.filter((r) => !known.has(r.hash) && !drift.some((d) => d.id === r.id)),
      rebuilt: columns.has('applied_at')
        ? rebuiltJournal(db, rows[0], localMigrations(folderOf(BASELINE_LINEAGE[scope]))[0])
        : null,
    };
  } finally {
    snap.close();
  }
}

/**
 * Whether a journal was rebuilt from empty on a store that already held its
 * schema. A store built by its migrations runs the consolidated baseline first
 * and records when (`applied_at`); a journal whose first row is that baseline
 * with no `applied_at` was stamped by the reconciler, which only happens when
 * the journal was empty and the baseline's tables already existed.
 */
function rebuiltJournal(
  db: DatabaseSync,
  first: JournalRowReport | undefined,
  baseline: LocalMigration | undefined,
): RebuiltJournalReport | null {
  if (!first || !baseline || first.hash !== baseline.hash) return null;
  const row = db
    .prepare('SELECT applied_at IS NULL AS s FROM main."__drizzle_migrations" WHERE id = ?')
    .get(first.id) as { s: number } | undefined;
  if (row?.s !== 1) return null;
  const stamped = (
    db
      .prepare('SELECT count(*) AS n FROM main."__drizzle_migrations" WHERE applied_at IS NULL')
      .get() as { n: number }
  ).n;
  return {
    stamped,
    detail:
      `the journal was rebuilt on a store that already held its schema: ${stamped} migration(s) ` +
      'are recorded applied without their SQL having run on this file. A vault restore or pull ' +
      'before T13104 did this (it emptied the journal). Such a store got its schema whole with ' +
      'the snapshot, so the stamps hold; the rebuild may also have re-run old migrations, which ' +
      "can leave an extra index on a legacy table. Otherwise the stamped migrations' indexes, " +
      'triggers and CHECK constraints were never verified here.',
  };
}

/**
 * The migration journals of the project store (at `projectRoot`) and the
 * global store. Read-only.
 */
export function inspectMigrations(projectRoot: string): MigrationsReport {
  return {
    scopes: [
      inspectJournal('project', resolveDualScopeDbPath('project', projectRoot), PROJECT_LINEAGES),
      inspectJournal('global', resolveDualScopeDbPath('global'), GLOBAL_LINEAGES),
    ],
  };
}
