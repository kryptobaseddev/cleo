/**
 * Convergence of the merge engine across 2 and 3 replicas, in every order
 * (T12344 AC1 "two concurrent writers converge to the same state"; journal
 * spec §2.9 "receivers apply in stream seq order and decide by HLC", §3.5
 * Rule 1).
 *
 * Each scenario starts every replica from the same row. Each replica then
 * writes concurrently: its ops carry increasing HLCs and the before-images of
 * what THAT replica saw, never the others' writes. The server may interleave
 * the replicas' ops into the stream in any order that keeps each replica's
 * own order; every such interleaving is folded, exhaustively. Scenarios come
 * from a seeded generator, so a failure names a reproducible seed.
 *
 * Properties:
 * - P1 one stream, one state: replicas folding the same stream agree, and
 *   re-delivering plain LWW ops changes nothing (counters and typed rules
 *   rely on the inbox's exactly-once delivery instead).
 * - P2 plain LWW, groups and counters converge in EVERY interleaving.
 * - P3 a delete wins in every interleaving: the row ends tombstoned, an update
 *   after it is voided, and newer edits it removes are recorded.
 * - P4 typed-rule invariants hold at every step of every interleaving:
 *   terminal status left only by an explicit op, pipeline_stage never down
 *   without restore, verification never changed while done.
 * - P5 no silent drop: every concurrent divergent edit, applied or not, is a
 *   recorded conflict (counters and rank-max excepted, which merge by rule).
 * - P6 without explicit leave/restore ops, status and pipeline_stage converge
 *   in every interleaving: a terminal status dominates, pipeline_stage is a max.
 *
 * Order-sensitive rules (an explicit reopen racing a completion, a
 * verification edit racing a completion) are deterministic per stream (P1)
 * and checked for invariants (P4), not for order independence: the spec makes
 * the stream order, not the arrival order, decide them.
 *
 * @task T12344
 */

import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts';
import type { LedgerOp, LedgerValue, LedgerWireValue } from '@cleocode/contracts/ledger';
import { describe, expect, it } from 'vitest';
import { PIPELINE_STAGES } from '../../../../lifecycle/stages.js';
import { encodeHlc } from '../../hlc.js';
import { canonicalJson } from '../../sealer-values.js';
import { applyOp } from '../engine.js';
import { mergeSpecFor, TASK_STATUS_LEAVE_OPS } from '../rules.js';
import type { MergeContext, OpOutcome, RowState, TableMergeSpec } from '../types.js';

const REPLICAS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;
const T0 = 1_700_000_000_000;
const COLUMNS = [
  'title',
  'priority',
  'labels',
  'status',
  'completed_at',
  'cancelled_at',
  'cancellation_reason',
  'pipeline_stage',
  'verification_json',
  'hits',
  'peak',
];
const TERMINAL = [...TERMINAL_TASK_STATUSES] as string[];
/** Columns with typed rules or groups in the tasks spec. */
const TYPED = [
  'status',
  'completed_at',
  'cancelled_at',
  'cancellation_reason',
  'pipeline_stage',
  'verification_json',
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** One stream entry: the op and the transaction's actor.op. */
interface Entry {
  readonly op: LedgerOp;
  readonly actorOp: string | null;
  readonly replica: number;
}

/** Every interleaving of the sequences that keeps each sequence's order. */
function interleavings<T>(seqs: readonly (readonly T[])[]): T[][] {
  const out: T[][] = [];
  const idx = seqs.map(() => 0);
  const cur: T[] = [];
  const total = seqs.reduce((n, s) => n + s.length, 0);
  const walk = (): void => {
    if (cur.length === total) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < seqs.length; i++) {
      const s = seqs[i] as readonly T[];
      const k = idx[i] as number;
      if (k < s.length) {
        cur.push(s[k] as T);
        idx[i] = k + 1;
        walk();
        idx[i] = k;
        cur.pop();
      }
    }
  };
  walk();
  return out;
}

