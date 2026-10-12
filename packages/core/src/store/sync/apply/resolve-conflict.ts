/**
 * `cleo cloud conflicts resolve <id> --keep …` (T12997): settle a recorded
 * conflict by keeping this store's values, the incoming op's, or a choice
 * per column.
 *
 * Keeping this store's value writes nothing: every receiver merges the same
 * ops to the same result, so the current value is already what the peers
 * hold. Keeping the incoming value is an ORDINARY local write (a `write`
 * capture frame, actor op `cloud.conflicts.resolve`): it is captured,
 * sealed and synced like any command's write, and wins by its fresh HLC.
 *
 * A resolution obeys the typed merge rules like any write: it is not a leave
 * op. Before writing, the would-be op is merged against the row exactly as a
 * receiver would merge it; when a rule would refuse it (leaving an absorbing
 * state, lowering a rank, editing a frozen or write-once field, changing an
 * immutable row), it is refused here too, naming the rule and the command
 * that may leave it, so the origin and its peers never diverge.
 *
 * @module store/sync/apply/resolve-conflict
 * @task T12997
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerOp, LedgerWireValue } from '@cleocode/contracts/ledger';
import { captureTableDef, finishCaptureFrame, openCaptureFrame } from '../capture.js';
import { withImmediateTransaction } from '../clock-store.js';
import { conflictIncomingOp, listConflicts, resolveConflict } from '../conflicts.js';
import { encodeHlc, genesisHlc, maxHlc, parseHlc, tick } from '../hlc.js';
import { applyOp } from '../merge/engine.js';
import { mergeGroupsOf, mergeSpecFor } from '../merge/rules.js';
import { activeReplica } from '../replica.js';
import { loadRowState } from './applier.js';
import { resolveRef } from './refs.js';
import { createApplyWriteApi } from './write-api.js';

/** The `actor.op` a resolution's write carries. It is not a leave op of any rule. */
export const CONFLICT_RESOLVE_OP = 'cloud.conflicts.resolve';

/** Which side to keep: one for every column, or per column (unnamed columns keep mine). */
export type ConflictKeep = 'mine' | 'theirs' | Readonly<Record<string, 'mine' | 'theirs'>>;

/** What a resolution did. */
export interface ConflictResolution {
  readonly id: number;
  /** Columns written with the incoming value (empty: nothing to write). */
  readonly written: readonly string[];
}

/** A resolution this store refuses, with the code and the way forward. */
export class ConflictResolveError extends Error {
  constructor(
    readonly code: 'E_NOT_FOUND' | 'E_VALIDATION' | 'E_INVALID_STATE',
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = 'ConflictResolveError';
  }
}

/** The command that may leave each typed rule's protected state, for the refusal. */
const RULE_LEAVE_HINTS: Readonly<Record<string, string>> = {
  'task.status.absorbing':
    'reopen it first with `cleo reopen <id>` (done) or `cleo restore <id>` (cancelled)',
  'task.pipeline-stage.max':
    'a stage only moves back through `cleo reopen <id>` or `cleo restore <id>`',
  'task.verification.frozen-on-done': 'reopen the task first with `cleo reopen <id>`',
  'session.status.terminal': 'resume the session with `cleo session resume <id>`',
  'release.status.absorbing': 'a shipped release stays shipped: plan a new version',
  'playbook.approval.once': 'a decided approval stays decided: start a new run',
  'docs.lifecycle.transitions':
    'a superseded doc stays superseded: add the content as a new doc and run `cleo docs supersede <slug> <new-slug>`',
  'audit.immutable': 'audit rows never change',
};

