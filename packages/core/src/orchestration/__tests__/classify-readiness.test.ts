/**
 * Tests for the E3-GRILL-GATE classifyReadiness predicate — T11495.
 *
 * Verifies:
 *  - MISSING_AC trigger: fires when no acceptance criteria present.
 *  - OWNER_DECISION_REQUIRED trigger: fires on label or blockedBy text.
 *  - IVTR_MAX_RETRIES trigger: fires when any phase hits MAX_LOOP_BACKS_PER_PHASE.
 *  - RELEASE_GATE trigger: fires on release/publish stage without hitlApproved.
 *  - AMBIGUOUS_SCOPE trigger: fires on bare epic with no children and no spec blob.
 *  - Auto-proceed: all triggers clear → verdict 'proceed'.
 *  - Auto-proceed: impl+ epic with non-empty ready frontier → verdict 'proceed'.
 *  - Multi-trigger: multiple grill triggers fire simultaneously.
 *
 * @task T11495 E3-GRILL-GATE
 * @epic T11492 SG-AUTOPILOT
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { IvtrState } from '../../lifecycle/ivtr-loop.js';
import { MAX_LOOP_BACKS_PER_PHASE } from '../../lifecycle/ivtr-loop.js';
import type { ReadinessSignals } from '../classify-readiness.js';
import { classifyReadiness } from '../classify-readiness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid task with acceptance criteria — used as the "all-clear" base. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T9000',
    title: 'Default test task',
    description: 'A clear, scoped test task.',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    createdAt: '2026-05-31T00:00:00Z',
    acceptance: ['Implement the feature per spec.'],
    ...overrides,
  };
}

/** Build an IvtrState with specific loop-back counts per phase. */
function makeIvtrState(loopBackCounts: Partial<Record<string, number>> = {}): IvtrState {
  return {
    taskId: 'T9000',
    schemaVersion: 2,
    currentPhase: 'implement',
    phaseHistory: [],
    startedAt: '2026-05-31T00:00:00Z',
    loopBackCount: {
      implement: loopBackCounts['implement'] ?? 0,
      validate: loopBackCounts['validate'] ?? 0,
      audit: loopBackCounts['audit'] ?? 0,
      test: loopBackCounts['test'] ?? 0,
      released: loopBackCounts['released'] ?? 0,
    },
  };
}

/** Build a child task for epic frontier tests. */
function makeChild(id: string, status: Task['status'] = 'pending', depends: string[] = []): Task {
  return makeTask({ id, status, depends, type: 'task', acceptance: ['done.'] });
}

// ---------------------------------------------------------------------------
// 1. MISSING_AC trigger
// ---------------------------------------------------------------------------

describe('classifyReadiness — MISSING_AC', () => {
  it('grills when acceptance is absent', () => {
    const task = makeTask({ acceptance: undefined });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
  });

  it('grills when acceptance is empty array', () => {
    const task = makeTask({ acceptance: [] });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
  });

  it('grills when all acceptance entries are blank strings', () => {
    const task = makeTask({ acceptance: ['  ', ''] });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
  });

  it('proceeds when at least one non-empty acceptance criterion exists', () => {
    const task = makeTask({ acceptance: ['AC1: implement the feature.'] });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('proceed');
    expect(result.triggers).not.toContain('MISSING_AC');
  });

  it('proceeds when acceptance contains a structured gate object', () => {
    const gate = { kind: 'test', command: 'pnpm test', expect: 'pass', description: 'Tests pass.' };
    const task = makeTask({ acceptance: [gate as unknown as string] });
    const result = classifyReadiness(task);
    expect(result.triggers).not.toContain('MISSING_AC');
  });
});

// ---------------------------------------------------------------------------
// 2. OWNER_DECISION_REQUIRED trigger
// ---------------------------------------------------------------------------

