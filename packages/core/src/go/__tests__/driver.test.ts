/**
 * Unit tests for the `cleo go` autopilot driver (T11494, repurposed T13821).
 *
 * Tests the outcome branches of {@link cleoGo}:
 * 1. `complete`           — no non-terminal sagas
 * 2. `needsDecomposition` — empty ready frontier + zero descendants
 * 3. `lifecycleHop`       — pre-implementation stage (research/specification/decomposition)
 * 4. `goalHandoff`        — implementation stage: a goal/v1 contract drafted for
 *                           the ready wave, handed to the goal runtime
 *
 * The engines (sagaNext, orchestrateReady), the goal draft and the runtime
 * detection are stubbed, so no DB or filesystem is touched.
 *
 * @task T11494 — E2-CLEO-GO
 * @task T13821 — cleo go hands the ready wave to the goal runtime
 * @saga T11492 — SG-AUTOPILOT
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SagaNextResult } from '../../sagas/next.js';

// ---------------------------------------------------------------------------
// Module mocks — must come before importing the system-under-test
// ---------------------------------------------------------------------------

const mockSagaNext = vi.fn();
const mockOrchestrateReady = vi.fn();
const mockDraftGoal = vi.fn();
const mockRuntime = vi.fn();

/** Injected IVTR runner under test (T11805). */

vi.mock('../../sagas/next.js', () => ({
  sagaNext: (...args: unknown[]) => mockSagaNext(...args),
}));

vi.mock('../../orchestrate/query-ops.js', () => ({
  orchestrateReady: (...args: unknown[]) => mockOrchestrateReady(...args),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: (_p?: string) => _p ?? '/test/root',
}));

vi.mock('../../goal/draft.js', () => ({
  draftGoal: (...args: unknown[]) => mockDraftGoal(...args),
  goalSlug: (ids: readonly string[]) => ids.join('-').toLowerCase(),
}));

vi.mock('../../goal/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../goal/runtime.js')>()),
  detectGoalRuntime: () => mockRuntime(),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

