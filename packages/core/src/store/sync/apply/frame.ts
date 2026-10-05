/**
 * The synchronous apply frame (T12344; journal spec §3.2 "withApplyFrame").
 *
 * Every remote op is applied inside one apply frame: a single
 * `BEGIN IMMEDIATE … COMMIT` holding a `_sync_frame` row of kind `apply`, so
 * the capture triggers label the frame's captures and the sealer subtracts
 * the frame's apply intents from them (§3.3). The frame body is SYNCHRONOUS:
 * an `await` inside it would let another writer on the same handle interleave
 * its writes into the frame, and they would be subtracted as if the apply had
 * written them.
 *
 * - {@link runApplyFrame} awaits the async preparation first (unsealing,
 *   loading), then queues the frame behind the handle's foreground
 *   transactions and committed effects (`scheduleTaskBackground`), and only
 *   then runs the synchronous body.
 * - {@link withApplyFrame} is the frame itself:
 *   - it opens the only transaction, BEGIN IMMEDIATE, retried whole on
 *     SQLITE_BUSY, never mid-frame;
 *   - it inserts the frame row and calls the body with the API;
 *   - **type guard:** the body's return type excludes `PromiseLike`;
 *   - **runtime guard:** a thenable return rolls back and throws
 *     `E_SYNC_APPLY_ASYNC`;
 *   - any API call after the frame ended throws (`assertActive`).
 *
 * @module store/sync/apply/frame
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { isSqliteBusy } from '../../with-retry.js';
import { finishCaptureFrame, openCaptureFrame } from '../capture.js';
import { receiveClock } from '../clock-store.js';
import { type ApplyWriteApi, createApplyWriteApi } from './write-api.js';

/** A frame misuse: an async body, a nested call, or a call after the frame ended. */
export class ApplyFrameError extends Error {
  constructor(
    readonly code: 'E_SYNC_APPLY_ASYNC' | 'E_SYNC_APPLY_NESTED' | 'E_SYNC_APPLY_ENDED',
    message: string,
  ) {
    super(message);
    this.name = 'ApplyFrameError';
  }
}

/** A synchronous result: never a thenable. */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

/** Everything a frame body may do. */
export interface ApplyApi extends ApplyWriteApi {
  /** The frame id, or null when capture is off on this connection. */
  readonly frame: string | null;
  /**
   * Merge a remote HLC into this replica's clock (§1.3). Returns the new
   * clock, or `held` when the remote clock is beyond the skew limit.
   */
  clockReceive(
    replica: string,
    remoteHlc: string,
    nowMs: number,
  ): { held: false; clock: string } | { held: true };
}

const MAX_BUSY_RETRIES = 5;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Run `fn` as one apply frame on `db`: the only transaction, with a
 * `_sync_frame` row of kind `apply`, committed when `fn` returns.
 *
 * @param db - The store; must not be inside a transaction.
 * @param scope - The store's scope.
 * @param actor - The frame's actor (JSON of the remote writer), or null.
 * @param fn - The synchronous body.
 * @returns What `fn` returned.
 * @throws {ApplyFrameError} On a nested call or a thenable result.
 */
export function withApplyFrame<T>(
  db: DatabaseSync,
  scope: TableScope,
  actor: string | null,
  fn: (api: ApplyApi) => SyncResult<T>,
): SyncResult<T> {
  if (db.isTransaction) {
    // @sync-invariant none:local-only programming-error guard on the local apply frame
    throw new ApplyFrameError(
      'E_SYNC_APPLY_NESTED',
      'an apply frame must open the only transaction',
    );
  }
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      // The frame owns BUSY: retry the whole frame, never mid-frame.
      if (!isSqliteBusy(err) || attempt >= MAX_BUSY_RETRIES) throw err;
      sleepMs(100 * 2 ** (attempt - 1));
      continue;
    }
    let active = true;
    const assertActive = (): void => {
      if (!active) {
        // @sync-invariant none:local-only programming-error guard: the frame's API outlived the frame
        throw new ApplyFrameError('E_SYNC_APPLY_ENDED', 'the apply frame has ended');
      }
    };
    try {
      const frame = openCaptureFrame(db, 'apply', actor);
      const api: ApplyApi = {
        frame,
        ...createApplyWriteApi(db, scope, frame, assertActive),
        clockReceive(replica, remoteHlc, nowMs) {
          assertActive();
          return receiveClock(db, replica, remoteHlc, nowMs);
        },
      };
      const out = fn(api);
      if (isThenable(out)) {
        // @sync-invariant none:local-only programming-error guard: an async body would let writers interleave into the frame
        throw new ApplyFrameError(
          'E_SYNC_APPLY_ASYNC',
          'an apply frame body must be synchronous (it returned a thenable)',
        );
      }
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    } finally {
      active = false;
    }
  }
}

/**
 * Prepare asynchronously, then run one apply frame queued behind the
 * handle's foreground transactions (§3.2 steps 1–3).
 *
 * @param db - The store.
 * @param scope - The store's scope.
 * @param actor - The frame's actor, or null.
 * @param prepare - Async preparation (unsealing secrets, loading); its result is passed in.
 * @param fn - The synchronous body.
 * @returns What `fn` returned.
 */
export async function runApplyFrame<P, T>(
  db: DatabaseSync,
  scope: TableScope,
  actor: string | null,
  prepare: () => Promise<P>,
  fn: (api: ApplyApi, prepared: P) => SyncResult<T>,
): Promise<SyncResult<T>> {
  const prepared = await prepare();
  // Loaded here: the accessor module is large, and the frame itself needs none of it.
  const { scheduleTaskBackground } = await import('../../sqlite-data-accessor.js');
  let out: SyncResult<T> | undefined;
  await scheduleTaskBackground(db, async () => {
    out = withApplyFrame(db, scope, actor, (api) => fn(api, prepared));
  });
  return out as SyncResult<T>;
}