const sameValue = (a: LedgerWireValue | undefined, b: LedgerWireValue | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Resolve one open conflict by keeping a side per column, then mark it
 * resolved, in one transaction.
 *
 * @param db - The store.
 * @param scope - The store's scope.
 * @param id - The conflict id.
 * @param keep - Which side to keep.
 * @param nowIso - The time.
 * @returns The columns written.
 * @throws {ConflictResolveError} When there is no such open conflict, a column
 *   is not the conflict's, the incoming value is unknown or cannot be written,
 *   or a typed rule would refuse the write on a receiver.
 */
export function resolveConflictKeeping(
  db: DatabaseSync,
  scope: TableScope,
  id: number,
  keep: ConflictKeep,
  nowIso: string,
): ConflictResolution {
  const c = listConflicts(db, { open: true }).find((x) => x.id === id);
  if (!c) {
    // @sync-invariant none:input-shape an unknown or already-resolved conflict id is refused before any write
    throw new ConflictResolveError(
      'E_NOT_FOUND',
      `no open conflict ${id}`,
      'list the open ones with `cleo cloud conflicts`',
    );
  }
  const side = (col: string): 'mine' | 'theirs' =>
    typeof keep === 'string' ? keep : (keep[col] ?? 'mine');
  if (typeof keep !== 'string') {
    const unknown = Object.keys(keep).filter((col) => !c.columns.includes(col));
    if (unknown.length > 0) {
      // @sync-invariant none:input-shape a column the conflict does not name is refused before any write
      throw new ConflictResolveError(
        'E_VALIDATION',
        `conflict ${id} does not involve ${unknown.join(', ')}`,
        `name only its columns: ${c.columns.join(', ')}`,
      );
    }
  }
  const theirsCols = c.columns.filter((col) => side(col) === 'theirs');
  if (theirsCols.length === 0) {
    resolveConflict(db, id, nowIso);
    return { id, written: [] };
  }

  const def = captureTableDef(db, scope, c.table);
  const { op } = conflictIncomingOp(db, c);
  const refuse = (message: string, fix: string): never => {
    // @sync-invariant none:input-shape a resolution whose incoming value cannot be written is refused before any write
    throw new ConflictResolveError('E_INVALID_STATE', `conflict ${id}: ${message}`, fix);
  };
  if (!def) return refuse(`${c.table} is not synced by this store`, 'keep mine');
  if (!op) {
    return refuse(
      'the incoming op is no longer in the inbox (pruned after a checkpoint)',
      'keep mine, or write the value with the command that owns it',
    );
  }
  const secret = theirsCols.filter((col) => def.secret.has(col));
  if (secret.length > 0) {
    return refuse(`${secret.join(', ')} is secret`, 'keep mine, or set it with its own command');
  }
  const api = createApplyWriteApi(db, scope, null, () => {});
  if (api.readRow(c.table, c.uid) === null) {
    return refuse('the row is gone here', 'keep mine, or re-create it with its own command');
  }
  const replica = activeReplica(db, scope)?.replicaId;
  if (!replica) return refuse('this store is not attached to a stream', 'keep mine');
  const before = loadRowState(db, api, def, c.uid, replica);

  // The op as it travels (references as uids), and as written here (local keys).
  const wire: Record<string, LedgerWireValue> = {};
  const local: Record<string, LedgerWireValue> = {};
  for (const col of theirsCols) {
    const value = op.a?.[col] ?? op.k?.[col] ?? null;
    if (value !== null && typeof value === 'object' && '$inc' in value) {
      return refuse(`${col} is a counter`, 'keep mine: counters merge by summing');
    }
    if (sameValue(before.fields[col]?.value, value)) continue;
    wire[col] = value;
    const ref = def.refs.get(col);
    if (!ref || typeof value !== 'string') {
      local[col] = value;
      continue;
    }
    const target = resolveRef(db, ref, value);
    if (target.kind !== 'row') {
      return refuse(`${col} references a row this store does not hold`, 'keep mine');
    }
    local[col] = target.key;
  }
  const written = Object.keys(local);
  if (written.length === 0) {
    resolveConflict(db, id, nowIso);
    return { id, written };
  }

  // Merge it as a receiver would: a group travels whole, at a fresh HLC.
  for (const group of mergeGroupsOf(c.table, def.columns)) {
    if (!group.some((col) => col in wire)) continue;
    for (const col of group) if (!(col in wire)) wire[col] = before.fields[col]?.value ?? null;
  }
  const last = Object.values(before.fields).reduce(
    (m, f) => maxHlc(m, parseHlc(f.hlc)),
    genesisHlc(replica),
  );
  const probe: LedgerOp = {
    t: c.table,
    u: c.uid,
    o: 'U',
    h: encodeHlc(tick(last, Date.now())),
    a: wire,
  };
  const spec = mergeSpecFor(c.table, def.columns);
  const out = applyOp(before, probe, { table: spec, actorOp: CONFLICT_RESOLVE_OP });
  const ruled =
    out.conflicts.find((x) => x.kind === 'typed-rule')?.rule ??
    out.skipped
      .filter((s) => s.reason === 'rule')
      .map((s) => spec.rules?.[s.column]?.id)
      .find((r) => r !== undefined);
  if (ruled !== undefined) {
    // @sync-invariant none:input-shape the merge engine's own typed rules decide it; a receiver would refuse the same write
    throw new ConflictResolveError(
      'E_INVALID_STATE',
      `conflict ${id}: keeping the incoming ${theirsCols.join(', ')} would break the typed rule ${ruled}; every synced device would refuse it`,
      `${RULE_LEAVE_HINTS[ruled] ?? 'this rule has no leave command'}, or keep mine`,
    );
  }
  if (out.status !== 'applied') {
    return refuse(
      `the merge would not apply it (${out.status})`,
      'keep mine, or write it with its own command',
    );
  }

  return withImmediateTransaction(db, () => {
    const frame = openCaptureFrame(db, 'write', JSON.stringify({ op: CONFLICT_RESOLVE_OP }));
    api.writeFields(c.table, c.uid, local);
    finishCaptureFrame(db, frame);
    resolveConflict(db, id, nowIso);
    return { id, written };
  });
}