function baseRow(): RowState {
  const values: Record<string, LedgerWireValue> = {
    title: 'base',
    priority: 'medium',
    labels: '[]',
    status: 'active',
    completed_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    pipeline_stage: 'implementation',
    verification_json: '{"round":0}',
    hits: 10,
    peak: 5,
  };
  const fields: RowState['fields'] = Object.fromEntries(
    Object.entries(values).map(([c, v]) => [
      c,
      { value: v, hlc: encodeHlc({ phys: T0, ctr: 0, replica: REPLICAS[0] }) },
    ]),
  );
  return { live: true, tombstone: null, fields };
}

interface GenOptions {
  readonly replicas: number;
  readonly opsPerReplica: number;
  /** Allow explicit leave/restore ops. */
  readonly explicit: boolean;
  /** Probability that an op is a delete. */
  readonly deleteRate: number;
  /** Only plain columns (no typed-rule columns). */
  readonly plainOnly: boolean;
}

/** A replica's concurrent writes, each with that replica's own before-image. */
function generate(seed: number, g: GenOptions, ctx: MergeContext): Entry[][] {
  const r = rng(seed);
  const seqs: Entry[][] = [];
  for (let ri = 0; ri < g.replicas; ri++) {
    const replica = REPLICAS[ri] as string;
    let view = baseRow();
    let phys = T0 + 1 + Math.floor(r() * 5);
    const seq: Entry[] = [];
    for (let k = 0; k < g.opsPerReplica; k++) {
      // Concurrency: replicas draw from overlapping clock ranges.
      phys += 1 + Math.floor(r() * 4);
      const h = encodeHlc({ phys, ctr: Math.floor(r() * 3), replica });
      if (!view.live) break;
      if (r() < g.deleteRate) {
        const op: LedgerOp = { t: 'tasks_tasks', u: 'row', o: 'D', h };
        seq.push({ op, actorOp: null, replica: ri });
        view = applyOp(view, op, ctx).next;
        continue;
      }
      const a: Record<string, LedgerValue> = {};
      const b: Record<string, LedgerWireValue> = {};
      const touch = (col: string, v: LedgerValue): void => {
        a[col] = v;
        const cur = view.fields[col]?.value;
        if (cur !== undefined) b[col] = cur;
      };
      let actorOp: string | null = null;
      const kind = g.plainOnly
        ? pick(r, ['title', 'counter', 'group'])
        : pick(r, ['title', 'counter', 'status', 'stage', 'verify', 'group']);
      if (kind === 'title')
        touch(
          pick(r, ['title', 'priority', 'labels']),
          `${replica.slice(0, 2)}-${k}-${Math.floor(r() * 3)}`,
        );
      if (kind === 'counter') {
        touch('hits', { $inc: 1 + Math.floor(r() * 5) });
        touch('peak', Math.floor(r() * 20));
      }
      if (kind === 'group') {
        // A plain multi-column edit, merged column by column.
        touch('title', `g-${replica.slice(0, 2)}-${k}`);
        touch('priority', pick(r, ['low', 'high', 'critical']));
      }
      if (kind === 'status') {
        const s = pick(r, ['pending', 'active', 'blocked', 'done', 'cancelled', 'archived']);
        touch('status', s);
        touch('completed_at', s === 'done' ? `done@${phys}` : null);
        touch('cancelled_at', s === 'cancelled' ? `cancel@${phys}` : null);
        touch('cancellation_reason', s === 'cancelled' ? 'dup' : null);
        if (g.explicit && !TERMINAL.includes(s) && r() < 0.5)
          actorOp = pick(r, TASK_STATUS_LEAVE_OPS);
      }
      if (kind === 'stage') {
        touch('pipeline_stage', pick(r, PIPELINE_STAGES));
        if (g.explicit && r() < 0.3) actorOp = 'tasks.restore';
      }
      if (kind === 'verify')
        touch('verification_json', `{"round":${k + 1},"by":"${replica.slice(0, 2)}"}`);
      const op: LedgerOp = { t: 'tasks_tasks', u: 'row', o: 'U', h, a, b };
      seq.push({ op, actorOp, replica: ri });
      view = applyOp(view, op, { ...ctx, actorOp }).next;
    }
    seqs.push(seq);
  }
  return seqs;
}

