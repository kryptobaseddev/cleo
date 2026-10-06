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

import type { DatabaseSync } from 'node:sqlite';
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

/** The remedy {@link LegacyOnlyStoreError} names. */
export const LEGACY_ONLY_REMEDY = 'cleo doctor superseded-store --reconcile';

/**
 * A store whose rows live only in the bare legacy family (T13224): the bare
 * `tasks` table holds rows while `tasks_tasks` is empty. No legacy file sits
 * beside it, so exodus-on-open never carries them, and the journal, which
 * captures only the current tables, would never see that data.
 */
export function isLegacyOnlyStore(db: DatabaseSync): boolean {
  if (!hasTable(db, 'tasks') || !hasTable(db, 'tasks_tasks')) return false;
  const rows = (t: string) =>
    (db.prepare(`SELECT EXISTS (SELECT 1 FROM "${t}") AS n`).get() as { n: number }).n;
  return rows('tasks') === 1 && rows('tasks_tasks') === 0;
}

/** Sync refused on a legacy-only store ({@link isLegacyOnlyStore}). */
export class LegacyOnlyStoreError extends Error {
  readonly code = 'E_SYNC_LEGACY_ONLY_STORE';

  constructor(flag: string) {
    super(
      `E_SYNC_LEGACY_ONLY_STORE: ${flag} refused: this store's rows live only in the bare legacy ` +
        `tables (tasks_tasks is empty), where the journal would never see them. ` +
        `Run \`${LEGACY_ONLY_REMEDY}\` first.`,
    );
    this.name = 'LegacyOnlyStoreError';
  }
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
  if (on && isLegacyOnlyStore(db)) {
    // @sync-invariant none:local-only enabling sync on a store whose rows the journal cannot see is refused; a per-store setting
    throw new LegacyOnlyStoreError(flag);
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
