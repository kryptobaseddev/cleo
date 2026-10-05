/**
 * The pure merge engine (T12344; journal spec §1.7, §2.6, §2.9, §3.2, §3.6).
 *
 * {@link applyOp} decides one incoming I, U or D op against the stream-derived
 * state of its row and returns the next state, the row-level effect and the
 * conflicts to record. Receivers apply in stream `seq` order and decide by HLC
 * (§2.9), so every replica that folds the same stream reaches the same state:
 *
 * - **Per-field LWW by HLC.** A column's incoming HLC is `fh[col] ?? h`; it
 *   wins when it is greater than the column's stored HLC. LWW is commutative,
 *   so plain columns converge whatever the order.
 * - **Groups** merge as one unit: the unit's newest HLC decides, and every
 *   carried column of the unit comes from the winner.
 * - **Counters** merge by delta (`sum`) or by `max`/`min`, never by plain LWW.
 * - **Typed rules** (absorbing states, rank-max, frozen-while, write-once) are
 *   evaluated against the current state, so they depend on stream order and
 *   are deterministic for a given stream (§3.5 Rule 1).
 * - **Tombstones** never resurrect: an op older than the delete is skipped; a
 *   newer update of a deleted row is voided with an `edit-vs-delete`
 *   conflict; a newer insert re-creates the row (a natural-key re-add).
 * - **Conflicts are never dropped:** a concurrent divergent edit (the op's
 *   before-image differs from the current value) is recorded whichever side
 *   wins, as is every typed-rule refusal or override.
 * - **Schema skew is refused** explicitly: an op naming a column this schema
 *   lacks is `refused-schema`, never partly applied ({@link checkSchemaVersion}
 *   covers the segment level).
 *
 * K ops are not field merges: the re-key path of the applier handles them.
 *
 * @module store/sync/merge/engine
 * @task T12344
 */

import {
  LEDGER_TXN_VERSION,
  type LedgerOp,
  type LedgerValue,
  type LedgerWireValue,
} from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { compareHlc, parseHlc } from '../hlc.js';
import { canonicalJson } from '../sealer-values.js';
import type {
  CounterMode,
  FieldRule,
  FieldState,
  MergeConflict,
  MergeContext,
  OpOutcome,
  RowState,
  SkipReason,
} from './types.js';

/** A K op reached the field merge, or a spec is inconsistent. */
export class MergeEngineError extends Error {
  readonly code = 'E_SYNC_MERGE_ENGINE';

  constructor(message: string) {
    super(message);
    this.name = 'MergeEngineError';
  }
}

/** Why a payload is refused before any op is applied. */
export interface SchemaRefusal {
  readonly code: 'E_SCHEMA_AHEAD';
  readonly message: string;
}

/**
 * Refuse a segment or transaction written by a newer schema or format (§2.9):
 * a segment `schemaVersion` above {@link SYNC_SCHEMA_VERSION}, or a transaction
 * `v` above {@link LEDGER_TXN_VERSION}. The receiver stages it `refused-schema`
 * and replays it after an upgrade; it is never silently skipped.
 *
 * @param segmentSchemaVersion - The segment's `schemaVersion`.
 * @param txnVersion - The transaction's `v`, when checking one.
 * @returns The refusal, or `null` when this build can apply it.
 */
export function checkSchemaVersion(
  segmentSchemaVersion: number,
  txnVersion?: number,
): SchemaRefusal | null {
  if (segmentSchemaVersion > SYNC_SCHEMA_VERSION) {
    return {
      code: 'E_SCHEMA_AHEAD',
      message: `segment schemaVersion ${segmentSchemaVersion} is newer than this build's ${SYNC_SCHEMA_VERSION}; upgrade CLEO to apply it`,
    };
  }
  if (txnVersion !== undefined && txnVersion > LEDGER_TXN_VERSION) {
    return {
      code: 'E_SCHEMA_AHEAD',
      message: `transaction format v${txnVersion} is newer than this build's v${LEDGER_TXN_VERSION}; upgrade CLEO to apply it`,
    };
  }
  return null;
}

/** Compare two encoded HLCs. */
function cmp(a: string, b: string): number {
  return compareHlc(parseHlc(a), parseHlc(b));
}

function maxOf(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return cmp(a, b) >= 0 ? a : b;
}

function same(a: LedgerWireValue | undefined, b: LedgerWireValue | undefined): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function isIncrement(v: LedgerValue): v is { $inc: number } {
  return typeof v === 'object' && v !== null && '$inc' in v;
}

/** A wire value as a number, or null when it is not numeric. */
function asNumber(v: LedgerWireValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object') {
    if ('$r' in v) {
      const t = v.$r.replace(/^\+?Inf$/, 'Infinity').replace(/^-Inf$/, '-Infinity');
      const n = Number(t);
      return Number.isNaN(n) ? null : n;
    }
    if ('$i' in v) return Number(v.$i);
  }
  return null;
}

