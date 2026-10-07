/**
 * Store-level `sync.*` flags (journal spec §5.1, Q8).
 *
 * Each flag is persisted per store in `_sync_meta` and is OFF by default. A
 * store that never enabled one has no `_sync_meta` at all, and reading the
 * flags never writes, so an all-off store is left byte-for-byte untouched.
 *
 * `CLEO_SYNC_<FLAG>=0` (for example `CLEO_SYNC_PUSH=0`) stops that flag's
 * behaviour in the current process. It never turns a flag on, and it never
 * installs or drops anything (M3).
 *
 * @task T12342
 * @module store/sync/flags
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SupersededStoreBareAccount, TableScope } from '@cleocode/contracts';
import { legacyRowProjection } from '../exodus/column-transforms.js';
import { resolveConsolidatedTableName } from '../exodus/table-name-map.js';
import {
  PRIOR_RECOVERIES_TABLE_SQL,
  taskIdCollisionsSql,
} from '../exodus/task-id-collision-sql.js';
import { ROW_IDENTITY } from '../row-identity-registry.js';
import { classifyTable, isPortableTableClass } from '../table-classification.js';
import { ensureSyncSchema, hasTable } from './schema.js';

/** The journal's flags, in slice order. */
export const SYNC_FLAGS = [
  'sync.capture',
  'sync.seal',
  'sync.push',
  'sync.pull',
  'sync.strict',
] as const;

/** One journal flag. */
export type SyncFlag = (typeof SYNC_FLAGS)[number];

/** Every flag's persisted state. */
export type SyncFlagState = Readonly<Record<SyncFlag, boolean>>;

const ALL_OFF: SyncFlagState = Object.freeze(
  Object.fromEntries(SYNC_FLAGS.map((f) => [f, false])) as Record<SyncFlag, boolean>,
);

/**
 * Flags whose slices are not finished: turning one on is refused unless a
 * test opts in (`allowUnreleased`). `sync.seal` stays here until S3b–S3d land
 * (T13032); remove a flag when its slice ships.
 */
export const UNRELEASED_FLAGS: ReadonlySet<SyncFlag> = new Set([
  'sync.seal',
  'sync.push',
  'sync.pull',
  'sync.strict',
]);

/** The environment kill switch for a flag: `sync.push` → `CLEO_SYNC_PUSH`. */
export function killSwitchVar(flag: SyncFlag): string {
  return `CLEO_SYNC_${flag.slice('sync.'.length).toUpperCase()}`;
}

/**
 * The persisted flags of a store. Read-only; all off when the store has no
 * `_sync_meta`.
 */
export function readSyncFlags(db: DatabaseSync): SyncFlagState {
  if (!hasTable(db, '_sync_meta')) return ALL_OFF;
  const rows = db
    .prepare(
      `SELECT key, value FROM _sync_meta WHERE key IN (${SYNC_FLAGS.map(() => '?').join(', ')})`,
    )
    .all(...SYNC_FLAGS) as Array<{ key: SyncFlag; value: string }>;
  const out: Record<SyncFlag, boolean> = { ...ALL_OFF };
  for (const r of rows) out[r.key] = r.value === '1';
  return out;
}

/** Whether any flag is persisted on (the kill switches do not count). */
export function anySyncFlagOn(db: DatabaseSync): boolean {
  return Object.values(readSyncFlags(db)).some(Boolean);
}

/**
 * Whether a flag's behaviour runs in this process: persisted on, and not
 * stopped by its kill switch.
 *
 * @param env - The environment to read the kill switch from.
 */
export function isSyncFlagOn(
  db: DatabaseSync,
  flag: SyncFlag,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[killSwitchVar(flag)] === '0') return false;
  return readSyncFlags(db)[flag];
}

/**
 * The journal's sync set (§2.1): tables declared in ROW_IDENTITY that are
 * portable and not frozen-legacy. Defined here, below the capture machinery
 * (which imports this module), so the strand check can name it (T13225).
 *
 * @param scope - The store scope.
 */
export function syncSetTables(scope: TableScope): string[] {
  return ROW_IDENTITY[scope]
    .map((spec) => spec.table)
    .filter((t) => {
      const c = classifyTable(scope, t);
      return (
        c.kind === 'entry' && isPortableTableClass(c.class) && c.entry.status !== 'frozen-legacy'
      );
    });
}

/** The remedy {@link LegacyOnlyStoreError} names while the store is a full strand. */
export const LEGACY_ONLY_REMEDY = 'cleo doctor superseded-store --reconcile';

/** The task extending the reconcile to partial strands (T13225). */
export const PARTIAL_STRAND_FOLLOW_UP = 'T13309';

