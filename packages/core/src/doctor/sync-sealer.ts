/**
 * `cleo doctor` row `sync_sealer` (journal spec §2.5, §4.4; T13036).
 *
 * Read-only. It opens the project `cleo.db` as a snapshot and reports:
 * - the capture backlog head: live captures, the oldest one's seq and age
 *   (a head that stays put across seals is stuck, and `sealPending` names
 *   the reason in `pending`);
 * - quarantined captures per table (`_sync_quarantine`): those tables are
 *   suspect until the repair diff re-derives them (S3d);
 * - a persisted sync flag that is still unreleased: the sealer refuses it,
 *   but its presence means something wrote it outside `setSyncFlag`.
 *
 * A store without the sealer tables reports `ok`: nothing to seal.
 *
 * @module
 * @task T13036
 */

import { existsSync } from 'node:fs';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { readSyncFlags, UNRELEASED_FLAGS } from '../store/sync/flags.js';
import { hasTable } from '../store/sync/schema.js';
import { sealBacklog } from '../store/sync/sealer.js';

/** The `sync_sealer` row of `cleo doctor`. */
export interface SyncSealerDoctorCheck {
  readonly check: 'sync_sealer';
  readonly status: 'ok' | 'warning' | 'error';
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly fix?: string;
}

/** What {@link inspectSyncSealer} found. */
export interface SyncSealerReport {
  readonly dbPath: string;
  readonly storeExists: boolean;
  /** The sealer tables exist. */
  readonly sealerInstalled: boolean;
  readonly backlog: {
    readonly live: number;
    readonly oldestSeq: number | null;
    readonly oldestAtMs: number | null;
  };
  /** Quarantined captures per table: those tables are suspect. */
  readonly quarantined: Readonly<Record<string, number>>;
  /** Unreleased sync flags that are persisted on. */
  readonly unreleasedOn: readonly string[];
}

/** A backlog head older than this is reported as a warning. */
export const SEAL_BACKLOG_STALE_MS = 24 * 60 * 60 * 1000;

/** Inspect the project store's sealer state. Read-only. */
export function inspectSyncSealer(projectRoot: string): SyncSealerReport {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const empty: SyncSealerReport = {
    dbPath,
    storeExists: false,
    sealerInstalled: false,
    backlog: { live: 0, oldestSeq: null, oldestAtMs: null },
    quarantined: {},
    unreleasedOn: [],
  };
  if (!existsSync(dbPath)) return empty;
  const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
  try {
    const db = snap.db;
    const installed = hasTable(db, '_sync_txn') && hasTable(db, '_sync_quarantine');
    const quarantined: Record<string, number> = {};
    if (installed) {
      for (const r of db
        .prepare('SELECT tbl, count(*) AS n FROM _sync_quarantine GROUP BY tbl ORDER BY tbl')
        .all() as Array<{ tbl: string; n: number }>) {
        quarantined[r.tbl] = r.n;
      }
    }
    const flags = hasTable(db, '_sync_meta') ? readSyncFlags(db) : null;
    return {
      dbPath,
      storeExists: true,
      sealerInstalled: installed,
      backlog: sealBacklog(db),
      quarantined,
      unreleasedOn: flags ? [...UNRELEASED_FLAGS].filter((f) => flags[f] === true).sort() : [],
    };
  } finally {
    snap.close();
  }
}

/** The `sync_sealer` row of the default `cleo doctor` report. */
export function syncSealerDoctorCheck(
  projectRoot: string,
  now: () => number = Date.now,
): SyncSealerDoctorCheck {
  let r: SyncSealerReport;
  try {
    r = inspectSyncSealer(projectRoot);
  } catch (error) {
    return {
      check: 'sync_sealer',
      status: 'warning',
      message: `sealer state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!r.storeExists)
    return { check: 'sync_sealer', status: 'ok', message: 'no project store yet' };
  const details = { ...r } as unknown as Record<string, unknown>;
  const head =
    r.backlog.live === 0
      ? 'no captures waiting'
      : `${r.backlog.live} capture(s) waiting, head seq ${r.backlog.oldestSeq}` +
        (r.backlog.oldestAtMs !== null
          ? `, ${Math.round((now() - r.backlog.oldestAtMs) / 60_000)} min old`
          : '');
  const problems: string[] = [];
  const suspect = Object.entries(r.quarantined);
  if (suspect.length > 0) {
    problems.push(
      `quarantined capture(s), table(s) suspect: ${suspect.map(([t, n]) => `${t} (${n})`).join(', ')}`,
    );
  }
  if (r.unreleasedOn.length > 0) {
    problems.push(
      `unreleased sync flag(s) persisted on: ${r.unreleasedOn.join(', ')} (the sealer refuses them)`,
    );
  }
  if (r.backlog.oldestAtMs !== null && now() - r.backlog.oldestAtMs > SEAL_BACKLOG_STALE_MS) {
    problems.push(`the backlog head has waited over a day (${head})`);
  }
  if (problems.length > 0) {
    return {
      check: 'sync_sealer',
      status: 'warning',
      message: `${problems.join('; ')}; ${head}`,
      details,
      fix: "Quarantined tables are re-derived by the repair diff; a stuck head is named in 'pending' by the next seal",
    };
  }
  return { check: 'sync_sealer', status: 'ok', message: head, details };
}
