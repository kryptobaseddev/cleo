/**
 * Trigger classes and the suspension clause (journal spec §3.5 Rule 4, C2,
 * D4; T12813, T12819, T12827).
 *
 * Every trigger in a store has exactly one class. The class decides whether
 * the trigger carries the suspension clause, which a rebase frame uses to
 * turn a class off inside its own transaction:
 *
 * | Class | Carries the clause | Example |
 * |---|---|---|
 * | `capture` | yes, scope `capture` | `_sync_cap_*` (S2 capture triggers) |
 * | `guard` | yes, scope `guard` | the parent-cycle and status-pipeline guards |
 * | `side-effect` | yes, scope `side-effect` | claim release, the handoff mirror |
 * | `derived-maintenance` | no, always active | FTS `_ai`/`_ad`/`_au` |
 * | `frozen-guard` | no, never modified | triggers on frozen-legacy bare twins |
 *
 * `guard` and `side-effect` triggers are OWNED: {@link OWNED_TRIGGERS} names
 * each one, and its DDL is the last `CREATE TRIGGER` for that name in the
 * migration lineage from the C2 migration on ({@link ownedTriggerDdl}). The
 * open pass and the doctor compare each owned trigger's LIVE text with that
 * DDL and re-run the DDL when it differs or is missing (C2(b)).
 *
 * A trigger on a `frozen-legacy` table is `frozen-guard` whatever its name:
 * a rebase never touches a frozen twin, and giving such a trigger a clause
 * would make 9.24's replace-if-text-differs (`twin-collapse.ts`) and this
 * build's repair flip its DDL on every open that alternates builds (D4).
 *
 * @task T12819
 * @task T12827
 * @module store/sync/trigger-classes
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';
import { classifyTable } from '../table-classification.js';

/** A trigger class. */
export type TriggerClass =
  | 'capture'
  | 'guard'
  | 'side-effect'
  | 'derived-maintenance'
  | 'frozen-guard';

/** The classes that carry the suspension clause. */
export type SuspendableClass = 'capture' | 'guard' | 'side-effect';

/** The schema-owned flag table the suspension clause reads. Never dropped. */
export const TRIGGER_SUSPEND_TABLE = 'cleo_trigger_suspend';

/**
 * DDL of the flag table, byte-identical to the C2 migration's first
 * statement. The open pass runs it (step 0) before migrations.
 */
export const TRIGGER_SUSPEND_TABLE_DDL = `CREATE TABLE IF NOT EXISTS \`cleo_trigger_suspend\` (
  \`scope\` TEXT PRIMARY KEY NOT NULL CHECK (\`scope\` IN ('capture', 'guard', 'side-effect', 'all'))
)`;

/** The C2 migration folder (drizzle-cleo-project). Owned DDL is read from it on. */
export const TRIGGER_CLAUSE_MIGRATION = '20260930000000_t12819-trigger-suspend-clause';

/** The lineage the owned triggers live in. */
export const OWNED_TRIGGER_LINEAGE = 'drizzle-cleo-project';

/**
 * The suspension clause a trigger of `cls` carries, exactly as written in
 * migration SQL. Verification compares it whitespace-normalized.
 *
 * The table name is unqualified on purpose. A persistent trigger resolves an
 * unqualified name in its own schema (a TEMP table cannot shadow it), so the
 * trigger keeps working when the store is ATTACHed under another name; a
 * `main.` qualifier makes an attached schema unreadable ("cannot reference
 * objects in database main").
 */
export function suspendClause(cls: SuspendableClass): string {
  return `NOT EXISTS (SELECT 1 FROM cleo_trigger_suspend WHERE scope IN ('${cls}', 'all'))`;
}

/**
 * The owned guard and side-effect triggers (project store), by name. Each
 * one's DDL comes from the migration lineage ({@link ownedTriggerDdl}).
 */
