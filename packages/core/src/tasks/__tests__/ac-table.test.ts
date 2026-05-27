/**
 * Unit coverage for the AC dual-write planner.
 *
 * These tests exercise the pure planning function `planAcUpdate` against
 * the four canonical update paths called out in the T10508 acceptance
 * criteria — create-new, update-extend, update-shrink, update-replace-all
 * — plus the structured-gate JSON round-trip and the empty-input edge.
 *
 * @adr ADR-079-r1 §2.2 — ordinal monotonicity, never reused
 * @epic T10381
 * @saga T10377
 * @task T10508
 * @decision D013
 */

import type { AcRow } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  acItemToText,
  acTextHash,
  auditChildProjectionAcRows,
  buildAcRowId,
  buildChildProjectionAcText,
  buildFreshAcRows,
  childProjectionFreshnessFingerprint,
  childProjectionSourceKey,
  directTextSourceKey,
  evidenceBoundSourceKey,
  planAcUpdate,
  planChildProjectionRebuild,
} from '../ac-table.js';

/**
 * Build a synthetic AC row matching the shape `getAcRows` returns.
 * The id/createdAt fields don't matter for planning — only ordinal + text do.
 */
function row(taskId: string, ordinal: number, text: string, id = `uuid-${ordinal}`): AcRow {
  return {
    id,
    taskId,
    ordinal,
    kind: 'text',
    sourceKey: directTextSourceKey(ordinal, text),
    targetTaskId: null,
    projection: 'legacy',
    text,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: null,
    contentHash: acTextHash(text),
  };
}

function childRow(
  parentId: string,
  childId: string,
  childTitle: string,
  overrides: Partial<AcRow> = {},
): AcRow {
  const text = buildChildProjectionAcText(childId, childTitle);
  return {
    id: buildAcRowId(parentId, childProjectionSourceKey(childId)),
    taskId: parentId,
    ordinal: 1,
    kind: 'child_task',
    sourceKey: childProjectionSourceKey(childId),
    targetTaskId: childId,
    projection: 'parent-child',
    text,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: null,
    contentHash: childProjectionFreshnessFingerprint(childId, childTitle),
    ...overrides,
  };
}

describe('acItemToText', () => {
  it('passes strings through unchanged (trimmed)', () => {
    expect(acItemToText('  hello  ')).toBe('hello');
    expect(acItemToText('plain text')).toBe('plain text');
  });

  it('canonical JSON-serialises structured acceptance gates with stable key order', () => {
    const gate = { kind: 'test', description: 'unit run', command: 'pnpm test', expect: 'pass' };
    const reorderedGate = {
      expect: 'pass',
      command: 'pnpm test',
      description: 'unit run',
      kind: 'test',
    };
    const out = acItemToText(gate as never);
    expect(out.startsWith('{')).toBe(true);
    expect(JSON.parse(out)).toEqual(gate);
    expect(acItemToText(reorderedGate as never)).toBe(out);
    expect(out).toBe(
      '{"command":"pnpm test","description":"unit run","expect":"pass","kind":"test"}',
    );
  });
});

