/**
 * Automatic main-brain sync (T13468): `cleo cloud sync` without the user
 * typing it. Runs from hooks CLEO already has, never a daemon or server of
 * its own:
 *
 *   - session end: the detached session-end worker
 *     (`sessions/session-end-snapshot.ts`), after its snapshot;
 *   - the sentient tick (`sentient/tick.ts`), at most once per
 *     {@link autoSyncIntervalMs}.
 *
 * Best-effort and bounded: a store with no sync flag on, a signed-out
 * device or an unlinked project is a quiet skip; any other failure
 * (offline, refused) is recorded in `<CLEO_HOME>/auto-sync.json`, which
 * `cleo cloud status` reports as one {@link W_AUTO_SYNC_FAILED} warning.
 * Single-flight across processes under a lock, admitted by the governor as
 * `db-heavy` (skipped, not queued, under pressure). Never throws.
 *
 * @task T13468
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudWarning } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { getCleoHome, resolveCleoDir } from '../paths.js';

/** Default minimum gap between tick-driven syncs. */
export const AUTO_SYNC_INTERVAL_MS = 15 * 60_000;

/** Minimum gap between session-end syncs: coalesces a burst of session ends. */
export const AUTO_SYNC_SESSION_END_MIN_MS = 60_000;

/** Upper bound on one automatic sync. */
export const AUTO_SYNC_TIMEOUT_MS = 120_000;

/** Warning code `cleo cloud status` shows for a failed automatic sync. */
export const W_AUTO_SYNC_FAILED = 'W_AUTO_SYNC_FAILED';

/** Error codes that mean "nothing to sync here", not a failure. */
const QUIET_SKIP_CODES = new Set([
  'E_SYNC_DISABLED',
  'E_NEXUS_NOT_SIGNED_IN',
  'E_NEXUS_VAULT_NOT_LINKED',
  'E_NEXUS_DEVICE_REQUIRED',
]);

/** What triggered an automatic sync. */
export type AutoSyncReason = 'session-end' | 'tick';

/** Persisted state of automatic sync. */
export interface AutoSyncState {
  /** When the last attempt started (ISO), else absent. */
  lastAttemptAt?: string;
  /** When the last attempt succeeded (ISO), else absent. */
  lastOkAt?: string;
  /** The last failure, cleared by a success. */
  lastError?: { at: string; code: string; message: string } | null;
}

/** Outcome of {@link autoCloudSync}. */
export type AutoSyncOutcome =
  | 'synced'
  | 'throttled'
  | 'disabled'
  | 'skipped'
  | 'busy'
  | 'deferred'
  | 'failed';

/** Test seams for {@link autoCloudSync}. */
export interface AutoSyncOptions {
  /** Clock. */
  now?: Date;
  /** CLEO home holding the global store and the state file. */
  cleoHome?: string;
  /** Runs the sync; defaults to `cloudSync`. */
  sync?: (projectRoot: string) => Promise<unknown>;
  /** Whether a store has a journal push/pull flag on; defaults to a read-only check. */
  syncEnabled?: (dbPath: string) => Promise<boolean>;
  /** Governor admission; `null` = deferred. */
  admit?: () => Promise<{ release: () => Promise<void> } | null>;
  /** Single-flight lock; throws when held. */
  lock?: () => Promise<{ release: () => Promise<void> }>;
}

/**
 * The tick interval: `CLEO_AUTO_SYNC_INTERVAL_MIN` minutes, else
 * {@link AUTO_SYNC_INTERVAL_MS}. `0` turns the tick-driven sync off.
 *
 * @returns Milliseconds, or `null` when the tick sync is off.
 */
export function autoSyncIntervalMs(): number | null {
  const raw = process.env['CLEO_AUTO_SYNC_INTERVAL_MIN'];
  if (raw === undefined || raw.trim() === '') return AUTO_SYNC_INTERVAL_MS;
  const min = Number(raw);
  if (!Number.isFinite(min) || min < 0) return AUTO_SYNC_INTERVAL_MS;
  return min === 0 ? null : min * 60_000;
}

/** Path of the state file. */
function statePath(cleoHome: string): string {
  return join(cleoHome, 'auto-sync.json');
}

/**
 * Read the automatic sync state. Missing or malformed means empty.
 *
 * @param cleoHome - CLEO home. @defaultValue getCleoHome()
 * @returns The state.
 */
export function readAutoSyncState(cleoHome: string = getCleoHome()): AutoSyncState {
  try {
    return JSON.parse(readFileSync(statePath(cleoHome), 'utf-8')) as AutoSyncState;
  } catch {
    return {};
  }
}

function writeState(cleoHome: string, state: AutoSyncState): void {
  try {
    mkdirSync(cleoHome, { recursive: true });
    writeFileSync(statePath(cleoHome), `${JSON.stringify(state)}\n`);
  } catch {
    // Best-effort: a lost record only loses the throttle and the warning.
  }
}

/**
 * The `cleo cloud status` warning for a failed automatic sync: present while
 * the last failure is newer than the last success.
 *
 * @param cleoHome - CLEO home. @defaultValue getCleoHome()
 * @returns The warning, or `null`.
 */