export const OWNED_TRIGGERS: Readonly<Record<string, 'guard' | 'side-effect'>> = {
  tasks_tasks_parent_cycle_guard_insert: 'guard',
  tasks_tasks_parent_cycle_guard_update: 'guard',
  tasks_tasks_parent_type_matrix_insert: 'guard',
  tasks_tasks_parent_type_matrix_update: 'guard',
  trg_tasks_tasks_status_pipeline_insert: 'guard',
  trg_tasks_tasks_status_pipeline_update: 'guard',
  tasks_task_relations_non_containment_insert: 'guard',
  tasks_task_relations_non_containment_update: 'guard',
  tasks_task_acceptance_child_target_insert: 'guard',
  tasks_task_acceptance_child_target_update: 'guard',
  trg_tasks_session_handoff_no_update: 'guard',
  tasks_tasks_lease_iso_insert: 'guard',
  tasks_tasks_lease_iso_update: 'guard',
  trg_tasks_session_handoff_mirror: 'side-effect',
  tasks_sessions_release_claims_on_end: 'side-effect',
  tasks_sessions_release_claims_on_delete: 'side-effect',
  tasks_tasks_release_claim_on_terminal: 'side-effect',
};

/** Prefix of every capture trigger (S2, §2.3). */
export const CAPTURE_TRIGGER_PREFIX = '_sync_cap_';

/** A classified trigger. */
export interface TriggerClassification {
  readonly name: string;
  readonly table: string;
  readonly class: TriggerClass;
  /** Why it has this class. */
  readonly reason: string;
}

/**
 * The tables a trigger body writes: `INSERT INTO t`, `UPDATE t`,
 * `DELETE FROM t`, `REPLACE INTO t`. Lower-cased; quotes stripped.
 */
export function triggerWriteTargets(sql: string): string[] {
  const body = sql.slice(Math.max(0, sql.search(/\bBEGIN\b/i)));
  const out = new Set<string>();
  const re =
    /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+[`"[]?(?:main\.)?[`"[]?(\w+)/gi;
  for (const m of body.matchAll(re)) out.add((m[1] as string).toLowerCase());
  return [...out];
}

/**
 * Classify one trigger. Returns `undefined` for a trigger no rule covers,
 * which the Gate test reports.
 *
 * @param scope - The store the trigger lives in.
 * @param name - `sqlite_master.name`.
 * @param table - `sqlite_master.tbl_name`.
 * @param sql - `sqlite_master.sql`.
 */
export function classifyTrigger(
  scope: TableScope,
  name: string,
  table: string,
  sql: string,
): TriggerClassification | undefined {
  if (name.startsWith(CAPTURE_TRIGGER_PREFIX)) {
    return { name, table, class: 'capture', reason: 'journal capture trigger (§2.3)' };
  }
  const tableClass = classifyTable(scope, table);
  if (tableClass.kind === 'entry' && tableClass.entry.status === 'frozen-legacy') {
    return {
      name,
      table,
      class: 'frozen-guard',
      reason: 'on a frozen-legacy bare twin: no clause, never rewritten (D4)',
    };
  }
  if (name.startsWith('t12535_freeze_')) {
    return { name, table, class: 'frozen-guard', reason: 'twin-collapse freeze trigger (D4)' };
  }
  const owned = OWNED_TRIGGERS[name];
  if (owned !== undefined) {
    return { name, table, class: owned, reason: 'owned by the C2 migration (T12819)' };
  }
  const targets = triggerWriteTargets(sql);
  if (
    targets.length > 0 &&
    targets.every((t) => {
      const c = classifyTable(scope, t);
      return (c.kind === 'entry' || c.kind === 'pattern') && c.class === 'derived';
    })
  ) {
    return {
      name,
      table,
      class: 'derived-maintenance',
      reason: `writes only derived tables (${targets.join(', ')}); always active`,
    };
  }
  return undefined;
}

/** Collapse whitespace so text comparisons ignore layout. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/, '')
    .trim();
}

/**
 * Split migration text into `CREATE TRIGGER` statements, by name. Later
 * definitions of the same name replace earlier ones. `IF NOT EXISTS` is
 * removed, as SQLite removes it from `sqlite_master.sql`.
 */
export function createTriggerStatements(migrationSql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of migrationSql.split('--> statement-breakpoint')) {
    const stmt = chunk.replace(/^(?:\s*--[^\n]*\n|\s*\n)*/, '').trim();
    const m = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i.exec(stmt);
    if (!m) continue;
    out.set(
      m[1] as string,
      stmt
        .replace(/^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+/i, 'CREATE TRIGGER ')
        .replace(/;$/, ''),
    );
  }
  return out;
}

