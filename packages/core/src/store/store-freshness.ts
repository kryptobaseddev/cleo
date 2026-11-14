/** Per-key store freshness shared by doctor and snapshot retention; no domain binders. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  StoreFreshnessFinding,
  StoreTableHighWater,
} from '@cleocode/contracts/db-recovery.js';
import { openNativeDatabase } from './sqlite-native.js';

/** Each key's own timestamp is compared; unrelated writes cannot hide a missing row. */
function storeRowTimestamp(columns: readonly string[]): string {
  const stamps = [
    'updated_at',
    'created_at',
    'timestamp',
    'started_at',
    'ended_at',
    'last_activity',
    'task_started_at',
    'accepted_at',
    'valid_at',
  ]
    .filter((c) => columns.includes(c))
    .map((c) => `coalesce(unixepoch("${c}", 'subsec'), 0)`);
  return stamps.length > 1 ? `max(${stamps.join(',')})` : (stamps[0] ?? '0');
}

/** Key tables cover task, session, decision, audit and memory history in both scopes. */
function storeHighWater(db: DatabaseSync): StoreTableHighWater[] {
  const out: StoreTableHighWater[] = [];
  for (const table of [
    'tasks_tasks',
    'tasks_sessions',
    'tasks_audit_log',
    'tasks_architecture_decisions',
    'brain_decisions',
    'brain_observations',
    'nexus_audit_log',
  ]) {
    const columns = db
      .prepare(`PRAGMA main.table_info("${table}")`)
      .all()
      .map((c) => String(c.name));
    if (!columns.includes('id')) continue;
    const row = db
      .prepare(`SELECT count(*) AS n, CAST(max(_rowid_) AS TEXT) AS rowid,
      max(${storeRowTimestamp(columns)}) AS latest FROM main."${table}"`)
      .get();
    out.push({
      table,
      rows: Number(row?.n ?? 0),
      maxRowid: typeof row?.rowid === 'string' ? row.rowid : null,
      latestAt: typeof row?.latest === 'number' && row.latest > 0 ? row.latest : null,
    });
  }
  return out;
}

/** Missing keys and older versions are evidence even after a newer live session or audit write. */
export function compareStoreFreshness(
  live: DatabaseSync,
  source: DatabaseSync,
  path: string,
  kind: StoreFreshnessFinding['kind'],
): StoreFreshnessFinding | undefined {
  const before = storeHighWater(live);
  const after = storeHighWater(source);
  if (
    before.some((t) => t.table === 'tasks_tasks') !== after.some((t) => t.table === 'tasks_tasks')
  )
    return;
  const evidence: string[] = [];
  for (const next of after) {
    const old = before.find((t) => t.table === next.table);
    const stamp = (db: DatabaseSync): string =>
      storeRowTimestamp(
        db
          .prepare(`PRAGMA main.table_info("${next.table}")`)
          .all()
          .map((c) => String(c.name)),
      );
    const find = old
      ? live.prepare(`SELECT ${stamp(live)} AS stamp FROM main."${next.table}" WHERE id IS ?`)
      : undefined;
    find?.setReadBigInts(true);
    const rows = source.prepare(`SELECT id, ${stamp(source)} AS stamp FROM main."${next.table}"`);
    rows.setReadBigInts(true);
    let missing = 0,
      older = 0;
    const sample: string[] = [];
    for (const row of rows.iterate()) {
      const current = find?.get(row.id ?? null);
      if (!current) missing++;
      else if (Number(row.stamp) > Number(current.stamp)) older++;
      else continue;
      if (sample.length < 3)
        sample.push(
          `${String(row.id)}: ${current ? `live timestamp ${String(current.stamp)}, source ${String(row.stamp)}` : 'missing live key'}`,
        );
    }
    if (missing || older)
      evidence.push(
        `${next.table}: ${missing} missing keys, ${older} older versions (${sample.join('; ')}); live ${JSON.stringify(old ?? { rows: 0 })}; source ${JSON.stringify(next)}`,
      );
  }
  if (!evidence.length) return;
  let divergent = false;
  for (const table of before) {
    if (!after.some((t) => t.table === table.table)) {
      divergent ||= table.rows > 0;
      continue;
    }
    const lookup = source.prepare(`SELECT 1 FROM main."${table.table}" WHERE id IS ?`);
    lookup.setReadBigInts(true);
    const keys = live.prepare(`SELECT id FROM main."${table.table}"`);
    keys.setReadBigInts(true);
    for (const row of keys.iterate()) {
      if (!lookup.get(row.id ?? null)) {
        divergent = true;
        break;
      }
    }
    if (divergent) break;
  }
  return { source: path, kind, evidence, divergent };
}

/**
 * Keep a recovery source until its keys and versions exist in the live store.
 * This deliberately retains redundant ahead-of-live backups too: a later stale
 * snapshot is never proof of coverage. Failed reads cannot authorize deletion.
 */
export function snapshotRecoveryReason(target: string, snapshot: string): string | undefined {
  let live: DatabaseSync | undefined;
  let source: DatabaseSync | undefined;
  try {
    live = openNativeDatabase(target, { readonly: true, enableWal: false, timeout: 1000 });
    source = openNativeDatabase(snapshot, { readonly: true, enableWal: false, timeout: 1000 });
    const shape = (db: DatabaseSync): boolean =>
      db
        .prepare("SELECT 1 FROM main.sqlite_schema WHERE name='tasks_tasks' AND type='table'")
        .get() !== undefined;
    if (shape(live) !== shape(source)) return 'Store scope differs: recovery coverage is unproven';
    const finding = compareStoreFreshness(live, source, snapshot, 'snapshot');
    return finding
      ? `Recovery rows absent or older in live store: ${finding.evidence.join('; ')}`
      : undefined;
  } catch (error) {
    return `Recovery coverage unreadable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    source?.close();
    live?.close();
  }
}