export function autoSyncWarning(cleoHome: string = getCleoHome()): CloudWarning | null {
  const s = readAutoSyncState(cleoHome);
  if (!s.lastError) return null;
  return {
    code: W_AUTO_SYNC_FAILED,
    message: `automatic sync failed at ${s.lastError.at} (${s.lastError.code}): ${s.lastError.message}; run \`cleo cloud sync\` to retry`,
  };
}

/** Whether a store has `sync.push` or `sync.pull` on, read-only. Absent or unreadable is off. */
async function storeSyncEnabled(dbPath: string): Promise<boolean> {
  const { existsSync } = await import('node:fs');
  if (!existsSync(dbPath)) return false;
  const [{ openCleoDbSnapshot }, { readSyncFlags }] = await Promise.all([
    import('../store/open-cleo-db.js'),
    import('../store/sync/flags.js'),
  ]);
  let snap: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    snap = openCleoDbSnapshot(dbPath, { readOnly: true, applyPragmas: false });
    const f = readSyncFlags(snap.db);
    return f['sync.push'] || f['sync.pull'];
  } catch {
    return false;
  } finally {
    snap?.close();
  }
}

async function defaultAdmit(): Promise<{ release: () => Promise<void> } | null> {
  try {
    const { governor } = await import('../resources/governor.js');
    const admit = await governor.acquire('db-heavy', { blocking: false });
    return admit.deferred ? null : { release: admit.release };
  } catch {
    return { release: async () => {} };
  }
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : 'E_AUTO_SYNC';
}

/**
 * Run one automatic `cloud sync` of the project and global stores, if due.
 * Never throws.
 *
 * @param projectRoot - The project whose session ended or whose tick ran.
 * @param reason - What triggered it; a tick honours {@link autoSyncIntervalMs}.
 * @param opts - Test seams.
 * @returns What happened.
 * @task T13468
 */
export async function autoCloudSync(
  projectRoot: string,
  reason: AutoSyncReason,
  opts: AutoSyncOptions = {},
): Promise<AutoSyncOutcome> {
  const log = getLogger('auto-sync');
  const cleoHome = opts.cleoHome ?? getCleoHome();
  const now = opts.now ?? new Date();
  try {
    const gap = reason === 'tick' ? autoSyncIntervalMs() : AUTO_SYNC_SESSION_END_MIN_MS;
    if (gap === null) return 'disabled';
    const due = (): boolean => {
      const last = readAutoSyncState(cleoHome).lastAttemptAt;
      return last === undefined || now.getTime() - Date.parse(last) >= gap;
    };
    if (!due()) return 'throttled';

    const enabled = opts.syncEnabled ?? storeSyncEnabled;
    const any =
      (await enabled(join(resolveCleoDir(projectRoot), 'cleo.db'))) ||
      (await enabled(join(cleoHome, 'cleo.db')));
    if (!any) return 'skipped';

    let held: { release: () => Promise<void> };
    try {
      held = await (
        opts.lock ??
        (async () => {
          const { acquireAbandonableLock } = await import('../store/lock.js');
          mkdirSync(cleoHome, { recursive: true });
          // The lock needs its target to exist; appending nothing creates it.
          writeFileSync(statePath(cleoHome), '', { flag: 'a' });
          return acquireAbandonableLock(statePath(cleoHome), {
            retries: 0,
            stale: AUTO_SYNC_TIMEOUT_MS * 3,
          });
        })
      )();
    } catch {
      return 'busy';
    }
    try {
      if (!due()) return 'throttled';
      const admission = await (opts.admit ?? defaultAdmit)();
      if (admission === null) return 'deferred';
      const state = readAutoSyncState(cleoHome);
      writeState(cleoHome, { ...state, lastAttemptAt: now.toISOString() });
      try {
        const sync =
          opts.sync ??
          (async (root: string) => {
            const { cloudSync } = await import('./nexus-vault.js');
            return cloudSync({ projectRoot: root });
          });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          sync(projectRoot),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error(`timed out after ${AUTO_SYNC_TIMEOUT_MS} ms`), {
                    code: 'E_AUTO_SYNC_TIMEOUT',
                  }),
                ),
              AUTO_SYNC_TIMEOUT_MS,
            );
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
        writeState(cleoHome, {
          ...state,
          lastAttemptAt: now.toISOString(),
          lastOkAt: new Date().toISOString(),
          lastError: null,
        });
        return 'synced';
      } catch (err) {
        const code = errorCode(err);
        if (QUIET_SKIP_CODES.has(code)) return 'skipped';
        const message = err instanceof Error ? err.message : String(err);
        writeState(cleoHome, {
          ...state,
          lastAttemptAt: now.toISOString(),
          lastError: { at: new Date().toISOString(), code, message },
        });
        log.warn({ reason, code, message }, 'automatic cloud sync failed');
        return 'failed';
      } finally {
        await admission.release();
      }
    } finally {
      await held.release();
    }
  } catch (err) {
    log.warn({ err, reason }, 'automatic cloud sync skipped');
    return 'failed';
  }
}