/**
 * One bare legacy table holding rows its sync-set twin lacks (T13224, T13225).
 * The journal captures only the sync set, so it would never see them.
 */
export interface LegacyStrand {
  /** The bare legacy table, e.g. `sessions`. */
  readonly bareTable: string;
  /** Its sync-set twin, e.g. `tasks_sessions`. */
  readonly table: string;
  /** Bare rows whose key the twin lacks. */
  readonly missing: number;
  /**
   * Bare `tasks` rows whose id a DIFFERENT live task holds (the T001 reuse
   * case): present by key, absent in substance. Always 0 for other tables.
   */
  readonly shadowed: number;
}

/**
 * The store's bare legacy rows the journal would never see (T13224, T13225).
 *
 * A pair is a bare table outside the sync set whose consolidated target is a
 * sync-set table, so a bare table the runtime still reads (it is in the sync
 * set itself) is never a source. Rows are compared by the twin's primary key,
 * projected as the reconcile projects it ({@link legacyRowProjection}), the
 * same proof as the superseded-store survey. A pair whose keys cannot be
 * compared counts only while its twin is empty. Bare `tasks` rows shadowed by a
 * different live task with the same id ({@link taskIdCollisionsSql}) count too.
 *
 * Dead bare tables are written by nothing since consolidation, so a missing row
 * was never carried — unless a reconcile carried it and the runtime deleted it
 * from the twin since, the normal life of every reconciled store. A bare table
 * a `reconciled` receipt beside the store accounts for (its key digest still
 * matches, {@link bareTableDigest}) is therefore not a strand (T13319).
 *
 * @returns One entry per stranded pair; empty when the journal sees every row.
 */