function fromNumber(n: number): LedgerWireValue {
  return Number.isSafeInteger(n) ? n : { $r: String(n) };
}

/** The plain wire value of an after-value (an increment applied to nothing is its delta). */
function plain(v: LedgerValue): LedgerWireValue {
  return isIncrement(v) ? fromNumber(v.$inc) : v;
}

function asString(v: LedgerWireValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

function opFieldHlc(op: LedgerOp, col: string): string {
  return op.fh?.[col] ?? op.h;
}

/** Validate a spec once per call site: groups never contain counters. */
function assertSpec(ctx: MergeContext): void {
  const counters = ctx.table.counters ?? {};
  for (const g of ctx.table.groups ?? []) {
    for (const c of g) {
      if (c in counters) {
        // @sync-invariant none:input-shape a merge spec is static registry data; an inconsistent one is a programming error
        throw new MergeEngineError(`counter column ${c} cannot be part of a merge group`);
      }
    }
  }
}

/** The units of an op's columns: each group the op touches, and each loose column. */
function units(ctx: MergeContext, cols: readonly string[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const c of cols) {
    if (seen.has(c)) continue;
    const g = (ctx.table.groups ?? []).find((grp) => grp.includes(c));
    if (g) {
      const carried = g.filter((x) => cols.includes(x));
      for (const x of g) seen.add(x);
      out.push(carried);
    } else {
      seen.add(c);
      out.push([c]);
    }
  }
  return out;
}

interface Draft {
  fields: Record<string, FieldState>;
  written: string[];
  skipped: Array<{ column: string; reason: SkipReason }>;
  conflicts: MergeConflict[];
  refused: number;
  applied: number;
  older: number;
}

function conflict(
  op: LedgerOp,
  kind: MergeConflict['kind'],
  columns: readonly string[],
  resolution: MergeConflict['resolution'],
  extra: { rule?: string; localHlc?: string } = {},
): MergeConflict {
  return {
    kind,
    table: op.t,
    uid: op.u,
    columns,
    resolution,
    opHlc: op.h,
    ...(extra.rule ? { rule: extra.rule } : {}),
    ...(extra.localHlc ? { localHlc: extra.localHlc } : {}),
  };
}

/**
 * Apply a counter column's value (§2.6 "Counters"). A `{ $inc }` delta is
 * summed; an absolute value on a `max`/`min` column keeps the extreme. Both
 * are commutative, so counters converge in any order and never conflict. An
 * absolute value on a `sum` column (a sealer that could not emit a delta) is
 * taken as is, by HLC like any field.
 */
function mergeCounter(d: Draft, op: LedgerOp, col: string, mode: CounterMode): void {
  const inc = op.a?.[col];
  if (inc === undefined) return;
  const cur = d.fields[col];
  const h = opFieldHlc(op, col);
  const curN = asNumber(cur?.value);
  const hlc = maxOf(cur?.hlc, h) ?? h;
  let value: LedgerWireValue;
  if (isIncrement(inc)) {
    value = fromNumber((curN ?? 0) + inc.$inc);
  } else {
    const n = asNumber(inc);
    if (mode !== 'sum' && n !== null && curN !== null) {
      value = fromNumber(mode === 'max' ? Math.max(curN, n) : Math.min(curN, n));
    } else if (cur === undefined || cmp(h, cur.hlc) > 0) {
      value = inc;
    } else {
      d.skipped.push({ column: col, reason: 'older' });
      d.older++;
      return;
    }
  }
  d.fields[col] = { value, hlc };
  d.written.push(col);
  d.applied++;
}

interface RuleVerdict {
  /** Refuse the unit, with a conflict. */
  refuse?: string;
  /** Force the incoming unit to win despite LWW, with a conflict. */
  force?: string;
  /** Drop the unit by the rule's own resolution (no conflict). */
  drop?: true;
  /** Ignore HLC: the rule picked the winner (rank-max). */
  winsByRule?: true;
  /** Record an explicit leave on this column. */
  leave?: string;
}

function ruleVerdict(
  rule: FieldRule,
  col: string,
  d: Draft,
  base: RowState,
  op: LedgerOp,
  ctx: MergeContext,
  incomingWins: boolean,
  hi: string,
): RuleVerdict {
  const actorOp = ctx.actorOp ?? '';
  const cur = d.fields[col];
  const inc = op.a?.[col];
  if (inc === undefined || isIncrement(inc)) return {};
  switch (rule.kind) {
    case 'absorbing': {
      const curAbs = cur !== undefined && rule.states.includes(asString(cur.value) ?? '\0');
      const incAbs = rule.states.includes(asString(inc) ?? '\0');
      const explicit = rule.leaveOps.includes(actorOp);
      if (curAbs && !incAbs) {
        if (!explicit) return { refuse: rule.id };
        return incomingWins ? { leave: hi } : {};
      }
      if (!curAbs && incAbs && !incomingWins) {
        // An absorbing state overrides a newer ordinary edit, unless an
        // explicit leave newer than it produced the current value.
        if (cur?.leave !== undefined && cmp(cur.leave, hi) > 0) return {};
        return { force: rule.id };
      }
      return {};
    }
    case 'rank-max': {
      if (rule.restoreOps.includes(actorOp)) return {};
      const ri = rule.order.indexOf(asString(inc) ?? '\0');
      const rc = cur === undefined ? -1 : rule.order.indexOf(asString(cur.value) ?? '\0');
      if (ri < 0 || rc < 0) return {};
      if (ri > rc) return { winsByRule: true };
      if (ri < rc) return { drop: true };
      return {};
    }
    case 'frozen-while': {
      // Judged against the row before the op: completing a task writes its
      // verification and its status together.
      const guard = asString(base.fields[rule.column]?.value);
      if (guard !== null && rule.values.includes(guard) && !rule.unfreezeOps.includes(actorOp)) {
        if (cur !== undefined && same(cur.value, inc)) return {};
        return { refuse: rule.id };
      }
      return {};
    }
    case 'write-once': {
      if (cur !== undefined && cur.value !== null && !same(cur.value, inc)) {
        return { refuse: rule.id };
      }
      return {};
    }
  }
}

/** Merge the op's after-values into a live row, unit by unit. */
function mergeFields(d: Draft, base: RowState, op: LedgerOp, ctx: MergeContext): void {
  const after = op.a ?? {};
  const counters = ctx.table.counters ?? {};
  const rules = ctx.table.rules ?? {};
  const cols = Object.keys(after).sort();
  for (const unit of units(ctx, cols)) {
    const first = unit[0];
    if (unit.length === 1 && first !== undefined && first in counters) {
      mergeCounter(d, op, first, counters[first] as CounterMode);
      continue;
    }
    const group = (ctx.table.groups ?? []).find((g) => unit.every((c) => g.includes(c))) ?? unit;
    let hi: string | undefined;
    for (const c of unit) hi = maxOf(hi, opFieldHlc(op, c));
    let hl: string | undefined;
    for (const c of group) hl = maxOf(hl, d.fields[c]?.hlc);
    const hiv = hi as string;
    const incomingWins = hl === undefined || cmp(hiv, hl) > 0;

    let refuse: string | undefined;
    let force: string | undefined;
    let drop = false;
    let winsByRule = false;
    const leaves: Record<string, string> = {};
    for (const c of unit) {
      const rule = rules[c];
      if (!rule) continue;
      const v = ruleVerdict(rule, c, d, base, op, ctx, incomingWins, hiv);
      if (v.refuse) refuse = refuse ?? v.refuse;
      if (v.force) force = force ?? v.force;
      if (v.drop) drop = true;
      if (v.winsByRule) winsByRule = true;
      if (v.leave) leaves[c] = v.leave;
    }

    if (refuse !== undefined) {
      d.conflicts.push(
        conflict(op, 'typed-rule', unit, 'incoming-dropped', { rule: refuse, localHlc: hl }),
      );
      for (const c of unit) d.skipped.push({ column: c, reason: 'rule' });
      d.refused++;
      continue;
    }
    if (drop && !force) {
      for (const c of unit) d.skipped.push({ column: c, reason: 'rule' });
      d.older++;
      continue;
    }
    const wins = incomingWins || force !== undefined || winsByRule;
    // A concurrent divergent edit: the writer started from another value.
    const divergent = unit.filter((c) => {
      const before = op.b?.[c];
      const cur = d.fields[c]?.value;
      const inc = after[c];
      if (before === undefined || inc === undefined || isIncrement(inc)) return false;
      return !same(before, cur) && !same(plain(inc), cur);
    });
    if (wins) {
      for (const c of unit) {
        const v = after[c];
        if (v === undefined) continue;
        const h = opFieldHlc(op, c);
        const prev = d.fields[c];
        // A rank-max winner keeps the newest HLC (the column only moves up). A
        // forced absorbing write keeps its own HLC, so a later absorbing write
        // still wins against it by LWW whatever the stream order.
        const hlc = winsByRule ? (maxOf(prev?.hlc, h) ?? h) : h;
        const leave = leaves[c] ?? prev?.leave;
        d.fields[c] = { value: plain(v), hlc, ...(leave !== undefined ? { leave } : {}) };
        d.written.push(c);
      }
      d.applied++;
      if (force !== undefined) {
        d.conflicts.push(
          conflict(op, 'typed-rule', unit, 'incoming-applied', { rule: force, localHlc: hl }),
        );
      } else if (divergent.length > 0) {
        d.conflicts.push(conflict(op, 'field', divergent, 'incoming-applied', { localHlc: hl }));
      }
    } else {
      for (const c of unit) d.skipped.push({ column: c, reason: 'older' });
      d.older++;
      if (divergent.length > 0) {
        d.conflicts.push(conflict(op, 'field', divergent, 'incoming-dropped', { localHlc: hl }));
      }
    }
  }
}

function outcome(
  status: OpOutcome['status'],
  next: RowState,
  effect: OpOutcome['effect'],
  d?: Draft,
  unknownColumns?: readonly string[],
): OpOutcome {
  return {
    status,
    next,
    effect,
    written: d?.written ?? [],
    skipped: d?.skipped ?? [],
    conflicts: d?.conflicts ?? [],
    ...(unknownColumns ? { unknownColumns } : {}),
  };
}

function newDraft(row: RowState): Draft {
  return {
    fields: { ...row.fields },
    written: [],
    skipped: [],
    conflicts: [],
    refused: 0,
    applied: 0,
    older: 0,
  };
}

/** A fresh row from an insert's after-values. */
function inserted(op: LedgerOp): RowState {
  const fields: Record<string, FieldState> = {};
  for (const [c, v] of Object.entries(op.a ?? {})) {
    fields[c] = { value: plain(v), hlc: opFieldHlc(op, c) };
  }
  return { live: true, tombstone: null, fields };
}

/**
 * Decide one incoming op against the stream-derived state of its row.
 *
 * @param row - The row's state at the op's stream position.
 * @param op - An I, U or D op (K ops go through the re-key path).
 * @param ctx - The table's merge spec and the transaction's `actor.op`.
 * @returns The next state, the row-level effect, written and skipped columns,
 *   and every conflict to record.
 * @throws {MergeEngineError} On a K op or an inconsistent spec.
 *
 * @example
 * ```ts
 * const out = applyOp(row, op, { table: spec, actorOp: txn.actor?.op });
 * if (out.status === 'refused-schema') stage('refused-schema');
 * ```
 */
export function applyOp(row: RowState, op: LedgerOp, ctx: MergeContext): OpOutcome {
  if (op.o === 'K') {
    // @sync-invariant none:input-shape K ops are applied by the re-key path; the field merge never receives one
    throw new MergeEngineError('K ops are applied by the re-key path, not the field merge');
  }
  assertSpec(ctx);
  const known = new Set(ctx.table.columns);
  const unknown = Object.keys(op.a ?? {}).filter((c) => !known.has(c));
  if (unknown.length > 0) return outcome('refused-schema', row, 'none', undefined, unknown);

  if (op.o === 'D') {
    if (row.live) {
      const d = newDraft(row);
      const newer = Object.entries(row.fields)
        .filter(([, f]) => cmp(f.hlc, op.h) > 0)
        .map(([c]) => c)
        .sort();
      if (newer.length > 0) {
        let lh: string | undefined;
        for (const c of newer) lh = maxOf(lh, row.fields[c]?.hlc);
        d.conflicts.push(conflict(op, 'delete-vs-edit', newer, 'row-deleted', { localHlc: lh }));
      }
      return outcome('applied', { live: false, tombstone: op.h, fields: {} }, 'delete', d);
    }
    if (row.tombstone !== null) {
      const t = maxOf(row.tombstone, op.h) ?? op.h;
      return outcome('skipped', { live: false, tombstone: t, fields: {} }, 'none');
    }
    return outcome('applied', { live: false, tombstone: op.h, fields: {} }, 'tombstone');
  }

  if (!row.live) {
    if (row.tombstone !== null && cmp(op.h, row.tombstone) <= 0) {
      // Older than the delete: never resurrect.
      return outcome('skipped', row, 'none');
    }
    if (op.o === 'I') {
      const next = inserted(op);
      const d = newDraft(next);
      d.written.push(...Object.keys(next.fields).sort());
      return outcome('applied', next, 'insert', d);
    }
    if (row.tombstone !== null) {
      const d = newDraft(row);
      d.conflicts.push(
        conflict(op, 'edit-vs-delete', Object.keys(op.a ?? {}).sort(), 'op-voided', {
          localHlc: row.tombstone,
        }),
      );
      return outcome('void', row, 'none', d);
    }
    return outcome('pending', row, 'none');
  }

  // A live row: I (same-uid concurrent insert) and U merge field by field.
  const d = newDraft(row);
  mergeFields(d, row, op, ctx);
  const next: RowState = { live: true, tombstone: null, fields: d.fields };
  const status: OpOutcome['status'] =
    d.applied > 0
      ? d.refused > 0 || d.older > 0
        ? 'partial'
        : 'applied'
      : d.refused > 0
        ? 'void'
        : 'skipped';
  return outcome(status, next, d.written.length > 0 ? 'update' : 'none', d);
}
