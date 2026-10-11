/**
 * The server half of a rebind at head (journal spec §3.5 D5, §1.5
 * "Retirement"; cleo-nexus contract v2.28 E31; T13278).
 *
 * The store commits the rebind locally (`store/sync/rebind.ts`) and records
 * what the server must learn as a pending rebind. {@link completeServerRebind}
 * then, before the store pushes or pulls again:
 *
 * 1. attaches the successor to this Nexus device: the project's replicas
 *    collection, or the account's home replicas for the global store
 *    (idempotent: a repeat answers 200);
 * 2. for a project, records the successor in the project's link, so the
 *    stream knows the store by the id it is bound to;
 * 3. retires the old replica on the server (E31), signed by this device over
 *    `replicaRetireMessage`, naming the successor, the last replicaSeq the
 *    server holds and the journal `retire` transaction. The server then
 *    refuses any later append past that seq. A repeat with the same body
 *    answers 200 with the stored retirement, which confirms the store's own
 *    record of the retire (T13366);
 * 4. clears the pending rebind.
 *
 * A failure leaves the pending rebind in place: the next sync retries it, and
 * nothing is pushed or pulled under a replica the server does not know.
 *
 * @task T13278
 * @module cloud/replica-rebind
 */

import type { DatabaseSync } from 'node:sqlite';
import { RetireReplicaResult } from '@cleocode/contracts/cloud';
import { z } from 'zod';
import {
  clearPendingRebind,
  type PendingRebind,
  pendingRebind,
  settleRetireDue,
} from '../store/sync/rebind.js';
import { confirmRetirements } from '../store/sync/retire.js';
import { signEd25519 } from './crypto.js';
import { NexusError } from './http.js';
import { NexusAccountError } from './nexus-auth.js';
import { recordNexusProjectReplica } from './nexus-link.js';
import type { NexusVaultConnection } from './nexus-vault-keys.js';
import { replicaRetireMessage } from './signing.js';

/** Where the rebind's stream lives. */
export interface RebindTarget {
  readonly streamId: string;
  /** The server project id, or null for the account's home stream. */
  readonly projectId: string | null;
  /** The project root (project scope), where the link lives. */
  readonly storeRoot: string;
}

const attachAnswer = z.looseObject({ replicaId: z.string() });

/**
 * Complete the server half of the store's pending rebind on `target`'s
 * stream (module docs). Does nothing when none is pending there.
 *
 * @param conn - The vault connection: its device id, signing key and raw client.
 * @param target - The stream, its project and the project root.
 * @param db - The store.
 * @returns The completed rebind, or null when none was pending.
 * @throws {NexusAccountError} `E_NEXUS_SYNC_REFUSED` when the server refuses
 *   the attach or the retirement; the rebind stays pending.
 */
export async function completeServerRebind(
  conn: Pick<NexusVaultConnection, 'apiUrl' | 'deviceId' | 'keys' | 'raw'>,
  target: RebindTarget,
  db: DatabaseSync,
): Promise<PendingRebind | null> {
  const pending = pendingRebind(db);
  if (pending === null || pending.stream !== target.streamId) return null;
  const refused = (what: string, err: unknown): NexusAccountError => {
    const reason =
      err instanceof NexusError
        ? `${err.code}${typeof err.details?.['reason'] === 'string' ? ` (${err.details['reason']})` : ''}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return new NexusAccountError(
      'E_NEXUS_SYNC_REFUSED',
      `${what} after this store rebound from replica ${pending.from} to ${pending.to} on ${pending.stream}: ${reason}`,
      'nothing was pushed or pulled under the new replica; run `cleo cloud sync` again to retry',
    );
  };

  try {
    await conn.raw(
      'POST',
      target.projectId !== null
        ? `/v1/projects/${encodeURIComponent(target.projectId)}/replicas`
        : '/v1/account/home/replicas',
      attachAnswer,
      { deviceId: conn.deviceId, replicaId: pending.to },
    );
  } catch (err) {
    throw refused('the server did not attach the new replica', err);
  }
  if (target.projectId !== null) {
    await recordNexusProjectReplica(target.storeRoot, conn.apiUrl, {
      replicaId: pending.to,
      nexusDeviceId: conn.deviceId,
      attachedAt: new Date().toISOString(),
    });
  }

  const signature = signEd25519(
    conn.keys.signing,
    replicaRetireMessage({
      streamId: pending.stream,
      replicaId: pending.from,
      successor: pending.to,
      lastReplicaSeq: pending.lastReplicaSeq,
      signerDeviceId: conn.deviceId,
      txnId: pending.retireTxn,
    }),
  ).toString('base64');
  let stored: RetireReplicaResult;
  try {
    stored = await conn.raw(
      'POST',
      `/v1/streams/${encodeURIComponent(pending.stream)}/replicas/${encodeURIComponent(pending.from)}/retirements`,
      RetireReplicaResult,
      {
        deviceId: conn.deviceId,
        successor: pending.to,
        lastReplicaSeq: pending.lastReplicaSeq,
        txnId: pending.retireTxn,
        signature,
      },
    );
  } catch (err) {
    throw refused('the server refused to retire the old replica', err);
  }
  confirmRetirements(db, pending.stream, [stored.retirement]);
  clearPendingRebind(db, pending.to);
  return pending;
}

/**
 * Complete every rebind the store owes on `target`'s stream (T13337): the
 * pending server half of an earlier rebind first, then the retirement an
 * open-pass rebind (a rollback or a cross-filesystem move) recorded, which
 * {@link settleRetireDue} turns into a signed `retire` and a pending server
 * half, completed at once. A refusal leaves what is owed in place.
 *
 * @param conn - The vault connection.
 * @param target - The stream, its project and the project root.
 * @param db - The store.
 * @returns The last rebind completed, or null when none was owed.
 * @throws {NexusAccountError} `E_NEXUS_SYNC_REFUSED` when the server refuses.
 */
export async function completeOwedRebinds(
  conn: Pick<NexusVaultConnection, 'apiUrl' | 'deviceId' | 'keys' | 'raw'>,
  target: RebindTarget,
  db: DatabaseSync,
): Promise<PendingRebind | null> {
  const earlier = await completeServerRebind(conn, target, db);
  if (settleRetireDue(db) === null) return earlier;
  return (await completeServerRebind(conn, target, db)) ?? earlier;
}