/**
 * The owned trigger DDL: the last `CREATE TRIGGER` for each owned name in
 * the lineage's migration files from {@link TRIGGER_CLAUSE_MIGRATION} on, in
 * folder order.
 *
 * @param folder - The lineage folder (tests pass one; default: installed).
 * @throws {Error} When an owned trigger has no DDL from C2 on.
 */
export function ownedTriggerDdl(
  folder: string = resolveCorePackageMigrationsFolder(OWNED_TRIGGER_LINEAGE),
): Map<string, string> {
  const cached = ownedDdlCache.get(folder);
  if (cached) return cached;
  const ddl = new Map<string, string>();
  const names = readdirSync(folder)
    .filter((n) => n >= TRIGGER_CLAUSE_MIGRATION && existsSync(join(folder, n, 'migration.sql')))
    .sort();
  for (const n of names) {
    for (const [name, sql] of createTriggerStatements(
      readFileSync(join(folder, n, 'migration.sql'), 'utf8'),
    )) {
      if (Object.hasOwn(OWNED_TRIGGERS, name)) ddl.set(name, sql);
    }
  }
  const missing = Object.keys(OWNED_TRIGGERS).filter((n) => !ddl.has(n));
  if (missing.length > 0) {
    throw new Error(
      `owned triggers without DDL from ${TRIGGER_CLAUSE_MIGRATION}: ${missing.join(', ')}`,
    );
  }
  ownedDdlCache.set(folder, ddl);
  return ddl;
}

/** Owned DDL per lineage folder: migration files never change at runtime. */
const ownedDdlCache = new Map<string, Map<string, string>>();

/** One finding of {@link verifyOwnedTriggers}. */
export interface OwnedTriggerFinding {
  readonly name: string;
  readonly problem: 'missing' | 'text-differs' | 'no-clause';
  readonly repaired: boolean;
}

/** Whether the flag table exists. Read-only. */
export function hasTriggerSuspendTable(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?")
      .get(TRIGGER_SUSPEND_TABLE) !== undefined
  );
}

/**
 * Compare every owned trigger's live `sqlite_master.sql` with its owned DDL,
 * and optionally repair (drop, then re-run the owned DDL) each one that is
 * missing or differs.
 *
 * Only meaningful on a store whose journal has the C2 migration: before it,
 * the owned DDL references a table the store may not have. Callers check
 * {@link hasTriggerSuspendTable} and that the owned tables exist.
 *
 * @param db - A project store handle.
 * @param options - `repair` rewrites; `ddl` overrides the owned DDL (tests).
 * @returns One finding per trigger that was not identical.
 */
