/**
 * Session Handoff Fix Tests
 *
 * Verifies that sessionHandoff correctly handles:
 * 1. Null return from getLastHandoff (no handoff data — success)
 * 2. CleoError thrown from getLastHandoff (proper error code preserved)
 * 3. Generic errors (wrapped as E_GENERAL)
 * 4. Valid handoff data returned normally
 *
 * T1573 (ENG-MIG-6): sessionHandoff logic now lives in
 * packages/core/src/session/engine-ops.ts and is re-exported via
 * session-engine.ts shim. Mocks target the sessions/handoff.js module
 * where getLastHandoff is defined.
 *
 * @task T5123
 * @task T1573
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock sessions modules before importing session-engine
vi.mock('../../../../../core/src/sessions/handoff.js', () => ({
  computeDebrief: vi.fn(),
  computeHandoff: vi.fn(),
  getLastHandoff: vi.fn(),
  persistHandoff: vi.fn(),
  getHandoff: vi.fn(),
  sessionHandoffShow: vi.fn(),
}));

vi.mock('../../../../../core/src/sessions/index.js', () => ({
  showSession: vi.fn(),
  suspendSession: vi.fn(),
  getSessionHistory: vi.fn(),
  cleanupSessions: vi.fn(),
  getSessionStats: vi.fn(),
  switchSession: vi.fn(),
  archiveSessions: vi.fn(),
  getContextDrift: vi.fn(),
  recordDecision: vi.fn(),
  getDecisionLog: vi.fn(),
  recordAssumption: vi.fn(),
  computeHandoff: vi.fn(),
  persistHandoff: vi.fn(),
  getLastHandoff: vi.fn(),
  computeBriefing: vi.fn(),
  computeDebrief: vi.fn(),
  findSessions: vi.fn(),
  parseScope: vi.fn(),
}));

vi.mock('../../../../../core/src/sessions/session-id.js', () => ({
  generateSessionId: vi.fn(),
}));

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../../../core/src/task-work/index.js', () => ({
  currentTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
  getTaskHistory: vi.fn(),
}));

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '@cleocode/core';
import { getLastHandoff } from '../../../../../core/src/sessions/index.js';
import { sessionHandoff } from '../session-engine.js';

const mockGetLastHandoff = vi.mocked(getLastHandoff);

describe('sessionHandoff (T5123)', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return success with null data when no handoff exists', async () => {
    mockGetLastHandoff.mockResolvedValue(null);

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('should return success with handoff data when it exists', async () => {
    const handoffData = {
      sessionId: 'ses-abc',
      handoff: {
        lastTask: 'T100',
        tasksCompleted: ['T101'],
        tasksCreated: ['T102'],
        decisionsRecorded: 2,
        nextSuggested: ['T103'],
        openBlockers: [],
        openBugs: [],
      },
    };
    mockGetLastHandoff.mockResolvedValue(handoffData);

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(handoffData);
    expect(result.error).toBeUndefined();
  });

  it('should preserve CleoError exit code on throw', async () => {
    mockGetLastHandoff.mockRejectedValue(
      new CleoError(ExitCode.SESSION_NOT_FOUND, 'Session not found'),
    );

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe('Session not found');
  });

  it('should wrap generic errors as E_GENERAL', async () => {
    mockGetLastHandoff.mockRejectedValue(new Error('Database connection lost'));

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe('Database connection lost');
  });

  it('should handle non-Error thrown values', async () => {
    mockGetLastHandoff.mockRejectedValue('unexpected string error');

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe('unexpected string error');
  });

  it('should pass scope filter through to getLastHandoff', async () => {
    mockGetLastHandoff.mockResolvedValue(null);

    const scope = { type: 'epic', epicId: 'T500' };
    await sessionHandoff(projectRoot, scope);

    expect(mockGetLastHandoff).toHaveBeenCalledWith(projectRoot, scope);
  });

  it('should preserve CleoError fix suggestion', async () => {
    const err = new CleoError(ExitCode.SESSION_NOT_FOUND, 'Session not found', {
      fix: 'cleo session list',
    });
    mockGetLastHandoff.mockRejectedValue(err);

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error!.fix).toBe('cleo session list');
  });
});