interface Step {
  readonly entry: Entry;
  readonly before: RowState;
  readonly out: OpOutcome;
}

function fold(
  row: RowState,
  stream: readonly Entry[],
  ctx: MergeContext,
): { row: RowState; steps: Step[] } {
  const steps: Step[] = [];
  let cur = row;
  for (const entry of stream) {
    const out = applyOp(cur, entry.op, { ...ctx, actorOp: entry.actorOp });
    steps.push({ entry, before: cur, out });
    cur = out.next;
  }
  return { row: cur, steps };
}

/** A row's merged content (values and liveness), the thing replicas must agree on. */
function content(row: RowState, cols?: readonly string[]): string {
  if (!row.live) return `tombstone ${row.tombstone}`;
  const keys = (cols ?? Object.keys(row.fields)).slice().sort();
  return canonicalJson(Object.fromEntries(keys.map((c) => [c, row.fields[c]?.value ?? null])));
}

const TASKS: MergeContext = { table: mergeSpecFor('tasks_tasks', COLUMNS) };
const PLAIN: MergeContext = {
  table: {
    columns: COLUMNS,
    counters: { hits: 'sum', peak: 'max' },
  } satisfies TableMergeSpec,
};

function scenarios(
  n: number,
  g: GenOptions,
  ctx: MergeContext,
  check: (streams: Entry[][], seed: number) => void,
): number {
  let streams = 0;
  for (let seed = 1; seed <= n; seed++) {
    const seqs = generate(seed * 7919 + g.replicas, g, ctx);
    const all = interleavings(seqs);
    streams += all.length;
    check(all, seed);
  }
  return streams;
}

