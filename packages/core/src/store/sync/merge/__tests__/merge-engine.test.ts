/**
 * The pure merge engine, case by case (T12344; journal spec §1.7, §2.6, §2.9,
 * §3.6). Convergence across replicas and orders is in `merge-convergence.test.ts`.
 *
 * @task T12344
 */

import { SYNC_SCHEMA_VERSION, SYNC_WRITE_INVARIANTS } from '@cleocode/contracts';
import type { LedgerOp, LedgerValue, LedgerWireValue } from '@cleocode/contracts/ledger';
import { describe, expect, it } from 'vitest';
import { encodeHlc } from '../../hlc.js';
import { applyOp, checkSchemaVersion, MergeEngineError } from '../engine.js';
import { implementedMergeRuleIds, mergeSpecFor, SYNC_MERGE_RULES } from '../rules.js';
import { type MergeContext, type RowState, type TableMergeSpec, UNSEEN_ROW } from '../types.js';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const h = (phys: number, replica = R1, ctr = 0): string =>
  encodeHlc({ phys: 1_700_000_000_000 + phys, ctr, replica });

const COLUMNS = [
  'title',
  'priority',
  'status',
  'completed_at',
  'cancelled_at',
  'cancellation_reason',
  'pipeline_stage',
  'verification_json',
  'hits',
  'peak',
];
const TASKS: MergeContext = { table: mergeSpecFor('tasks_tasks', COLUMNS) };
const PLAIN: MergeContext = {
  table: { columns: COLUMNS, counters: { hits: 'sum', peak: 'max' } } satisfies TableMergeSpec,
};
const as = (ctx: MergeContext, actorOp: string): MergeContext => ({ ...ctx, actorOp });

function op(
  o: LedgerOp['o'],
  hlc: string,
  a?: Record<string, LedgerValue>,
  b?: Record<string, LedgerWireValue>,
  fh?: Record<string, string>,
): LedgerOp {
  return {
    t: 'tasks_tasks',
    u: 'uid-1',
    o,
    h: hlc,
    ...(a ? { a } : {}),
    ...(b ? { b } : {}),
    ...(fh ? { fh } : {}),
  };
}

function live(values: Record<string, LedgerWireValue>, hlc: string): RowState {
  const fields: Record<string, { value: LedgerWireValue; hlc: string }> = {};
  for (const [c, v] of Object.entries(values)) fields[c] = { value: v, hlc };
  return { live: true, tombstone: null, fields };
}

const val = (row: RowState, col: string): LedgerWireValue | undefined => row.fields[col]?.value;

describe('per-field LWW by HLC', () => {
  it('a newer field wins, an older one is skipped, untouched fields stay', () => {
    const row = live({ title: 'a', priority: 'low' }, h(10));
    const out = applyOp(row, op('U', h(20), { title: 'b' }), PLAIN);
    expect(out.status).toBe('applied');
    expect(val(out.next, 'title')).toBe('b');
    expect(val(out.next, 'priority')).toBe('low');
    expect(out.written).toEqual(['title']);

    const older = applyOp(out.next, op('U', h(15), { title: 'c' }), PLAIN);
    expect(older.status).toBe('skipped');
    expect(val(older.next, 'title')).toBe('b');
    expect(older.skipped).toEqual([{ column: 'title', reason: 'older' }]);
  });

  it('per-field HLCs (fh) decide column by column', () => {
    const row = live({ title: 'a', priority: 'low' }, h(10));
    const out = applyOp(
      row,
      op('U', h(30), { title: 'b', priority: 'high' }, undefined, { title: h(5) }),
      PLAIN,
    );
    expect(out.status).toBe('partial');
    expect(val(out.next, 'title')).toBe('a');
    expect(val(out.next, 'priority')).toBe('high');
  });

  it('HLC ties break by replica id, the same way on every replica', () => {
    const row = live({ title: 'a' }, h(10, R2));
    expect(applyOp(row, op('U', h(10, R1), { title: 'x' }), PLAIN).status).toBe('skipped');
    const row1 = live({ title: 'a' }, h(10, R1));
    expect(applyOp(row1, op('U', h(10, R2), { title: 'x' }), PLAIN).status).toBe('applied');
  });

  it('re-applying the same op changes nothing', () => {
    const row = live({ title: 'a' }, h(10));
    const u = op('U', h(20), { title: 'b' });
    const once = applyOp(row, u, PLAIN).next;
    const twice = applyOp(once, u, PLAIN);
    expect(twice.status).toBe('skipped');
    expect(twice.next).toEqual(once);
  });
});

