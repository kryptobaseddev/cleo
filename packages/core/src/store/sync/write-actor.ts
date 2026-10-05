/**
 * The actor of a local write: who wrote it and which command (T13229;
 * journal spec §2.6 `LedgerActor`, §3.6.6).
 *
 * A local write frame records its actor, and the sealer copies it onto the
 * sealed transaction (`actor`). The typed merge rules decide on the
 * transaction's `actor.op`: a reopen, restore, uncancel or unarchive may
 * leave a terminal task status or lower a pipeline stage only when its
 * transaction names the command. A frame with no actor reaches every other
 * replica as a plain write, and they void the reopen as a typed-rule
 * conflict.
 *
 * The dispatcher runs every mutate operation inside
 * {@link runWithWriteActor} (`op` = `<domain>.<operation>`); the data
 * accessor reads {@link currentWriteActorJson} when it opens a write frame.
 * The context is async-local, so concurrent operations on one process never
 * see each other's actor.
 *
 * @module store/sync/write-actor
 * @task T13229
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LedgerActor } from '@cleocode/contracts/ledger';
import { canonicalJson } from './sealer-values.js';

const actorScope = new AsyncLocalStorage<LedgerActor>();

/**
 * Run `fn` with `actor` as the actor of every local write frame it opens.
 *
 * @param actor - The writer: its command (`op`, e.g. `tasks.restore`), session and agent.
 * @param fn - The operation.
 * @returns What `fn` returned.
 *
 * @example
 * ```ts
 * await runWithWriteActor({ op: 'tasks.restore', session }, () => restoreTask(id));
 * ```
 */
export function runWithWriteActor<T>(actor: LedgerActor, fn: () => T): T {
  return actorScope.run(actor, fn);
}

/**
 * The current write actor as the canonical JSON a frame stores, or null
 * outside {@link runWithWriteActor}.
 *
 * @returns The actor JSON, or null.
 */
export function currentWriteActorJson(): string | null {
  const actor = actorScope.getStore();
  return actor ? canonicalJson(actor) : null;
}
