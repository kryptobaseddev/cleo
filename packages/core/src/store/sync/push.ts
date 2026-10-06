/**
 * Push one stream's journal (journal spec §2.8 "Persist before push",
 * "Upload", §2.9, §1.3 "Local clock ahead"; T12343 S4-2).
 *
 * {@link pushStream} runs, in order:
 * 1. the preconditions: `sync.push` on, the stream cut and its genesis
 *    checkpoint stored (`genesis_pending` clear), so no segment ever
 *    precedes the checkpoint it extends;
 * 2. the local-clock check: when this device's clock runs more than
 *    `MAX_DRIFT` ahead of the server's date, push pauses (persisted as
 *    `sync.clock_ahead` for `cleo doctor`), so future-stamped HLCs do not
 *    spread; local writes are never refused;
 * 3. the rollback check: when the server already holds a later segment from
 *    this replica than the store has persisted, the store is behind (a
 *    restore or a copy) and must rebind (§1.5, §2.9); nothing is sent;
 * 4. seal everything pending, then pack and persist segments
 *    ({@link buildSegment}), advancing the device registry's high-water mark
 *    after each persist (the store ahead of the registry is the safe
 *    direction);
 * 5. upload the persisted segments, lowest `replicaSeq` first, one at a time,
 *    always the exact persisted bytes; a duplicate counts as stored.
 *
 * The upload goes through a {@link SegmentUploader} port: the journal client
 * in production (`cloud/nexus-vault.ts`), a fake in tests.
 *
 * @task T12343
 * @module store/sync/push
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { isSyncFlagOn } from './flags.js';
import { genesisCutOf, genesisPending } from './genesis.js';
import { storeHwm } from './replica.js';
import type { ReplicaRegistry } from './replica-registry.js';
import { hasTable } from './schema.js';
import { sealPending } from './sealer.js';
import {
  type BuildSegmentOptions,
  buildSegment,
  markSegmentPushed,
  type PersistedSegment,
  type SegmentSealer,
  unpushedSegments,
} from './segments.js';

/** `MAX_DRIFT` (§1.3, Q6): how far this device's clock may run ahead of the server's. */
export const MAX_DRIFT_MS = 5 * 60 * 1000;

/** `_sync_meta` key set while push is paused for a clock ahead of the server's (`cleo doctor`). */
export const CLOCK_AHEAD_KEY = 'sync.clock_ahead';

/** Uploads one persisted segment; resolves with the server's seq, `duplicate` when it was stored already. */
export type SegmentUploader = (
  segment: PersistedSegment,
) => Promise<{ readonly seq: number; readonly duplicate: boolean }>;

/** Options for {@link pushStream}. */
export interface PushStreamOptions {
  readonly scope: TableScope;
  readonly stream: string;
  /** This store's bound replica (the stream knows it by the same id). */
  readonly replica: string;
  /** The merge key's project, or null on a home stream. */
  readonly project: string | null;
  readonly sealer: SegmentSealer;
  /** Signs each packed transaction for the stream ({@link BuildSegmentOptions.signTxn}). */
  readonly signTxn: BuildSegmentOptions['signTxn'];
  readonly upload: SegmentUploader;
  /** The server's date from its latest response, or null when unknown. */
  readonly serverDate: Date | null;
  /** The server's last stored `replicaSeq` for this replica on the stream, or null when unknown or none. */
  readonly serverLastReplicaSeq: number | null;
  /** The device registry, whose high-water mark advances after each persist. */
  readonly registry?: ReplicaRegistry;
  /** Wall clock. @defaultValue Date.now */
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
  /** Seal and push although the flags are unreleased (tests and staging only). Never set from user input. */
  readonly allowUnreleased?: boolean;
  /** Override {@link MAX_DRIFT_MS} (tests). */
  readonly maxDriftMs?: number;
}

/** What {@link pushStream} did. */
export interface PushStreamReport {
  readonly stream: string;
  /** Why nothing was sent, or null. */
  readonly refused: string | null;
  /** Push paused because this device's clock is ahead of the server's. */
  readonly clockAhead: boolean;
  /** Transactions sealed, segments packed and persisted, segments the server stored (`duplicates` of them retries). */
  readonly sealed: number;
  readonly built: number;
  readonly pushed: number;
  readonly duplicates: number;
  /** The server seq of the last segment stored, or null. */
  readonly lastServerSeq: number | null;
}