describe('field conflicts are recorded, whichever side wins', () => {
  it('a concurrent divergent edit that wins is recorded as incoming-applied', () => {
    const row = live({ title: 'mine' }, h(10));
    const out = applyOp(row, op('U', h(20, R2), { title: 'theirs' }, { title: 'base' }), PLAIN);
    expect(val(out.next, 'title')).toBe('theirs');
    expect(out.conflicts).toEqual([
      expect.objectContaining({
        kind: 'field',
        columns: ['title'],
        resolution: 'incoming-applied',
      }),
    ]);
  });

  it('a concurrent divergent edit that loses is recorded as incoming-dropped', () => {
    const row = live({ title: 'mine' }, h(30));
    const out = applyOp(row, op('U', h(20, R2), { title: 'theirs' }, { title: 'base' }), PLAIN);
    expect(val(out.next, 'title')).toBe('mine');
    expect(out.conflicts).toEqual([
      expect.objectContaining({ kind: 'field', resolution: 'incoming-dropped' }),
    ]);
  });

  it('a sequential edit (the writer saw the current value) is not a conflict', () => {
    const row = live({ title: 'mine' }, h(10));
    expect(
      applyOp(row, op('U', h(20, R2), { title: 'next' }, { title: 'mine' }), PLAIN).conflicts,
    ).toEqual([]);
  });
});

describe('groups and counters', () => {
  it('a group merges as one unit from the winning op', () => {
    const row = live({ status: 'active', completed_at: null }, h(10));
    const out = applyOp(
      row,
      op('U', h(20), { status: 'pending', completed_at: null }, undefined, { completed_at: h(5) }),
      TASKS,
    );
    // The unit's newest HLC (20) beats 10: both columns come from the op.
    expect(out.status).toBe('applied');
    expect(val(out.next, 'status')).toBe('pending');
  });

  it('counter deltas sum in any order; max keeps the extreme; neither conflicts', () => {
    const row = live({ hits: 5, peak: 3 }, h(10));
    const a = op('U', h(20), { hits: { $inc: 2 }, peak: 7 });
    const b = op('U', h(15, R2), { hits: { $inc: 4 }, peak: 4 });
    const ab = applyOp(applyOp(row, a, PLAIN).next, b, PLAIN);
    const ba = applyOp(applyOp(row, b, PLAIN).next, a, PLAIN);
    expect(val(ab.next, 'hits')).toBe(11);
    expect(val(ba.next, 'hits')).toBe(11);
    expect(val(ab.next, 'peak')).toBe(7);
    expect(val(ba.next, 'peak')).toBe(7);
    expect([...ab.conflicts, ...ba.conflicts]).toEqual([]);
  });
});