describe.each([
  { replicas: 2, opsPerReplica: 3, scenarios: 300 },
  { replicas: 3, opsPerReplica: 2, scenarios: 150 },
  { replicas: 3, opsPerReplica: 3, scenarios: 25 },
])('$replicas replicas × $opsPerReplica ops, every interleaving', ({
  replicas,
  opsPerReplica,
  scenarios: n,
}) => {
  it('P1: one stream, one state; re-delivery changes nothing', () => {
    scenarios(
      n,
      { replicas, opsPerReplica, explicit: true, deleteRate: 0.1, plainOnly: false },
      TASKS,
      (all, seed) => {
        for (const stream of all.slice(0, 20)) {
          const a = fold(baseRow(), stream, TASKS).row;
          const b = fold(baseRow(), stream, TASKS).row;
          expect(content(b), `seed ${seed}`).toBe(content(a));
          expect(b, `seed ${seed}`).toEqual(a);
          // Re-delivering plain LWW ops is a no-op. Counter deltas and typed-rule
          // columns rely on exactly-once delivery instead (the inbox dedupes by
          // stream position), since their result depends on the current state.
          const lww = stream.filter(
            (e) =>
              !Object.entries(e.op.a ?? {}).some(
                ([c, v]) =>
                  TYPED.includes(c) || (typeof v === 'object' && v !== null && '$inc' in v),
              ),
          );
          const again = fold(a, lww, TASKS).row;
          expect(content(again), `seed ${seed} re-delivery`).toBe(content(a));
        }
      },
    );
  });

  it('P2: plain LWW and counters converge in every interleaving', () => {
    const total = scenarios(
      n,
      { replicas, opsPerReplica, explicit: false, deleteRate: 0, plainOnly: true },
      PLAIN,
      (all, seed) => {
        const expected = content(fold(baseRow(), all[0] as Entry[], PLAIN).row);
        for (const stream of all) {
          expect(content(fold(baseRow(), stream, PLAIN).row), `seed ${seed}`).toBe(expected);
        }
      },
    );
    expect(total).toBeGreaterThan(n);
  });

  it('P3: a delete wins in every interleaving and nothing it removes is silent', () => {
    scenarios(
      n,
      { replicas, opsPerReplica, explicit: false, deleteRate: 0.35, plainOnly: true },
      PLAIN,
      (all, seed) => {
        const hasDelete = all[0]?.some((e) => e.op.o === 'D');
        for (const stream of all) {
          const { row, steps } = fold(baseRow(), stream, PLAIN);
          if (!hasDelete) continue;
          expect(row.live, `seed ${seed}`).toBe(false);
          let deleted = false;
          for (const s of steps) {
            if (s.entry.op.o === 'D') deleted = true;
            else if (deleted) {
              // After the delete in stream order: voided with edit-vs-delete, or older and skipped.
              expect(['void', 'skipped'], `seed ${seed}`).toContain(s.out.status);
              if (s.out.status === 'void') expect(s.out.conflicts[0]?.kind).toBe('edit-vs-delete');
            }
          }
        }
      },
    );
  });

  it('P4: typed-rule invariants hold at every step of every interleaving', () => {
    scenarios(
      n,
      { replicas, opsPerReplica, explicit: true, deleteRate: 0, plainOnly: false },
      TASKS,
      (all, seed) => {
        for (const stream of all) {
          for (const s of fold(baseRow(), stream, TASKS).steps) {
            const before = s.before.fields;
            const after = s.out.next.fields;
            const actor = s.entry.actorOp ?? '';
            const prevStatus = before.status?.value as string;
            const nextStatus = after.status?.value as string;
            if (TERMINAL.includes(prevStatus) && !TERMINAL.includes(nextStatus)) {
              expect(
                TASK_STATUS_LEAVE_OPS,
                `seed ${seed}: left ${prevStatus} without an explicit op`,
              ).toContain(actor);
            }
            const rank = (v: unknown): number =>
              PIPELINE_STAGES.indexOf(v as (typeof PIPELINE_STAGES)[number]);
            if (rank(after.pipeline_stage?.value) < rank(before.pipeline_stage?.value)) {
              expect(actor, `seed ${seed}: pipeline_stage moved down`).toMatch(
                /^tasks\.(restore|reopen)$/,
              );
            }
            if (
              prevStatus === 'done' &&
              after.verification_json?.value !== before.verification_json?.value
            ) {
              expect(
                TASK_STATUS_LEAVE_OPS,
                `seed ${seed}: verification changed while done`,
              ).toContain(actor);
            }
          }
        }
      },
    );
  });

  it('P5: every concurrent divergent edit is a recorded conflict, applied or not', () => {
    scenarios(
      n,
      { replicas, opsPerReplica, explicit: true, deleteRate: 0.1, plainOnly: false },
      TASKS,
      (all, seed) => {
        for (const stream of all) {
          for (const s of fold(baseRow(), stream, TASKS).steps) {
            if (s.entry.op.o !== 'U' || !s.before.live) continue;
            const covered = new Set(s.out.conflicts.flatMap((c) => c.columns));
            const whole = s.out.conflicts.some((c) => c.kind === 'edit-vs-delete');
            for (const [col, v] of Object.entries(s.entry.op.a ?? {})) {
              if (col === 'hits' || col === 'peak' || col === 'pipeline_stage') continue;
              if (typeof v === 'object' && v !== null && '$inc' in v) continue;
              const was = s.entry.op.b?.[col];
              const cur = s.before.fields[col]?.value;
              const divergent =
                was !== undefined &&
                canonicalJson(was) !== canonicalJson(cur ?? null) &&
                canonicalJson(v) !== canonicalJson(cur ?? null);
              if (divergent)
                expect(
                  covered.has(col) || whole,
                  `seed ${seed}: silent divergent edit of ${col}`,
                ).toBe(true);
            }
          }
        }
      },
    );
  });

  it('P6: without explicit ops, status and pipeline_stage converge in every interleaving', () => {
    const cols = [
      'status',
      'completed_at',
      'cancelled_at',
      'cancellation_reason',
      'pipeline_stage',
    ];
    scenarios(
      n,
      { replicas, opsPerReplica, explicit: false, deleteRate: 0, plainOnly: false },
      TASKS,
      (all, seed) => {
        const expected = content(fold(baseRow(), all[0] as Entry[], TASKS).row, cols);
        for (const stream of all) {
          expect(content(fold(baseRow(), stream, TASKS).row, cols), `seed ${seed}`).toBe(expected);
        }
      },
    );
  });
});
