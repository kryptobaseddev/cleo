/**
 * Unit tests for the `cleo go` autopilot driver (T11494).
 *
 * Tests the four outcome branches of {@link cleoGo}:
 * 1. `complete`           — no non-terminal sagas
 * 2. `needsDecomposition` — empty ready frontier + zero descendants
 * 3. `lifecycleHop`       — pre-implementation stage (research/specification/decomposition)
 * 4. `ivtrFanOut`         — implementation stage, IVTR fan-out
 *
 * The test stubs out the imported engines (sagaNext, orchestrateReady,
 * armGoalLoop) so no DB or filesystem is touched. The IVTR seam (T11805) is now
 * an *injected* runner — `cleoGo` no longer imports `startIvtr` — so the fan-out
 * scenarios pass a mock {@link go.IvtrRunner} via `params.ivtrRunner`.
 *
 * @task T11494 — E2-CLEO-GO
 * @task T11805 — IVTR seam: injected `executePlaybook(ivtr.cantbook)` runner
 * @saga T11492 — SG-AUTOPILOT
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SagaNextResult } from '../../sagas/next.js';
import type { IvtrRunner } from '../driver.js';

// ---------------------------------------------------------------------------
// Module mocks — must come before importing the system-under-test
// ---------------------------------------------------------------------------

const mockSagaNext = vi.fn();
const mockOrchestrateReady = vi.fn();
const mockIvtrRunner = vi.fn();
const mockArmGoalLoop = vi.fn();
const mockStartIvtr = vi.fn();

/** Injected IVTR runner under test (T11805). */
const ivtrRunner: IvtrRunner = (...args) => mockIvtrRunner(...args);

vi.mock('../../sagas/next.js', () => ({
  sagaNext: (...args: unknown[]) => mockSagaNext(...args),
}));

vi.mock('../../orchestrate/query-ops.js', () => ({
  orchestrateReady: (...args: unknown[]) => mockOrchestrateReady(...args),
}));

vi.mock('../../goal/arm.js', () => ({
  armGoalLoop: (...args: unknown[]) => mockArmGoalLoop(...args),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: (_p?: string) => _p ?? '/test/root',
}));

