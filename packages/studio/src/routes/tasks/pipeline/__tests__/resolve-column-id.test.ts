/**
 * Tests for T873 — Studio Pipeline `resolveColumnId`.
 *
 * Verifies that tasks land in the correct Kanban column given every
 * combination of `status` × `pipeline_stage`. Primary goal: close the
 * drift where `status=done` with `pipeline_stage=research` was rendered
 * in the RESEARCH column, leaving DONE empty.
 *
 * @task T873
 * @epic T870
 */

import { describe, expect, it } from 'vitest';
import { __testing__ } from '../+page.server.js';

const { resolveColumnId, PIPELINE_STAGES, COLUMN_LABELS } = __testing__;

describe('PIPELINE_STAGES column taxonomy (T873)', () => {
  it('includes all canonical RCASD-IVTR+C stages', () => {
    for (const stage of [
      'research',
      'consensus',
      'architecture_decision',
      'specification',
      'decomposition',
      'implementation',
      'validation',
      'testing',
      'release',
    ] as const) {
      expect(PIPELINE_STAGES).toContain(stage);
    }
  });

  it('includes terminal display buckets done + cancelled', () => {
    expect(PIPELINE_STAGES).toContain('done');
    expect(PIPELINE_STAGES).toContain('cancelled');
  });
});

describe('resolveColumnId (T873)', () => {
  // ------------------------------------------------------------------
  // status=done always wins — this is the T871/T873 core fix
  // ------------------------------------------------------------------

  it('status=done + pipeline_stage=research → done (primary bug fix)', () => {
    expect(resolveColumnId({ status: 'done', pipeline_stage: 'research' })).toBe('done');
  });

  it('status=done + pipeline_stage=implementation → done (T832 case)', () => {
    expect(resolveColumnId({ status: 'done', pipeline_stage: 'implementation' })).toBe('done');
  });

  it('status=done + pipeline_stage=release → done (T487 case)', () => {
    expect(resolveColumnId({ status: 'done', pipeline_stage: 'release' })).toBe('done');
  });

  it('status=done + pipeline_stage=contribution → done', () => {
    expect(resolveColumnId({ status: 'done', pipeline_stage: 'contribution' })).toBe('done');
  });

  it('status=done + pipeline_stage=null → done', () => {
    expect(resolveColumnId({ status: 'done', pipeline_stage: null })).toBe('done');
  });

  // ------------------------------------------------------------------
  // status=cancelled always routes to cancelled column
  // ------------------------------------------------------------------

  it('status=cancelled + pipeline_stage=research → cancelled', () => {
    expect(resolveColumnId({ status: 'cancelled', pipeline_stage: 'research' })).toBe('cancelled');
  });

  it('status=cancelled + pipeline_stage=cancelled → cancelled', () => {
    expect(resolveColumnId({ status: 'cancelled', pipeline_stage: 'cancelled' })).toBe('cancelled');
  });

  it('status=cancelled + pipeline_stage=null → cancelled', () => {
    expect(resolveColumnId({ status: 'cancelled', pipeline_stage: null })).toBe('cancelled');
  });

  // ------------------------------------------------------------------
  // Non-terminal status rows honour pipeline_stage
  // ------------------------------------------------------------------

  it('status=pending + pipeline_stage=research → research', () => {
    expect(resolveColumnId({ status: 'pending', pipeline_stage: 'research' })).toBe('research');
  });

  it('status=active + pipeline_stage=implementation → implementation', () => {
    expect(resolveColumnId({ status: 'active', pipeline_stage: 'implementation' })).toBe(
      'implementation',
    );
  });

  it('status=blocked + pipeline_stage=validation → validation', () => {
    expect(resolveColumnId({ status: 'blocked', pipeline_stage: 'validation' })).toBe('validation');
  });

  it('status=pending + pipeline_stage=contribution → done (pre-backfill drift)', () => {
    // A task with pipeline_stage=contribution but status!=done is abnormal
    // but should still route to the `done` display bucket — that's what
    // the contribution stage means.
    expect(resolveColumnId({ status: 'pending', pipeline_stage: 'contribution' })).toBe('done');
  });

  // ------------------------------------------------------------------
  // Unassigned / unknown
  // ------------------------------------------------------------------

  it('status=pending + pipeline_stage=null → unassigned', () => {
    expect(resolveColumnId({ status: 'pending', pipeline_stage: null })).toBe('unassigned');
  });

  it('status=pending + pipeline_stage=unknown_value → unassigned', () => {
    expect(resolveColumnId({ status: 'pending', pipeline_stage: 'mystery' })).toBe('unassigned');
  });
});

describe('COLUMN_LABELS (T880)', () => {
  it('maps architecture_decision to Design / ADR (owner directive)', () => {
    expect(COLUMN_LABELS['architecture_decision']).toBe('Design / ADR');
  });

  it('provides a human label for every canonical enum stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(COLUMN_LABELS[stage]).toBeDefined();
      expect(COLUMN_LABELS[stage]).not.toBe('');
    }
  });

  it('labels terminal buckets clearly', () => {
    expect(COLUMN_LABELS['done']).toBe('Done');
    expect(COLUMN_LABELS['cancelled']).toBe('Cancelled');
    expect(COLUMN_LABELS['unassigned']).toBe('Unassigned');
  });

  it('does not use the legacy "Arch. Decision" label', () => {
    // Owner flagged the old shortened label as unclear. T880 replaces it.
    expect(Object.values(COLUMN_LABELS)).not.toContain('Arch. Decision');
  });
});