export function legacyStrands(db: DatabaseSync): LegacyStrand[] {
  const syncSet = new Set(syncSetTables('project'));
  const tables = (
    db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
  const present = new Set(tables);
  const strands: LegacyStrand[] = [];
  let accounted: readonly BareTableRecord[] | null = null;
  for (const bare of tables) {
    if (syncSet.has(bare)) continue;
    const target = resolveConsolidatedTableName('tasks', bare);
    if (target.kind !== 'mapped' || target.targetName === bare) continue;
    const table = target.targetName;
    if (!syncSet.has(table) || !present.has(table) || !hasRows(db, bare)) continue;
    const missing = hasRows(db, table) ? missingByKey(db, bare, table) : countRows(db, bare);
    const shadowed = bare === 'tasks' && table === 'tasks_tasks' ? shadowedTasks(db) : 0;
    if ((missing ?? 0) === 0 && shadowed === 0) continue;
    // A reconcile carried this table, and it has not changed since (T13319).
    accounted ??= reconciledBareTables(db);
    if (isAccounted(db, bare, accounted)) continue;
    strands.push({ bareTable: bare, table, missing: missing ?? 0, shadowed });
  }
  return strands;
}

/** Whether any bare legacy row is stranded from the journal ({@link legacyStrands}). */
export function isLegacyOnlyStore(db: DatabaseSync): boolean {
  return legacyStrands(db).length > 0;
}

/**
 * The remedy for `strands`: the reconcile while `tasks_tasks` is empty (it
 * copies the bare family only then), otherwise none yet ({@link
 * PARTIAL_STRAND_FOLLOW_UP}).
 */
export function legacyStrandRemedy(db: DatabaseSync, strands: readonly LegacyStrand[]): string {
  const counts = strands
    .map(
      (s) =>
        `${s.bareTable} → ${s.table}: ${s.missing} missing` +
        (s.shadowed > 0 ? `, ${s.shadowed} shadowed by a reused id` : ''),
    )
    .join('; ');
  if (!hasTable(db, 'tasks_tasks') || !hasRows(db, 'tasks_tasks')) {
    return `Stranded bare rows (${counts}). Run \`${LEGACY_ONLY_REMEDY}\` first.`;
  }
  return (
    `Stranded bare rows (${counts}). \`${LEGACY_ONLY_REMEDY}\` cannot yet copy bare rows ` +
    `into a populated store; ${PARTIAL_STRAND_FOLLOW_UP} adds that. Keep the bare tables ` +
    `until then.`
  );
}

/** Sync refused on a store with stranded bare rows ({@link legacyStrands}). */
export class LegacyOnlyStoreError extends Error {
  readonly code = 'E_SYNC_LEGACY_ONLY_STORE';

  /**
   * @param flag - The flag being enabled.
   * @param remedy - {@link legacyStrandRemedy} for the store.
   */
  constructor(flag: string, remedy: string) {
    super(
      `E_SYNC_LEGACY_ONLY_STORE: ${flag} refused: this store holds rows only in the bare ` +
        `legacy tables, where the journal would never see them. ${remedy}`,
    );
    this.name = 'LegacyOnlyStoreError';
  }
}

/**
 * {@link legacyStrands} decided once per `PRAGMA data_version` of a connection
 * (T13319): the sealer asks on every batch, while a strand can only appear or
 * clear through another connection's commit (bare tables are dead; a
 * reconcile writes through its own connection). This connection's own writes
 * never move `data_version`, and never strand a row.
 */
const strandsByConnection = new WeakMap<
  DatabaseSync,
  { readonly version: number; readonly strands: LegacyStrand[] }
>();

/**
 * {@link legacyStrands}, reused while no other connection has committed.
 *
 * @param db - The store connection the sealer uses.
 */
export function legacyStrandsCached(db: DatabaseSync): LegacyStrand[] {
  const version = Number(
    (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
  );
  const hit = strandsByConnection.get(db);
  if (hit && hit.version === version) return hit.strands;
  const strands = legacyStrands(db);
  strandsByConnection.set(db, { version, strands });
  return strands;
}

/** Prefix of a reconcile's run directory under `.cleo/` (T12319). */
const RECONCILE_RUN_PREFIX = 'exodus-reconcile-';

/** The receipt file in a reconcile run directory. */
const RECONCILE_RECEIPT_FILE = 'reconcile-receipt.json';

/** Logical source names a full reconcile gives the live store's bare family. */
const BARE_FAMILY_SOURCE_PREFIX = 'tasks (cleo.db bare';

/**
 * A bare table a reconcile carried. `digest` is `null` for a receipt written
 * before T13319, which names the table but records no digest.
 */
interface BareTableRecord {
  readonly table: string;
  readonly rows: number | null;
  readonly digest: string | null;
}

/**
 * The row count and key digest of a bare legacy table, by which a reconcile
 * receipt accounts for it (T13319). Its primary-key values are hashed in order
 * — the rows a strand is judged by — so a row added since changes it, while a
 * column the runtime adds to the dead table on open (its legacy upgrade does)
 * does not. A keyless table hashes every column.
 *
 * @param db - Connection holding the table.
 * @param schema - Schema the table lives in, e.g. `main`.
 * @param table - The bare table.
 */
export function bareTableDigest(
  db: DatabaseSync,
  schema: string,
  table: string,
): SupersededStoreBareAccount {
  const info = db.prepare(`PRAGMA "${schema}".table_info("${table}")`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const pk = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const cols = (pk.length > 0 ? pk : info.map((c) => c.name)).map((c) => `quote("${c}")`);
  const hash = createHash('sha256');
  let rows = 0;
  for (const row of db
    .prepare(`SELECT ${cols.join(" || ',' || ")} AS r FROM "${schema}"."${table}" ORDER BY 1`)
    .iterate() as Iterable<{ r: string }>) {
    hash.update(`${row.r}\n`);
    rows++;
  }
  return { table, rows, digest: hash.digest('hex') };
}

/**
 * Bare tables carried by `reconciled` receipts beside the store
 * (`<dir of cleo.db>/exodus-reconcile-*`). A receipt with `accounted` names
 * each table with its digest; an older one (before T13319) names the bare
 * tables it copied in `before`, without a digest — dead tables do not change,
 * so the name is enough. Unreadable or malformed receipts are skipped.
 */
function reconciledBareTables(db: DatabaseSync): BareTableRecord[] {
  const file = (
    db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
  ).find((d) => d.name === 'main')?.file;
  if (!file) return [];
  const dir = dirname(file);
  if (!existsSync(dir)) return [];
  const out: BareTableRecord[] = [];
  for (const run of readdirSync(dir)
    .filter((n) => n.startsWith(RECONCILE_RUN_PREFIX))
    .sort()) {
    let receipt: unknown;
    try {
      receipt = JSON.parse(readFileSync(join(dir, run, RECONCILE_RECEIPT_FILE), 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(receipt) || receipt.outcome !== 'reconciled') continue;
    if (Array.isArray(receipt.accounted)) {
      for (const a of receipt.accounted) {
        if (
          isRecord(a) &&
          typeof a.table === 'string' &&
          typeof a.rows === 'number' &&
          typeof a.digest === 'string'
        ) {
          out.push({ table: a.table, rows: a.rows, digest: a.digest });
        }
      }
      continue;
    }
    for (const c of Array.isArray(receipt.before) ? receipt.before : []) {
      if (
        isRecord(c) &&
        typeof c.sourceDb === 'string' &&
        c.sourceDb.startsWith(BARE_FAMILY_SOURCE_PREFIX) &&
        typeof c.sourceTable === 'string'
      ) {
        out.push({ table: c.sourceTable, rows: null, digest: null });
      }
    }
  }
  return out;
}

/** Whether `bare` is unchanged since a receipt in `records` carried it. */
function isAccounted(db: DatabaseSync, bare: string, records: readonly BareTableRecord[]): boolean {
  const mine = records.filter((r) => r.table === bare);
  if (mine.length === 0) return false;
  if (mine.some((r) => r.digest === null)) return true;
  const now = bareTableDigest(db, 'main', bare);
  return mine.some((r) => r.rows === now.rows && r.digest === now.digest);
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `table` holds at least one row. */
function hasRows(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT EXISTS (SELECT 1 FROM main."${table}") AS n`).get() as {
    n: number;
  };
  return row.n === 1;
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM main."${table}"`).get() as { n: number }).n;
}

function columns(db: DatabaseSync, table: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA main.table_info("${table}")`).all() as Array<{
    name: string;
    pk: number;
  }>;
}

/**
 * Bare rows whose twin primary key is absent from the twin, or `null` when the
 * bare table cannot produce every key column.
 */
function missingByKey(db: DatabaseSync, bare: string, table: string): number | null {
  const pk = columns(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const bareCols = new Set(columns(db, bare).map((c) => c.name));
  const projection = legacyRowProjection(table, bare);
  const keyOf = (c: string): string | null => {
    const project = projection.get(c);
    if (project) return project((name) => `s."${name}"`);
    return bareCols.has(c) ? `s."${c}"` : null;
  };
  if (pk.length === 0 || !pk.every((c) => keyOf(c) !== null)) return null;
  const match = pk.map((c) => `t."${c}" = ${keyOf(c)}`).join(' AND ');
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM main."${bare}" s ` +
          `WHERE NOT EXISTS (SELECT 1 FROM main."${table}" t WHERE ${match})`,
      )
      .get() as { n: number }
  ).n;
}

/** Bare `tasks` rows shadowed by a different live task with their id. */
function shadowedTasks(db: DatabaseSync): number {
  const distinguishing = (t: string): boolean => {
    const names = new Set(columns(db, t).map((c) => c.name));
    return names.has('title') && names.has('created_at') && names.has('type');
  };
  if (!distinguishing('tasks') || !distinguishing('tasks_tasks')) return 0;
  db.exec(PRIOR_RECOVERIES_TABLE_SQL);
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (${taskIdCollisionsSql('main.tasks')}) WHERE recoveredAs IS NULL`,
      )
      .get() as { n: number }
  ).n;
}

/**
 * Persist a flag. Turning one on first applies the sync schema; turning one
 * off on a store without the schema writes nothing.
 *
 * Prerequisite checks (`cleo sync enable <flag>`) live with the slice that
 * gives the flag its behaviour; this is the storage primitive.
 *
 * @returns Whether the stored value changed.
 */
export function setSyncFlag(
  db: DatabaseSync,
  flag: SyncFlag,
  on: boolean,
  options: { now?: Date; schemaRoot?: string; allowUnreleased?: boolean } = {},
): boolean {
  // @sync-invariant none:local-only unknown flag name from a local caller; sync flags are per-store settings, not synced rows
  if (!SYNC_FLAGS.includes(flag)) throw new Error(`unknown sync flag: ${flag}`);
  if (on && UNRELEASED_FLAGS.has(flag) && options.allowUnreleased !== true) {
    // @sync-invariant none:local-only a local operator cannot turn on an unfinished journal slice; a per-store setting, not synced rows
    throw Object.assign(
      new Error(
        `E_SYNC_FLAG_UNRELEASED: ${flag} cannot be enabled until its slices land (T12343: S3b–S3d for sync.seal)`,
      ),
      { code: 'E_SYNC_FLAG_UNRELEASED' },
    );
  }
  const strands = on ? legacyStrands(db) : [];
  if (strands.length > 0) {
    // @sync-invariant none:local-only enabling sync on a store whose rows the journal cannot see is refused; a per-store setting
    throw new LegacyOnlyStoreError(flag, legacyStrandRemedy(db, strands));
  }
  if (!on && !hasTable(db, '_sync_meta')) return false;
  if (readSyncFlags(db)[flag] === on) return false;
  ensureSyncSchema(db, { root: options.schemaRoot, now: options.now });
  const stamp = (options.now ?? new Date()).toISOString();
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(flag, on ? '1' : '0', stamp);
  return true;
}