export function verifyOwnedTriggers(
  db: DatabaseSync,
  options: { repair?: boolean; ddl?: Map<string, string> } = {},
): OwnedTriggerFinding[] {
  const ddl = options.ddl ?? ownedTriggerDdl();
  const live = new Map(
    (
      db
        .prepare("SELECT name, tbl_name, sql FROM main.sqlite_master WHERE type = 'trigger'")
        .all() as Array<{ name: string; tbl_name: string; sql: string }>
    ).map((r) => [r.name, r]),
  );
  const findings: OwnedTriggerFinding[] = [];
  for (const [name, cls] of Object.entries(OWNED_TRIGGERS)) {
    const want = ddl.get(name) as string;
    const onTable = /\bON\s+[`"]?(\w+)[`"]?/i.exec(want.slice(0, want.search(/\bBEGIN\b/i)))?.[1];
    // The trigger's table may not exist in this store shape (a store the
    // owning migration never reached); nothing to verify then.
    if (
      onTable &&
      db
        .prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?")
        .get(onTable) === undefined
    ) {
      continue;
    }
    const row = live.get(name);
    let problem: OwnedTriggerFinding['problem'] | undefined;
    if (!row) problem = 'missing';
    else if (normalizeSql(row.sql) !== normalizeSql(want)) {
      problem = normalizeSql(row.sql).includes(normalizeSql(suspendClause(cls)))
        ? 'text-differs'
        : 'no-clause';
    }
    if (!problem) continue;
    let repaired = false;
    if (options.repair) {
      db.exec(`DROP TRIGGER IF EXISTS \`${name}\``);
      db.exec(want);
      repaired = true;
    }
    findings.push({ name, problem, repaired });
  }
  return findings;
}

/**
 * Classify every trigger of a store. Read-only.
 *
 * @returns The classified triggers, and the names no rule covers.
 */
export function classifyStoreTriggers(
  db: DatabaseSync,
  scope: TableScope,
): { classified: TriggerClassification[]; unclassified: string[] } {
  const rows = db
    .prepare(
      "SELECT name, tbl_name, sql FROM main.sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string }>;
  const classified: TriggerClassification[] = [];
  const unclassified: string[] = [];
  for (const r of rows) {
    const c = classifyTrigger(scope, r.name, r.tbl_name, r.sql);
    if (c) classified.push(c);
    else unclassified.push(r.name);
  }
  return { classified, unclassified };
}

/** What the open pass's step 0 did to the flag table. */
export interface TriggerSuspendStepZero {
  /** The table was missing and was created. */
  readonly created: boolean;
  /** Committed suspension rows found and cleared (should never happen). */
  readonly cleared: number;
}

/**
 * Open-pass step 0 (C2, round 9): make sure `cleo_trigger_suspend` exists,
 * BEFORE migrations, and that it is empty.
 *
 * Every write to tasks, sessions and acceptance criteria fires an owned
 * trigger that reads the table, and any `ALTER … RENAME` re-validates every
 * trigger, so a store missing it cannot be written. A committed row is
 * impossible through the rebase frame (it deletes and asserts before
 * COMMIT); if one is found anyway it is cleared, because a committed
 * suspension would silently disable guards for everyone.
 *
 * Writes nothing when the table exists and is empty.
 */
export function ensureTriggerSuspendTable(db: DatabaseSync): TriggerSuspendStepZero {
  if (!hasTriggerSuspendTable(db)) {
    db.exec(TRIGGER_SUSPEND_TABLE_DDL);
    return { created: true, cleared: 0 };
  }
  const n = (
    db.prepare('SELECT count(*) AS n FROM main.cleo_trigger_suspend').get() as { n: number }
  ).n;
  if (n > 0) db.exec('DELETE FROM main.cleo_trigger_suspend');
  return { created: false, cleared: n };
}

/**
 * Throw unless `cleo_trigger_suspend` is empty. A frame calls this right
 * before COMMIT, so a suspension can never be committed (C4).
 *
 * @throws {Error} `E_TRIGGER_SUSPEND_NOT_EMPTY` when a row remains.
 */
export function assertTriggerSuspendEmpty(db: DatabaseSync): void {
  const row = db.prepare('SELECT scope FROM main.cleo_trigger_suspend LIMIT 1').get() as
    | { scope: string }
    | undefined;
  if (row) {
    throw Object.assign(
      new Error(
        `E_TRIGGER_SUSPEND_NOT_EMPTY: cleo_trigger_suspend still holds scope '${row.scope}'; refusing to commit a suspension`,
      ),
      { code: 'E_TRIGGER_SUSPEND_NOT_EMPTY' },
    );
  }
}

/**
 * Run `fn` with the given trigger classes suspended, inside the caller's
 * transaction: insert the scope rows, run, delete them, and assert the table
 * is empty before returning. Other connections never see the rows (WAL), so
 * their triggers stay active; a crash rolls the rows back.
 *
 * @throws {Error} When called outside a transaction.
 */
export function withTriggersSuspended<T>(
  db: DatabaseSync,
  scopes: ReadonlyArray<SuspendableClass | 'all'>,
  fn: () => T,
): T {
  if (!db.isTransaction) {
    throw new Error('withTriggersSuspended must run inside the caller transaction');
  }
  const ins = db.prepare('INSERT OR IGNORE INTO main.cleo_trigger_suspend (scope) VALUES (?)');
  for (const s of scopes) ins.run(s);
  try {
    return fn();
  } finally {
    db.exec('DELETE FROM main.cleo_trigger_suspend');
    assertTriggerSuspendEmpty(db);
  }
}