describe('buildFreshAcRows', () => {
  it('returns empty array for undefined / empty input', () => {
    expect(buildFreshAcRows('T001', undefined)).toEqual([]);
    expect(buildFreshAcRows('T001', [])).toEqual([]);
  });

  it('assigns deterministic UUID-shaped IDs + source keys and 1-based ordinals', () => {
    const rows = buildFreshAcRows('T001', ['AC1', 'AC2', 'AC3']);
    const secondPass = buildFreshAcRows('T001', ['AC1', 'AC2', 'AC3']);
    expect(rows).toHaveLength(3);
    expect(rows[0].ordinal).toBe(1);
    expect(rows[1].ordinal).toBe(2);
    expect(rows[2].ordinal).toBe(3);
    expect(rows.every((r) => r.taskId === 'T001')).toBe(true);
    expect(secondPass.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(secondPass.map((r) => r.sourceKey)).toEqual(rows.map((r) => r.sourceKey));

    // Each id is a unique deterministic UUIDv5-shaped value.
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(3);
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(r.sourceKey).toBe(directTextSourceKey(r.ordinal, r.text));
      expect(r.id).toBe(buildAcRowId('T001', r.text));
      expect(r.kind).toBe('text');
      expect(r.contentHash).toBe(acTextHash(r.text));
    }
  });

  it('keeps AC ids independent from ordinal while source keys retain ordinal provenance', () => {
    const firstOrdinal = buildFreshAcRows('T001', ['same body'])[0];
    const secondOrdinal = planAcUpdate(
      'T001',
      [row('T001', 1, 'different existing')],
      ['different existing', 'same body'],
    ).inserts[0];

    expect(firstOrdinal.id).toBe(secondOrdinal.id);
    expect(firstOrdinal.sourceKey).toBe(directTextSourceKey(1, 'same body'));
    expect(secondOrdinal.sourceKey).toBe(directTextSourceKey(2, 'same body'));
  });

  it('fails loudly before DB write when duplicate canonical AC bodies collide', () => {
    expect(() => buildFreshAcRows('T001', ['same body', 'same body'])).toThrow(
      'Duplicate acceptance criterion id',
    );
  });

  it('preserves AC text via acItemToText', () => {
    const rows = buildFreshAcRows('T002', [' alpha ', 'beta']);
    expect(rows[0].text).toBe('alpha');
    expect(rows[1].text).toBe('beta');
  });

  it('projects structured gates as evidence_bound AC rows with canonical hashes', () => {
    const gate = {
      kind: 'test' as const,
      req: 'unit suite passes',
      command: 'pnpm vitest run packages/core/src/tasks/__tests__/ac-table.test.ts',
    };
    const text = acItemToText(gate);
    const rows = buildFreshAcRows('T003', ['plain text', gate]);

    expect(rows[0]).toMatchObject({
      kind: 'text',
      sourceKey: directTextSourceKey(1, 'plain text'),
      contentHash: acTextHash('plain text'),
      projection: 'legacy',
    });
    expect(rows[1]).toMatchObject({
      kind: 'evidence_bound',
      sourceKey: evidenceBoundSourceKey(gate, text),
      contentHash: acTextHash(text),
      projection: 'legacy',
      targetTaskId: null,
    });
    expect(rows[1].id).toBe(buildAcRowId('T003', rows[1].sourceKey ?? ''));
  });
});

describe('planAcUpdate — create from empty (extend semantic)', () => {
  it('inserts all rows when task has no existing AC rows', () => {
    const plan = planAcUpdate('T010', [], ['AC1', 'AC2']);
    expect(plan.history).toEqual([]);
    expect(plan.fullDelete).toBe(false);
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts[0].ordinal).toBe(1);
    expect(plan.inserts[1].ordinal).toBe(2);
    expect(plan.inserts[0].text).toBe('AC1');
    expect(plan.inserts[1].text).toBe('AC2');
  });
});

describe('planAcUpdate — extend (was N, now N+M with prefix match)', () => {
  it('appends new rows at maxOrdinal+1 and leaves existing rows untouched', () => {
    const existing = [row('T011', 1, 'AC1'), row('T011', 2, 'AC2')];
    const plan = planAcUpdate('T011', existing, ['AC1', 'AC2', 'AC3']);

    // Pure append — no history, no delete.
    expect(plan.history).toEqual([]);
    expect(plan.fullDelete).toBe(false);

    // Only the new tail is inserted, at ordinal=3.
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].ordinal).toBe(3);
    expect(plan.inserts[0].text).toBe('AC3');
  });

  it('continues from highest existing ordinal even when ordinals have gaps', () => {
    // Existing rows skip ordinal 2 (post-shrink scenario).
    const existing = [row('T012', 1, 'AC1'), row('T012', 5, 'AC5')];
    const plan = planAcUpdate('T012', existing, ['AC1', 'AC5', 'AC-NEW']);
    expect(plan.fullDelete).toBe(false);
    expect(plan.history).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    // maxOrdinal was 5 → new tail starts at 6 (never reuses 2/3/4).
    expect(plan.inserts[0].ordinal).toBe(6);
    expect(plan.inserts[0].text).toBe('AC-NEW');
  });
});