// T11805 — the driver now imports `startIvtr` for the flag-OFF fallback path
// (Risk #1 mitigation). Stub it so the fallback never touches a real DB.
vi.mock('../../lifecycle/ivtr-loop.js', () => ({
  startIvtr: (...args: unknown[]) => mockStartIvtr(...args),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

const { cleoGo, CLEO_GO_VIA_PLAYBOOK_ENV } = await import('../driver.js');

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
    mockIvtrRunner.mockResolvedValue({ taskId: 'T999', runId: 'pbr_999' });
    mockArmGoalLoop.mockResolvedValue({ id: 'g-armed-1', status: 'active' });
    mockStartIvtr.mockResolvedValue({ taskId: 'T999', currentPhase: 'implement' });
    // The cantbook seam defaults ON (T11896) — leaving the env unset already
    // exercises the seam path. We clear it here so the default-ON behaviour is
    // what the fan-out tests assert; the dedicated kill-switch test below sets
    // `CLEO_GO_VIA_PLAYBOOK=0` explicitly to exercise the legacy fallback.
    delete process.env[CLEO_GO_VIA_PLAYBOOK_ENV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[CLEO_GO_VIA_PLAYBOOK_ENV];
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
      expect(result.data?.armedGoalId).toBeNull();
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

  // ---- Outcome: ivtrFanOut ------------------------------------------------

  describe('outcome: ivtrFanOut', () => {
    it('returns ivtrFanOut and drives each ready task through the injected IVTR runner', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 2,
              descendantDone: 0,
              descendantActive: 2,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([
          { id: 'T102', pipelineStage: 'implementation', parentId: 'T101' },
          { id: 'T103', pipelineStage: 'implementation', parentId: 'T101' },
        ]),
      );
      mockIvtrRunner
        .mockResolvedValueOnce({ taskId: 'T102', runId: 'pbr_102', terminalStatus: 'completed' })
        .mockResolvedValueOnce({ taskId: 'T103', runId: 'pbr_103', terminalStatus: 'completed' });

      const result = await cleoGo({ sagaId: 'T100', ivtrRunner });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('ivtrFanOut');
      if (outcome?.action === 'ivtrFanOut') {
        expect(outcome.tasks).toEqual(['T102', 'T103']);
        expect(outcome.runIds).toEqual(['pbr_102', 'pbr_103']);
        expect(outcome.currentStage).toBe('implementation');
      }
      expect(mockIvtrRunner).toHaveBeenCalledTimes(2);
      // AC2: runner receives taskId + the run options (projectRoot, epicId).
      expect(mockIvtrRunner.mock.calls[0]?.[0]).toBe('T102');
      expect(mockIvtrRunner.mock.calls[0]?.[1]).toMatchObject({ epicId: 'T101' });
    });

    it('forwards the sessionId to the IVTR runner (evidence/provenance gate param)', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 1,
              descendantDone: 0,
              descendantActive: 1,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([{ id: 'T102', pipelineStage: 'implementation', parentId: 'T101' }]),
      );
      mockIvtrRunner.mockResolvedValueOnce({ taskId: 'T102', runId: 'pbr_102' });

      const result = await cleoGo({ sagaId: 'T100', ivtrRunner, sessionId: 'ses_abc' });
      expect(result.success).toBe(true);
      expect(mockIvtrRunner.mock.calls[0]?.[1]).toMatchObject({
        epicId: 'T101',
        sessionId: 'ses_abc',
      });
    });

    it('falls back to startIvtr when no runner is injected (no silent skip)', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 1,
              descendantDone: 0,
              descendantActive: 1,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([{ id: 'T102', pipelineStage: 'implementation', parentId: 'T101' }]),
      );

      // Flag ON but no runner → fallback to startIvtr (no silent skip).
      const result = await cleoGo({ sagaId: 'T100' });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('ivtrFanOut');
      if (outcome?.action === 'ivtrFanOut') {
        // Fallback path seeds via startIvtr — the task IS surfaced.
        expect(outcome.tasks).toEqual(['T102']);
        expect(outcome.runIds).toEqual([]);
      }
      expect(mockStartIvtr).toHaveBeenCalledTimes(1);
      expect(mockStartIvtr.mock.calls[0]?.[0]).toBe('T102');
      expect(mockIvtrRunner).not.toHaveBeenCalled();
      expect(result.data?.diagnostics.some((d) => d.includes('runner not provided'))).toBe(true);
    });

    // ---- Risk #1 mitigation: feature flag gates the cantbook seam ----------

    it('kill-switch CLEO_GO_VIA_PLAYBOOK=0: falls back to startIvtr even when a runner IS injected', async () => {
      // T11896 — the seam defaults ON; the explicit `=0` kill-switch restores
      // the legacy startIvtr seed for one deprecation cycle.
      process.env[CLEO_GO_VIA_PLAYBOOK_ENV] = '0';
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 2,
              descendantDone: 0,
              descendantActive: 2,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([
          { id: 'T102', pipelineStage: 'implementation', parentId: 'T101' },
          { id: 'T103', pipelineStage: 'implementation', parentId: 'T101' },
        ]),
      );

      const result = await cleoGo({ sagaId: 'T100', ivtrRunner });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('ivtrFanOut');
      if (outcome?.action === 'ivtrFanOut') {
        expect(outcome.tasks).toEqual(['T102', 'T103']);
        expect(outcome.runIds).toEqual([]);
      }
      // The injected cantbook runner is NOT called when the flag is OFF.
      expect(mockIvtrRunner).not.toHaveBeenCalled();
      expect(mockStartIvtr).toHaveBeenCalledTimes(2);
      expect(result.data?.diagnostics.some((d) => d.includes('seam disabled'))).toBe(true);
    });

    it('flag ON: drives the injected cantbook runner instead of startIvtr', async () => {
      process.env[CLEO_GO_VIA_PLAYBOOK_ENV] = 'true';
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 1,
              descendantDone: 0,
              descendantActive: 1,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([{ id: 'T102', pipelineStage: 'implementation', parentId: 'T101' }]),
      );
      mockIvtrRunner.mockResolvedValueOnce({
        taskId: 'T102',
        runId: 'pbr_102',
        terminalStatus: 'completed',
      });

      const result = await cleoGo({ sagaId: 'T100', ivtrRunner });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      if (outcome?.action === 'ivtrFanOut') {
        expect(outcome.tasks).toEqual(['T102']);
        expect(outcome.runIds).toEqual(['pbr_102']);
      }
      expect(mockIvtrRunner).toHaveBeenCalledTimes(1);
      expect(mockStartIvtr).not.toHaveBeenCalled();
    });

    it('gracefully handles IVTR start failures and reports in diagnostics', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({
          sagaId: 'T100',
          memberEpics: [
            {
              id: 'T101',
              title: 'Implementation epic',
              status: 'active',
              descendantTaskCount: 2,
              descendantDone: 0,
              descendantActive: 2,
              descendantBlocked: 0,
              descendantPending: 0,
              descendantCompletionPct: 0,
            },
          ],
        }),
      });
      mockOrchestrateReady.mockResolvedValue(
        makeReadyResult([
          { id: 'T102', pipelineStage: 'implementation', parentId: 'T101' },
          { id: 'T103', pipelineStage: 'implementation', parentId: 'T101' },
        ]),
      );
      mockIvtrRunner
        .mockResolvedValueOnce({ taskId: 'T102', runId: 'pbr_102' })
        .mockRejectedValueOnce(new Error('E_IVTR_LOCKED'));

      const result = await cleoGo({ sagaId: 'T100', ivtrRunner });
      expect(result.success).toBe(true);
      const outcome = result.data?.outcome;
      expect(outcome?.action).toBe('ivtrFanOut');
      if (outcome?.action === 'ivtrFanOut') {
        // Only T102 succeeded
        expect(outcome.tasks).toEqual(['T102']);
        expect(outcome.runIds).toEqual(['pbr_102']);
      }
      // T103 failure is in diagnostics
      expect(result.data?.diagnostics.some((d) => d.includes('T103'))).toBe(true);
    });
  });

  // ---- Error propagation --------------------------------------------------

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

  // ---- AC3: goal loop armed when a saga is selected ----------------------

  describe('AC3: goal loop armed (T11496)', () => {
    it('calls armGoalLoop with the selected sagaId', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: 'T100', sagaTitle: 'My Saga' }),
      });
      mockOrchestrateReady.mockResolvedValue(makeReadyResult([]));
      mockArmGoalLoop.mockResolvedValue({ id: 'g-armed-saga', status: 'active' });

      const result = await cleoGo({ sagaId: 'T100' });

      expect(mockArmGoalLoop).toHaveBeenCalledOnce();
      expect(mockArmGoalLoop.mock.calls[0]?.[0]).toMatchObject({ sagaId: 'T100' });
      expect(result.data?.armedGoalId).toBe('g-armed-saga');
    });

    it('returns armedGoalId: null for the complete action', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: '', activeSagaCount: 0 }),
      });

      const result = await cleoGo();
      expect(mockArmGoalLoop).not.toHaveBeenCalled();
      expect(result.data?.armedGoalId).toBeNull();
    });

    it('is non-fatal: returns a result even when armGoalLoop throws', async () => {
      mockSagaNext.mockResolvedValue({
        success: true,
        data: makeSagaNextResult({ sagaId: 'T100' }),
      });
      mockOrchestrateReady.mockResolvedValue(makeReadyResult([]));
      mockArmGoalLoop.mockRejectedValue(new Error('DB locked'));

      const result = await cleoGo({ sagaId: 'T100' });

      // Driver must not fail — armedGoalId stays null when arm fails.
      expect(result.success).toBe(true);
      expect(result.data?.armedGoalId).toBeNull();
      expect(result.data?.diagnostics.some((d) => d.includes('non-fatal'))).toBe(true);
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