const { cleoGo } = await import('../driver.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SagaNextResult with sensible defaults. */
function makeSagaNextResult(overrides: Partial<SagaNextResult> = {}): SagaNextResult {
  return {
    sagaId: 'T100',
    sagaTitle: 'Test Saga',
    sagaLabel: 'test (parallel)',
    canonicalRank: 0,
    activeSagaCount: 1,
    readyFrontier: [],
    blockers: [],
    total: 1,
    done: 0,
    active: 1,
    blocked: 0,
    pending: 0,
    completionPct: 0,
    memberEpics: [],
    ...overrides,
  };
}

/** Build a minimal orchestrateReady result. */
function makeReadyResult(
  readyTasks: Array<{ id: string; pipelineStage?: string; parentId?: string }> = {},
) {
  return {
    success: true,
    data: { readyTasks: Array.isArray(readyTasks) ? readyTasks : [] },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleoGo driver (T11494)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime.mockReturnValue({
      name: 'opencode-goal',
      installed: true,
      via: 'path',
      next: 'Start the goal with OpenCode-Goal.',
    });
    mockDraftGoal.mockImplementation(async (ids: string[], o: { projectRoot: string }) => ({
      success: true,
      data: {
        slug: ids.join('-').toLowerCase(),
        path: `${o.projectRoot}/.opencode/goals/x/goal.yaml`,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Outcome: complete ---------------------------------------------------

  describe('outcome: complete', () => {
    it('returns complete when sagaNext returns an empty sagaId', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: '', activeSagaCount: 0 }),
      });

      const result = await cleoGo();
      expect(result.success).toBe(true);
      expect(result.data?.outcome.action).toBe('complete');
      // No saga selected → no goal to arm.
    });
  });

  // ---- Outcome: needsDecomposition ----------------------------------------

  describe('outcome: needsDecomposition', () => {
    it('returns needsDecomposition when ready frontier is empty and no descendants', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'AC-only epic',
              status: 'pending',
              descendantTaskCount: 0,
              descendantDone: 0,
              descendantActive: 0,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(makeReadyResult([]));

      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('needsDecomposition');
      if (outcome?.action === 'needsDecomposition') {
        expect(outcome.sagaId).toBe('T100');
        expect(outcome.epicId).toBe('T101');
      }
    });
  });

  // ---- Outcome: lifecycleHop -----------------------------------------------

  describe('outcome: lifecycleHop', () => {
    it.each([
      ['research', 'research'],
      ['specification', 'specification'],
      ['decomposition', 'decomposition'],
    ] as const)('returns lifecycleHop when pipelineStage is %s', async (_label, stage) => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Pre-impl epic',
              status: 'active',
              descendantTaskCount: 3,
              descendantDone: 0,
              descendantActive: 3,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([{ id: 'T102', pipelineStage: stage, parentId: 'T101' }]),
      );

      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('lifecycleHop');
      if (outcome?.action === 'lifecycleHop') {
        expect(outcome.currentStage).toBe(stage);
        expect(outcome.sagaId).toBe('T100');
      }
    });
  });

  // ---- Outcome: goalHandoff ----------------------------------------------

  describe('outcome: goalHandoff (T13821)', () => {
    const implementation = () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: 'T100' }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([
          { id: 'T201', pipelineStage: 'implementation', parentId: 'E1' },
          { id: 'T202', pipelineStage: 'implementation', parentId: 'E1' },
        ]),
      );
    };

    it('drafts a goal for the ready wave and names the /goal start step', async () => {
      implementation();
      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome).toMatchObject({
        action: 'goalHandoff',
        tasks: ['T201', 'T202'],
        goal: { slug: 't201-t202', reused: false },
        runtime: { installed: true, next: 'In OpenCode, run: /goal start t201-t202' },
      });
      expect(mockDraftGoal).toHaveBeenCalledWith(['T201', 'T202'], expect.objectContaining({}));
    });

    it('explains how to install OpenCode-Goal when it is missing', async () => {
      implementation();
      mockRuntime.mockReturnValue({
        name: 'opencode-goal',
        installed: false,
        install: [
          'opencode plugin add "github:kryptobaseddev/opencode-goal#v0.5.1"',
          'opencode reload',
        ],
        next: 'OpenCode-Goal is not installed. install it with: opencode plugin add …',
      });
      const result = await cleoGo({ sagaId: 'T100' });
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('goalHandoff');
      if (outcome?.action !== 'goalHandoff') throw new Error('expected goalHandoff');
      expect(outcome.runtime.installed).toBe(false);
      expect(outcome.runtime.install?.[0]).toContain('opencode plugin add');
      expect(outcome.runtime.next).toMatch(
        /not installed.*then in OpenCode run: \/goal start t201-t202/,
      );
    });

    it('a failed draft is reported, never thrown', async () => {
      implementation();
      mockDraftGoal.mockResolvedValue({ success: false, error: { code: 'E_X', message: 'nope' } });
      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome).toMatchObject({ action: 'goalHandoff', goal: null });
      expect(result.data?.diagnostics.join(' ')).toMatch(/goal draft failed/);
    });
  });

  describe('error propagation', () => {
    it('surfaces sagaNext failure as EngineFailure', async () => {
      mockSagaNext.mockResolvedValue({
        success: false,
        error: { code: 'E_GENERAL', message: 'sagaNext exploded' },
      });

      const result = await cleoGo();
      expect(result.success).toBe(false);
    });

    it('surfaces orchestrateReady failure as EngineFailure', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: 'T100' }),
      });
      mockOrchestrateReady.mockResolvedValue({
        success: false,
        error: { code: 'E_NOT_FOUND', message: 'epic T100 not found' },
      });

      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(false);
    });
  });

  // ---- T13797: cleo go arms no goal loop (OCG is the goal runtime) ------

  describe('T13797: no goal loop arming', () => {
    it('drives a saga without arming a goal record', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: 'T100', sagaTitle: 'My Saga' }),
      });
      mockOrchestrateReady.mockResolvedValue(makeReadyResult([]));

      const result = await cleoGo({ sagaId: 'T100' });

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('armedGoalId');
      expect(result.data?.diagnostics.some((d) => d.includes('goal loop'))).toBe(false);
    });
  });

  // ---- AC2: one envelope per call -----------------------------------------

  describe('AC2: ONE LAFS envelope per call', () => {
    it('always returns exactly one EngineResult', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: '' }),
      });

      const result = await cleoGo();
      // Shape check: has success + data (or error)
      expect(typeof result.success).toBe('boolean');
      if (result.success) {
        expect(result.data).toBeDefined();
        expect(result.data?.outcome).toBeDefined();
        expect(Array.isArray(result.data?.diagnostics)).toBe(true);
      }
    });
  });
});