describe('planAcUpdate — shrink (was N, now M < N with strict prefix)', () => {
  it('moves trailing rows to history and re-inserts the kept prefix', () => {
    const existing = [row('T013', 1, 'AC1'), row('T013', 2, 'AC2'), row('T013', 3, 'AC3')];
    const plan = planAcUpdate('T013', existing, ['AC1']);

    // Tail (AC2, AC3) goes to history with reason='edit'.
    expect(plan.history).toHaveLength(2);
    expect(plan.history[0].previousText).toBe('AC2');
    expect(plan.history[0].reason).toBe('edit');
    expect(plan.history[0].acId).toBe('uuid-2');
    expect(plan.history[1].previousText).toBe('AC3');
    expect(plan.history[1].acId).toBe('uuid-3');

    // Delete-then-reinsert path. The kept prefix re-inserts with the
    // EXISTING UUIDs + ordinals so satisfies-bindings to AC1 survive.
    expect(plan.fullDelete).toBe(true);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].id).toBe('uuid-1'); // binding stability
    expect(plan.inserts[0].ordinal).toBe(1);
    expect(plan.inserts[0].text).toBe('AC1');
  });
});

describe('planAcUpdate — replace-all (mid-edit / reorder / mixed)', () => {
  it('treats text drift as wholesale rewrite — all existing → history, all new inserted from ordinal=1', () => {
    const existing = [row('T014', 1, 'AC1-old'), row('T014', 2, 'AC2-old')];
    const plan = planAcUpdate('T014', existing, ['AC1-new', 'AC2-new']);

    // Both old rows recorded in history.
    expect(plan.history).toHaveLength(2);
    expect(plan.history.map((h) => h.previousText)).toEqual(['AC1-old', 'AC2-old']);
    expect(plan.history.every((h) => h.reason === 'edit')).toBe(true);

    // Full delete + fresh insert with new UUIDs starting from ordinal=1.
    expect(plan.fullDelete).toBe(true);
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts[0].ordinal).toBe(1);
    expect(plan.inserts[1].ordinal).toBe(2);
    expect(plan.inserts[0].text).toBe('AC1-new');
    expect(plan.inserts[1].text).toBe('AC2-new');
    // New UUIDs — NOT the existing ids (no prefix-stability path applied).
    expect(plan.inserts[0].id).not.toBe('uuid-1');
    expect(plan.inserts[1].id).not.toBe('uuid-2');
  });

  it('reorder counts as replace-all (no prefix match → full rewrite)', () => {
    const existing = [row('T015', 1, 'A'), row('T015', 2, 'B'), row('T015', 3, 'C')];
    const plan = planAcUpdate('T015', existing, ['C', 'B', 'A']);
    expect(plan.fullDelete).toBe(true);
    expect(plan.history).toHaveLength(3);
    expect(plan.inserts.map((r) => r.text)).toEqual(['C', 'B', 'A']);
  });
});

describe('planAcUpdate — idempotency (no-op when input equals existing)', () => {
  it('extend-with-zero-tail emits empty plan when texts match exactly', () => {
    const existing = [row('T016', 1, 'AC1'), row('T016', 2, 'AC2')];
    const plan = planAcUpdate('T016', existing, ['AC1', 'AC2']);
    // Same length + prefix-match → extend path with empty tail.
    expect(plan.history).toEqual([]);
    expect(plan.fullDelete).toBe(false);
    expect(plan.inserts).toEqual([]);
  });
});

describe('planAcUpdate — edge cases', () => {
  it('handles empty incoming (shrink to zero) by moving all rows to history', () => {
    const existing = [row('T017', 1, 'AC1'), row('T017', 2, 'AC2')];
    const plan = planAcUpdate('T017', existing, []);
    // Empty incoming with non-empty existing — strict prefix of length 0 → shrink.
    expect(plan.history).toHaveLength(2);
    expect(plan.fullDelete).toBe(true);
    expect(plan.inserts).toEqual([]);
  });
});