const empty = (stream: string, fields: Partial<PushStreamReport>): PushStreamReport => ({
  stream,
  refused: null,
  clockAhead: false,
  sealed: 0,
  built: 0,
  pushed: 0,
  duplicates: 0,
  lastServerSeq: null,
  ...fields,
});

/** Set or clear {@link CLOCK_AHEAD_KEY}. */
function markClockAhead(db: DatabaseSync, value: string | null, atIso: string): void {
  if (value === null) {
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(CLOCK_AHEAD_KEY);
    return;
  }
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(CLOCK_AHEAD_KEY, value, atIso);
}

/**
 * Seal, persist and upload one stream's pending journal (module docs).
 * Must run outside a transaction. An upload failure propagates after the
 * segments before it were recorded; the next run resends from the lowest
 * unpushed `replicaSeq`, with the same bytes.
 *
 * @param db - The store.
 * @param o - {@link PushStreamOptions}.
 * @returns What was sealed, persisted and stored, or why nothing was sent.
 */
export async function pushStream(
  db: DatabaseSync,
  o: PushStreamOptions,
): Promise<PushStreamReport> {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  if (!hasTable(db, '_sync_segment'))
    return empty(o.stream, { refused: 'sync schema not installed' });
  if (!isSyncFlagOn(db, 'sync.push', env)) return empty(o.stream, { refused: 'sync.push is off' });
  if (genesisCutOf(db, o.stream) === undefined) {
    return empty(o.stream, {
      refused: `${o.stream} has no genesis cut on this store: run \`cleo sync enable push\``,
    });
  }
  if (genesisPending(db, o.stream)) {
    return empty(o.stream, {
      refused: `${o.stream}'s genesis checkpoint is not stored yet: run \`cleo sync enable push\` again`,
    });
  }
  const atIso = new Date(now()).toISOString();
  // §1.3: a clock running ahead of the server's pauses push, never writes.
  const drift = o.serverDate === null ? 0 : now() - o.serverDate.getTime();
  if (drift > (o.maxDriftMs ?? MAX_DRIFT_MS)) {
    markClockAhead(
      db,
      JSON.stringify({ driftMs: drift, serverDate: o.serverDate?.toISOString() ?? null }),
      atIso,
    );
    return empty(o.stream, { clockAhead: true });
  }
  markClockAhead(db, null, atIso);
  // §1.5 / §2.9: the server is authoritative. A later segment there than this
  // store ever persisted means the store was restored or copied behind it.
  const local = storeHwm(db, o.replica)[o.stream] ?? null;
  if (o.serverLastReplicaSeq !== null && (local === null || o.serverLastReplicaSeq > local)) {
    return empty(o.stream, {
      refused: `the server holds replicaSeq ${o.serverLastReplicaSeq} of replica ${o.replica} on ${o.stream}, but this store persisted only ${local ?? 'none'}: the store is behind (restored or copied) and must rebind to a new replica (T12753)`,
    });
  }

  let sealed = 0;
  for (;;) {
    const r = sealPending(db, {
      scope: o.scope,
      replica: o.replica,
      now,
      env,
      ...(o.allowUnreleased ? { allowUnreleased: true } : {}),
    });
    sealed += r.txns;
    if (r.refused !== null || r.captures === 0 || r.pending.length > 0) break;
  }
  let built = 0;
  for (;;) {
    const seg = buildSegment(db, {
      stream: o.stream,
      replica: o.replica,
      scope: o.scope,
      project: o.project,
      sealer: o.sealer,
      signTxn: o.signTxn,
      nowIso: new Date(now()).toISOString(),
    });
    if (seg === null) break;
    built += 1;
    // §2.8: the registry follows the store; a crash before this leaves the
    // store ahead of it, the safe direction.
    if (o.registry?.get(o.replica)) o.registry.advanceHwm(o.replica, o.stream, seg.replicaSeq);
  }

  let pushed = 0;
  let duplicates = 0;
  let lastServerSeq: number | null = null;
  for (const seg of unpushedSegments(db, o.stream, o.replica)) {
    const stored = await o.upload(seg);
    markSegmentPushed(db, {
      stream: o.stream,
      replica: o.replica,
      replicaSeq: seg.replicaSeq,
      serverSeq: stored.seq,
      nowIso: new Date(now()).toISOString(),
    });
    pushed += 1;
    if (stored.duplicate) duplicates += 1;
    lastServerSeq = stored.seq;
  }
  return empty(o.stream, { sealed, built, pushed, duplicates, lastServerSeq });
}