describe('tombstones (§1.7)', () => {
  it('a delete tombstones the row; an older delete-vs-newer-edit is recorded', () => {
    const row = live({ title: 'a' }, h(30));
    const out = applyOp(row, op('D', h(20, R2)), PLAIN);
    expect(out.effect).toBe('delete');
    expect(out.next).toEqual({ live: false, tombstone: h(20, R2), fields: {} });
    expect(out.conflicts).toEqual([
      expect.objectContaining({
        kind: 'delete-vs-edit',
        columns: ['title'],
        resolution: 'row-deleted',
      }),
    ]);
  });

  it('an update newer than the delete is voided as edit-vs-delete, never resurrecting', () => {
    const dead: RowState = { live: false, tombstone: h(20), fields: {} };
    const out = applyOp(dead, op('U', h(30, R2), { title: 'x' }), PLAIN);
    expect(out.status).toBe('void');
    expect(out.next).toEqual(dead);
    expect(out.conflicts).toEqual([
      expect.objectContaining({ kind: 'edit-vs-delete', resolution: 'op-voided' }),
    ]);
  });

  it('an insert or update older than the delete is skipped', () => {
    const dead: RowState = { live: false, tombstone: h(20), fields: {} };
    expect(applyOp(dead, op('I', h(10, R2), { title: 'x' }), PLAIN).status).toBe('skipped');
    expect(applyOp(dead, op('U', h(10, R2), { title: 'x' }), PLAIN).status).toBe('skipped');
  });

  it('an insert newer than the delete re-creates the row (a natural-key re-add)', () => {
    const dead: RowState = { live: false, tombstone: h(20), fields: {} };
    const out = applyOp(dead, op('I', h(30), { title: 'again' }), PLAIN);
    expect(out.effect).toBe('insert');
    expect(val(out.next, 'title')).toBe('again');
  });

  it('a double delete keeps the newest tombstone; a delete of an unseen row records one', () => {
    const dead: RowState = { live: false, tombstone: h(20), fields: {} };
    expect(applyOp(dead, op('D', h(40)), PLAIN).next.tombstone).toBe(h(40));
    const unseen = applyOp(UNSEEN_ROW, op('D', h(5)), PLAIN);
    expect(unseen.effect).toBe('tombstone');
    expect(unseen.next.tombstone).toBe(h(5));
  });

  it('an update of a row never seen is pending; an insert creates it', () => {
    expect(applyOp(UNSEEN_ROW, op('U', h(5), { title: 'x' }), PLAIN).status).toBe('pending');
    expect(applyOp(UNSEEN_ROW, op('I', h(5), { title: 'x' }), PLAIN).effect).toBe('insert');
  });

  it('a concurrent same-uid insert merges field by field', () => {
    const row = live({ title: 'a', priority: 'low' }, h(10));
    const out = applyOp(row, op('I', h(20, R2), { title: 'b' }), PLAIN);
    expect(out.effect).toBe('update');
    expect(val(out.next, 'title')).toBe('b');
    expect(val(out.next, 'priority')).toBe('low');
  });
});

describe('typed rules (§3.6.6)', () => {
  it('done is absorbing: an ordinary status change is refused with a typed-rule conflict', () => {
    const row = live({ status: 'done' }, h(10));
    const out = applyOp(row, op('U', h(20, R2), { status: 'active' }), TASKS);
    expect(out.status).toBe('void');
    expect(val(out.next, 'status')).toBe('done');
    expect(out.conflicts).toEqual([
      expect.objectContaining({
        kind: 'typed-rule',
        rule: 'task.status.absorbing',
        resolution: 'incoming-dropped',
      }),
    ]);
  });

  it('an explicit reopen leaves done', () => {
    const row = live({ status: 'done' }, h(10));
    const out = applyOp(row, op('U', h(20), { status: 'pending' }), as(TASKS, 'tasks.restore'));
    expect(out.status).toBe('applied');
    expect(val(out.next, 'status')).toBe('pending');
    expect(out.next.fields.status?.leave).toBe(h(20));
  });

  it('done overrides a newer ordinary edit, recorded as a typed-rule conflict', () => {
    const row = live({ status: 'active' }, h(30, R2));
    const out = applyOp(row, op('U', h(20), { status: 'done', completed_at: 'T' }), TASKS);
    expect(val(out.next, 'status')).toBe('done');
    expect(val(out.next, 'completed_at')).toBe('T');
    expect(out.conflicts).toEqual([
      expect.objectContaining({ kind: 'typed-rule', resolution: 'incoming-applied' }),
    ]);
  });

  it('done does not override a newer explicit reopen', () => {
    const reopened = applyOp(
      live({ status: 'done' }, h(10)),
      op('U', h(30), { status: 'pending' }),
      as(TASKS, 'tasks.restore'),
    ).next;
    const out = applyOp(reopened, op('U', h(20, R2), { status: 'done' }), TASKS);
    expect(val(out.next, 'status')).toBe('pending');
    expect(out.status).toBe('skipped');
  });

  it('pipeline_stage only moves up, whatever the HLCs; restore may move it down', () => {
    const row = live({ pipeline_stage: 'testing' }, h(10));
    const down = applyOp(row, op('U', h(50), { pipeline_stage: 'implementation' }), TASKS);
    expect(val(down.next, 'pipeline_stage')).toBe('testing');
    expect(down.skipped).toEqual([{ column: 'pipeline_stage', reason: 'rule' }]);
    const up = applyOp(row, op('U', h(5, R2), { pipeline_stage: 'release' }), TASKS);
    expect(val(up.next, 'pipeline_stage')).toBe('release');
    const restore = applyOp(
      row,
      op('U', h(50), { pipeline_stage: 'implementation' }),
      as(TASKS, 'tasks.restore'),
    );
    expect(val(restore.next, 'pipeline_stage')).toBe('implementation');
  });

  it('verification_json is frozen while done, judged before the op', () => {
    const done = live({ status: 'done', verification_json: '{"v":1}' }, h(10));
    const out = applyOp(done, op('U', h(20, R2), { verification_json: '{"v":2}' }), TASKS);
    expect(out.status).toBe('void');
    expect(out.conflicts[0]).toMatchObject({ rule: 'task.verification.frozen-on-done' });
    // Completing writes verification and status together: not frozen yet.
    const active = live({ status: 'active', verification_json: '{"v":1}' }, h(10));
    const complete = applyOp(
      active,
      op('U', h(20), { status: 'done', verification_json: '{"v":2}' }),
      TASKS,
    );
    expect(complete.status).toBe('applied');
    // A reopen unfreezes.
    const reopen = applyOp(
      done,
      op('U', h(20), { status: 'pending', verification_json: '{"v":0}' }),
      as(TASKS, 'tasks.restore'),
    );
    expect(val(reopen.next, 'verification_json')).toBe('{"v":0}');
  });

  it('write-once refuses a different later value', () => {
    const spec: MergeContext = {
      table: { columns: ['k'], rules: { k: { kind: 'write-once', id: 'test.write-once' } } },
    };
    const row = live({ k: 'first' }, h(10));
    expect(applyOp(row, op('U', h(20), { k: 'second' }), spec).status).toBe('void');
    expect(applyOp(row, op('U', h(20), { k: 'first' }), spec).status).toBe('applied');
  });
});