describe('child_task AC projection audit', () => {
  it('returns typed clean output with a stable freshness fingerprint', () => {
    const result = auditChildProjectionAcRows(
      'P1',
      [{ id: 'C1', title: 'Child one' }],
      [childRow('P1', 'C1', 'Child one')],
    );

    expect(result).toMatchObject({
      parentId: 'P1',
      status: 'clean',
      dirty: false,
      expectedRows: 1,
      actualRows: 1,
      staleProjection: false,
      findings: [],
    });
    expect(result.freshnessFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects missing and extra child_task rows', () => {
    const result = auditChildProjectionAcRows(
      'P1',
      [
        { id: 'C1', title: 'Child one' },
        { id: 'C2', title: 'Child two' },
      ],
      [childRow('P1', 'C1', 'Child one'), childRow('P1', 'C99', 'Orphan child', { ordinal: 2 })],
    );

    expect(result.status).toBe('dirty');
    expect(result.staleProjection).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'missing_child_task_row',
        childId: 'C2',
        field: 'row',
        expected: 'child:C2',
        actual: null,
        dirty: true,
      }),
      expect.objectContaining({
        code: 'extra_child_task_row',
        childId: 'C99',
        field: 'row',
        expected: null,
        actual: 'child:C99',
        dirty: true,
      }),
    ]);
  });

  it('detects mismatched row identity fields separately from stale projection text', () => {
    const result = auditChildProjectionAcRows(
      'P1',
      [{ id: 'C1', title: 'Fresh child title' }],
      [
        childRow('P1', 'C1', 'Old child title', {
          projection: 'legacy',
          contentHash: childProjectionFreshnessFingerprint('C1', 'Old child title'),
        }),
      ],
    );

    expect(result.dirty).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'mismatched_child_task_row',
        field: 'projection',
        expected: 'parent-child',
        actual: 'legacy',
      }),
      expect.objectContaining({
        code: 'stale_child_task_projection',
        field: 'text',
        expected: 'Complete child C1: Fresh child title',
        actual: 'Complete child C1: Old child title',
      }),
      expect.objectContaining({
        code: 'stale_child_task_projection',
        field: 'contentHash',
        expected: childProjectionFreshnessFingerprint('C1', 'Fresh child title'),
        actual: childProjectionFreshnessFingerprint('C1', 'Old child title'),
      }),
    ]);
  });
});

describe('planChildProjectionRebuild', () => {
  it('is idempotent when parent-owned child projections are clean', () => {
    const existing = [childRow('P1', 'C1', 'Child one')];
    const result = planChildProjectionRebuild('P1', [{ id: 'C1', title: 'Child one' }], existing);

    expect(result.auditBefore.status).toBe('clean');
    expect(result.plan).toEqual({ inserts: [], history: [], fullDelete: false });
    expect(result.legacyAcceptance).toEqual([]);
  });

  it('rebuilds old parent projection by removing reparented child rows', () => {
    const existing = [
      row('P1', 1, 'manual AC'),
      childRow('P1', 'C1', 'Moved child', { ordinal: 2 }),
    ];
    const result = planChildProjectionRebuild('P1', [], existing);

    expect(result.auditBefore.findings).toEqual([
      expect.objectContaining({ code: 'extra_child_task_row', childId: 'C1' }),
    ]);
    expect(result.plan.fullDelete).toBe(true);
    expect(result.plan.history).toEqual([
      {
        acId: buildAcRowId('P1', childProjectionSourceKey('C1')),
        previousText: 'Complete child C1: Moved child',
        reason: 'projection_rebuild',
      },
    ]);
    expect(result.plan.inserts).toEqual([
      expect.objectContaining({ text: 'manual AC', kind: 'text', ordinal: 1 }),
    ]);
    expect(result.legacyAcceptance).toEqual(['manual AC']);
  });

  it('rebuilds new parent projection by adding deterministic child_task rows', () => {
    const existing = [row('P2', 1, 'manual AC')];
    const result = planChildProjectionRebuild('P2', [{ id: 'C1', title: 'Moved child' }], existing);

    expect(result.auditBefore.findings).toEqual([
      expect.objectContaining({ code: 'missing_child_task_row', childId: 'C1' }),
    ]);
    expect(result.plan.fullDelete).toBe(true);
    expect(result.plan.inserts).toEqual([
      expect.objectContaining({ text: 'manual AC', kind: 'text', ordinal: 1 }),
      expect.objectContaining({
        id: buildAcRowId('P2', childProjectionSourceKey('C1')),
        taskId: 'P2',
        ordinal: 2,
        kind: 'child_task',
        sourceKey: 'child:C1',
        targetTaskId: 'C1',
        projection: 'parent-child',
        text: 'Complete child C1: Moved child',
        contentHash: childProjectionFreshnessFingerprint('C1', 'Moved child'),
      }),
    ]);
    expect(result.legacyAcceptance).toEqual(['manual AC', 'Complete child C1: Moved child']);
  });
});