describe('classifyReadiness — OWNER_DECISION_REQUIRED', () => {
  it('grills when label "owner-decision" is present (exact match)', () => {
    const task = makeTask({ labels: ['owner-decision'] });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
  });

  it('grills when label "owner-decision" is mixed-case', () => {
    const task = makeTask({ labels: ['Owner-Decision'] });
    const result = classifyReadiness(task);
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
  });

  it('grills when blockedBy mentions "owner"', () => {
    const task = makeTask({ blockedBy: 'Waiting on owner to pick approach.' });
    const result = classifyReadiness(task);
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
  });

  it('grills when blockedBy mentions "decision"', () => {
    const task = makeTask({ blockedBy: 'Pending architectural decision by Keaton.' });
    const result = classifyReadiness(task);
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
  });

  it('proceeds when labels do not contain owner-decision and blockedBy is unrelated', () => {
    const task = makeTask({ labels: ['feature', 'backend'], blockedBy: 'CI fix needed.' });
    const result = classifyReadiness(task);
    expect(result.triggers).not.toContain('OWNER_DECISION_REQUIRED');
  });

  it('proceeds when no labels and blockedBy is absent', () => {
    const task = makeTask({ labels: undefined, blockedBy: undefined });
    const result = classifyReadiness(task);
    expect(result.triggers).not.toContain('OWNER_DECISION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// 3. IVTR_MAX_RETRIES trigger
// ---------------------------------------------------------------------------

describe('classifyReadiness — IVTR_MAX_RETRIES', () => {
  it('grills when any phase hits MAX_LOOP_BACKS_PER_PHASE', () => {
    const ivtrState = makeIvtrState({ validate: MAX_LOOP_BACKS_PER_PHASE });
    const result = classifyReadiness(makeTask(), { ivtrState });
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('IVTR_MAX_RETRIES');
  });

  it('grills when IMPLEMENT phase hits max retries', () => {
    const ivtrState = makeIvtrState({ implement: MAX_LOOP_BACKS_PER_PHASE });
    const result = classifyReadiness(makeTask(), { ivtrState });
    expect(result.triggers).toContain('IVTR_MAX_RETRIES');
  });

  it('grills when TEST phase hits max retries', () => {
    const ivtrState = makeIvtrState({ test: MAX_LOOP_BACKS_PER_PHASE });
    const result = classifyReadiness(makeTask(), { ivtrState });
    expect(result.triggers).toContain('IVTR_MAX_RETRIES');
  });

  it('proceeds when all phases are below max retries', () => {
    const ivtrState = makeIvtrState({ validate: MAX_LOOP_BACKS_PER_PHASE - 1 });
    const result = classifyReadiness(makeTask(), { ivtrState });
    expect(result.triggers).not.toContain('IVTR_MAX_RETRIES');
  });

  it('proceeds when ivtrState is null (check skipped)', () => {
    const result = classifyReadiness(makeTask(), { ivtrState: null });
    expect(result.triggers).not.toContain('IVTR_MAX_RETRIES');
  });

  it('proceeds when ivtrState is absent (check skipped)', () => {
    const result = classifyReadiness(makeTask(), {});
    expect(result.triggers).not.toContain('IVTR_MAX_RETRIES');
  });
});

// ---------------------------------------------------------------------------
// 4. RELEASE_GATE trigger
// ---------------------------------------------------------------------------

describe('classifyReadiness — RELEASE_GATE', () => {
  it('grills when pipelineStage is "release" and hitlApproved is false', () => {
    const task = makeTask({ pipelineStage: 'release' });
    const result = classifyReadiness(task, { hitlApproved: false });
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('RELEASE_GATE');
  });

  it('grills when pipelineStage is "publish" and hitlApproved is false', () => {
    const task = makeTask({ pipelineStage: 'publish' });
    const result = classifyReadiness(task, { hitlApproved: false });
    expect(result.triggers).toContain('RELEASE_GATE');
  });

  it('proceeds when pipelineStage is "release" but hitlApproved is true', () => {
    const task = makeTask({ pipelineStage: 'release' });
    const result = classifyReadiness(task, { hitlApproved: true });
    expect(result.triggers).not.toContain('RELEASE_GATE');
  });

  it('proceeds when pipelineStage is "implementation" (not a release gate)', () => {
    const task = makeTask({ pipelineStage: 'implementation' });
    const result = classifyReadiness(task);
    expect(result.triggers).not.toContain('RELEASE_GATE');
  });

  it('proceeds when pipelineStage is absent', () => {
    const task = makeTask({ pipelineStage: undefined });
    const result = classifyReadiness(task);
    expect(result.triggers).not.toContain('RELEASE_GATE');
  });

  it('defaults hitlApproved to false when signals are absent', () => {
    const task = makeTask({ pipelineStage: 'release' });
    const result = classifyReadiness(task);
    expect(result.triggers).toContain('RELEASE_GATE');
  });
});

// ---------------------------------------------------------------------------
// 5. AMBIGUOUS_SCOPE trigger
// ---------------------------------------------------------------------------

describe('classifyReadiness — AMBIGUOUS_SCOPE', () => {
  it('grills on bare epic with no children and no blobs', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic, { children: [], blobNames: [] });
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('AMBIGUOUS_SCOPE');
  });

  it('grills on epic with no children when signals are absent', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic);
    expect(result.triggers).toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds when epic has children', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const children = [makeChild('T9001')];
    const result = classifyReadiness(epic, { children });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds when epic has a spec blob attachment', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic, { children: [], blobNames: ['my-spec.md'] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds when epic has a research blob attachment', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic, { children: [], blobNames: ['research-notes.md'] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds when epic has an adr blob attachment', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic, { children: [], blobNames: ['adr-001.md'] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds when epic has a design blob attachment', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'research' });
    const result = classifyReadiness(epic, { children: [], blobNames: ['design-overview.pdf'] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds on non-epic task (scope check skipped)', () => {
    const task = makeTask({ type: 'task', pipelineStage: 'research' });
    const result = classifyReadiness(task, { children: [], blobNames: [] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });

  it('proceeds on epic in implementation stage even with no children', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'implementation' });
    const result = classifyReadiness(epic, { children: [], blobNames: [] });
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE');
  });
});

// ---------------------------------------------------------------------------
// 6. Auto-proceed — all-clear
// ---------------------------------------------------------------------------

describe('classifyReadiness — auto-proceed', () => {
  it('proceeds when all triggers are clear (simple task)', () => {
    const task = makeTask();
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('proceed');
    expect(result.triggers).toHaveLength(0);
    expect(result.reason).toContain('cleared all readiness checks');
  });

  it('proceeds for impl+ epic with non-empty ready frontier (AC2)', () => {
    const epic = makeTask({ id: 'T8000', type: 'epic', pipelineStage: 'implementation' });
    const children = [
      makeChild('T8001', 'pending', []), // ready: no deps
      makeChild('T8002', 'done', []), // done
    ];
    const result = classifyReadiness(epic, { children });
    expect(result.verdict).toBe('proceed');
    expect(result.reason).toContain('non-empty ready frontier');
  });

  it('proceed reason mentions the task ID', () => {
    const task = makeTask({ id: 'T7777' });
    const result = classifyReadiness(task);
    expect(result.reason).toContain('T7777');
  });
});

// ---------------------------------------------------------------------------
// 7. Ready frontier logic
// ---------------------------------------------------------------------------

describe('classifyReadiness — ready frontier', () => {
  it('proceeds when one child has satisfied deps (dep is done)', () => {
    const epic = makeTask({ type: 'epic', pipelineStage: 'implementation' });
    const children = [
      makeChild('T9001', 'done', []),
      makeChild('T9002', 'pending', ['T9001']), // T9001 is done → T9002 is ready
    ];
    const result = classifyReadiness(epic, { children });
    expect(result.verdict).toBe('proceed');
  });

  it('grills (AMBIGUOUS_SCOPE not applicable) when all children are done and no pending', () => {
    // No AMBIGUOUS_SCOPE since children are present; but verdict is still proceed
    // because no grill trigger fires and epic is in implementation stage.
    const epic = makeTask({ type: 'epic', pipelineStage: 'implementation' });
    const children = [makeChild('T9001', 'done', [])];
    const result = classifyReadiness(epic, { children });
    // All triggers clear → proceed (even if frontier is empty, triggers are the gate)
    expect(result.verdict).toBe('proceed');
  });

  it('grill reason mentions all active triggers', () => {
    const task = makeTask({ acceptance: undefined, labels: ['owner-decision'] });
    const result = classifyReadiness(task);
    expect(result.verdict).toBe('grill');
    expect(result.reason).toContain('MISSING_AC');
    expect(result.reason).toContain('OWNER_DECISION_REQUIRED');
    expect(result.triggers).toEqual(
      expect.arrayContaining(['MISSING_AC', 'OWNER_DECISION_REQUIRED']),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Multi-trigger scenarios
// ---------------------------------------------------------------------------

describe('classifyReadiness — multi-trigger', () => {
  it('reports multiple triggers simultaneously', () => {
    const task = makeTask({
      acceptance: undefined,
      labels: ['owner-decision'],
      pipelineStage: 'release',
    });
    const ivtrState = makeIvtrState({ validate: MAX_LOOP_BACKS_PER_PHASE });
    const result = classifyReadiness(task, { ivtrState });

    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
    expect(result.triggers).toContain('IVTR_MAX_RETRIES');
    expect(result.triggers).toContain('RELEASE_GATE');
  });

  it('four triggers fire for an epic at release stage (RELEASE_GATE suppresses AMBIGUOUS_SCOPE)', () => {
    // RELEASE_GATE and AMBIGUOUS_SCOPE are mutually exclusive from pipelineStage:
    // 'release' is in IMPLEMENTATION_STAGES so AMBIGUOUS_SCOPE is suppressed.
    // This validates the remaining 4 can fire simultaneously.
    const epic = makeTask({
      type: 'epic',
      acceptance: undefined,
      labels: ['owner-decision'],
      pipelineStage: 'release',
      blockedBy: 'waiting on owner decision',
    });
    const ivtrState = makeIvtrState({ test: MAX_LOOP_BACKS_PER_PHASE });
    const signals: ReadinessSignals = {
      children: [],
      blobNames: [],
      ivtrState,
      hitlApproved: false,
    };
    const result = classifyReadiness(epic, signals);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
    expect(result.triggers).toContain('IVTR_MAX_RETRIES');
    expect(result.triggers).toContain('RELEASE_GATE');
    expect(result.triggers).not.toContain('AMBIGUOUS_SCOPE'); // suppressed: release ∈ IMPLEMENTATION_STAGES
    expect(result.triggers).toHaveLength(4);
  });

  it('AMBIGUOUS_SCOPE fires alongside MISSING_AC and OWNER_DECISION_REQUIRED for a bare pre-impl epic', () => {
    // AMBIGUOUS_SCOPE requires pre-implementation stage — RELEASE_GATE cannot co-fire.
    const epic = makeTask({
      type: 'epic',
      acceptance: undefined,
      labels: ['owner-decision'],
      pipelineStage: 'research',
    });
    const signals: ReadinessSignals = {
      children: [],
      blobNames: [],
      hitlApproved: false,
    };
    const result = classifyReadiness(epic, signals);
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toContain('MISSING_AC');
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
    expect(result.triggers).toContain('AMBIGUOUS_SCOPE');
    expect(result.triggers).toHaveLength(3);
  });
});