describe('schema skew is refused explicitly (§2.9)', () => {
  it('an op naming a column this schema lacks is refused-schema, nothing applied', () => {
    const row = live({ title: 'a' }, h(10));
    const out = applyOp(row, op('U', h(20), { title: 'b', added_in_v99: 1 }), PLAIN);
    expect(out.status).toBe('refused-schema');
    expect(out.unknownColumns).toEqual(['added_in_v99']);
    expect(out.next).toBe(row);
  });

  it('a newer segment schemaVersion or transaction format is refused with E_SCHEMA_AHEAD', () => {
    expect(checkSchemaVersion(SYNC_SCHEMA_VERSION)).toBeNull();
    expect(checkSchemaVersion(SYNC_SCHEMA_VERSION + 1)).toMatchObject({ code: 'E_SCHEMA_AHEAD' });
    expect(checkSchemaVersion(SYNC_SCHEMA_VERSION, 2)).toMatchObject({ code: 'E_SCHEMA_AHEAD' });
    expect(checkSchemaVersion(SYNC_SCHEMA_VERSION, 1)).toBeNull();
  });

  it('a K op never reaches the field merge', () => {
    expect(() =>
      applyOp(UNSEEN_ROW, { t: 'tasks_tasks', u: 'a', o: 'K', h: h(1), nu: 'b' }, PLAIN),
    ).toThrow(MergeEngineError);
  });
});

describe('the merge-rule registry matches the write-invariant registry', () => {
  it('every implemented rule id is a monotonic-merge-rule entry on the same table and columns', () => {
    const entries = SYNC_WRITE_INVARIANTS.filter((e) => e.class === 'monotonic-merge-rule');
    for (const [table, set] of Object.entries(SYNC_MERGE_RULES)) {
      for (const [column, rule] of Object.entries(set.rules ?? {})) {
        const entry = entries.find((e) => e.id === rule.id);
        expect(entry, `${rule.id} is not in SYNC_WRITE_INVARIANTS`).toBeDefined();
        expect(entry?.mergeRule?.table).toBe(table);
        expect(entry?.mergeRule?.columns).toContain(column);
      }
    }
    expect(implementedMergeRuleIds()).toEqual([
      'task.pipeline-stage.max',
      'task.status.absorbing',
      'task.verification.frozen-on-done',
    ]);
  });
});
