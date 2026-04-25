/**
 * Tests for the ReleaseHandler dispatch domain.
 *
 * Covers RELEASE-03 (release.gate IVTR check) and RELEASE-07
 * (release.ivtr-suggest auto-suggest) acceptance criteria.
 *
 * @task T820 RELEASE-03
 * @task T820 RELEASE-07
 * @task T1416
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that touch the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../lib/engine.js', () => ({
  releaseGateCheck: vi.fn(),
  releaseIvtrAutoSuggest: vi.fn(),
}));

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { releaseGateCheck, releaseIvtrAutoSuggest } from '../../lib/engine.js';
import { ReleaseHandler } from '../release.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EPIC_ID = 'T900';
const TASK_ID = 'T901';

/** A gate-passed result with all tasks released. */
const gatePassedResult = {
  success: true,
  data: {
    epicId: EPIC_ID,
    passed: true,
    forcedBypass: false,
    blocked: [],
    unchecked: [],
    tasks: [{ taskId: TASK_ID, currentPhase: 'released', blocking: false }],
    summary: `IVTR gate passed for epic ${EPIC_ID}. All 1 task(s) are in released phase.`,
  },
};

/** A gate-failed result with one blocked task. */
const gateFailedResult = {
  success: false,
  error: {
    code: 'E_IVTR_INCOMPLETE',
    message: `IVTR gate FAILED for epic ${EPIC_ID}. 1 task(s) not yet released: ${TASK_ID}.`,
    exitCode: 83,
    fix: `cleo orchestrate ivtr ${TASK_ID} --release`,
    details: {
      blocked: [TASK_ID],
      unchecked: [],
      epicId: EPIC_ID,
      tasks: [{ taskId: TASK_ID, currentPhase: 'test', blocking: true }],
    },
  },
};

/** A gate bypassed result (--force). */
const gateForcedResult = {
  success: true,
  data: {
    epicId: EPIC_ID,
    passed: true,
    forcedBypass: true,
    blocked: [],
    unchecked: [],
    tasks: [],
    summary: `IVTR gate check BYPASSED via --force for epic ${EPIC_ID}.`,
  },
};

/** IVTR auto-suggest — epic fully released. */
const autoSuggestFullResult = {
  success: true,
  data: {
    taskId: TASK_ID,
    epicId: EPIC_ID,
    epicFullyReleased: true,
    suggestedCommand: `cleo release ship <version> --epic ${EPIC_ID}`,
    message: `All tasks in epic ${EPIC_ID} have reached IVTR released phase.`,
  },
};

/** IVTR auto-suggest — some siblings still pending. */
const autoSuggestPartialResult = {
  success: true,
  data: {
    taskId: TASK_ID,
    epicId: EPIC_ID,
    epicFullyReleased: false,
    suggestedCommand: null,
    message: `Task ${TASK_ID} released. 1 sibling task(s) in epic ${EPIC_ID} still pending.`,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReleaseHandler', () => {
  let handler: ReleaseHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReleaseHandler();
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  it('declares expected query and mutate operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('gate');
    expect(ops.query).toContain('ivtr-suggest');
    expect(ops.mutate).toContain('gate');
    expect(ops.mutate).toContain('ivtr-suggest');
  });

  // -----------------------------------------------------------------------
  // query('gate') — RELEASE-03
  // -----------------------------------------------------------------------

  describe('query("gate")', () => {
    it('returns E_INVALID_INPUT when epicId is missing', async () => {
      const result = await handler.query('gate', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns gate-passed result when all tasks are released', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gatePassedResult);

      const result = await handler.query('gate', { epicId: EPIC_ID });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['passed']).toBe(true);
      expect((result.data as Record<string, unknown>)['epicId']).toBe(EPIC_ID);
      expect((result.data as Record<string, unknown>)['blocked']).toEqual([]);
      expect(releaseGateCheck).toHaveBeenCalledWith(EPIC_ID, false, '/mock/project');
    });

    it('propagates gate-failed result with E_IVTR_INCOMPLETE', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gateFailedResult);

      const result = await handler.query('gate', { epicId: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_IVTR_INCOMPLETE');
      expect(result.error?.fix).toBe(`cleo orchestrate ivtr ${TASK_ID} --release`);
    });

    it('passes force=true when params.force is true', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gateForcedResult);

      const result = await handler.query('gate', { epicId: EPIC_ID, force: true });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['forcedBypass']).toBe(true);
      expect(releaseGateCheck).toHaveBeenCalledWith(EPIC_ID, true, '/mock/project');
    });

    it('meta envelope identifies domain=release and operation=gate', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gatePassedResult);

      const result = await handler.query('gate', { epicId: EPIC_ID });
      expect(result.meta.domain).toBe('release');
      expect(result.meta.operation).toBe('gate');
      expect(result.meta.gateway).toBe('query');
    });

    it('returns E_INVALID_OPERATION for unknown query operations', async () => {
      const result = await handler.query('nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // -----------------------------------------------------------------------
  // query('ivtr-suggest') — RELEASE-07
  // -----------------------------------------------------------------------

  describe('query("ivtr-suggest")', () => {
    it('returns E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.query('ivtr-suggest', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns suggest result when epic is fully released', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockResolvedValue(autoSuggestFullResult);

      const result = await handler.query('ivtr-suggest', { taskId: TASK_ID });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['epicFullyReleased']).toBe(true);
      expect(data['suggestedCommand']).toMatch(/cleo release ship/);
      expect(releaseIvtrAutoSuggest).toHaveBeenCalledWith(TASK_ID, '/mock/project');
    });

    it('returns suggest result when epic is partially released', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockResolvedValue(autoSuggestPartialResult);

      const result = await handler.query('ivtr-suggest', { taskId: TASK_ID });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['epicFullyReleased']).toBe(false);
      expect(data['suggestedCommand']).toBeNull();
    });

    it('meta envelope identifies domain=release and operation=ivtr-suggest', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockResolvedValue(autoSuggestPartialResult);

      const result = await handler.query('ivtr-suggest', { taskId: TASK_ID });
      expect(result.meta.domain).toBe('release');
      expect(result.meta.operation).toBe('ivtr-suggest');
    });
  });

  // -----------------------------------------------------------------------
  // mutate('gate') — RELEASE-03 (mutate gateway)
  // -----------------------------------------------------------------------

  describe('mutate("gate")', () => {
    it('returns E_INVALID_INPUT when epicId is missing', async () => {
      const result = await handler.mutate('gate', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('delegates to releaseGateCheck and returns result', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gatePassedResult);

      const result = await handler.mutate('gate', { epicId: EPIC_ID });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['passed']).toBe(true);
      expect(releaseGateCheck).toHaveBeenCalledWith(EPIC_ID, false, '/mock/project');
    });

    it('honours force flag through mutate gateway', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gateForcedResult);

      const result = await handler.mutate('gate', { epicId: EPIC_ID, force: true });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['forcedBypass']).toBe(true);
      expect(releaseGateCheck).toHaveBeenCalledWith(EPIC_ID, true, '/mock/project');
    });

    it('meta gateway is mutate', async () => {
      vi.mocked(releaseGateCheck).mockResolvedValue(gatePassedResult);

      const result = await handler.mutate('gate', { epicId: EPIC_ID });
      expect(result.meta.gateway).toBe('mutate');
    });

    it('returns E_INVALID_OPERATION for unknown mutate operations', async () => {
      const result = await handler.mutate('ship', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  // -----------------------------------------------------------------------
  // mutate('ivtr-suggest') — RELEASE-07 (mutate gateway)
  // -----------------------------------------------------------------------

  describe('mutate("ivtr-suggest")', () => {
    it('returns E_INVALID_INPUT when taskId is missing', async () => {
      const result = await handler.mutate('ivtr-suggest', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns suggest result on success', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockResolvedValue(autoSuggestFullResult);

      const result = await handler.mutate('ivtr-suggest', { taskId: TASK_ID });
      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data['epicFullyReleased']).toBe(true);
      expect(releaseIvtrAutoSuggest).toHaveBeenCalledWith(TASK_ID, '/mock/project');
    });

    it('meta gateway is mutate', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockResolvedValue(autoSuggestPartialResult);

      const result = await handler.mutate('ivtr-suggest', { taskId: TASK_ID });
      expect(result.meta.gateway).toBe('mutate');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling — engine throws
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('handles unexpected engine error in query("gate") gracefully', async () => {
      vi.mocked(releaseGateCheck).mockRejectedValue(new Error('DB connection lost'));

      const result = await handler.query('gate', { epicId: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });

    it('handles unexpected engine error in query("ivtr-suggest") gracefully', async () => {
      vi.mocked(releaseIvtrAutoSuggest).mockRejectedValue(new Error('Unexpected failure'));

      const result = await handler.query('ivtr-suggest', { taskId: TASK_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });

    it('handles unexpected engine error in mutate("gate") gracefully', async () => {
      vi.mocked(releaseGateCheck).mockRejectedValue(new Error('Timeout'));

      const result = await handler.mutate('gate', { epicId: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });
  });
});
