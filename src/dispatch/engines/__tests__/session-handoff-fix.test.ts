/**
 * Session Handoff Fix Tests
 *
 * Verifies that sessionHandoff correctly handles:
 * 1. Null return from getLastHandoff (no handoff data — success)
 * 2. CleoError thrown from getLastHandoff (proper error code preserved)
 * 3. Generic errors (wrapped as E_GENERAL)
 * 4. Valid handoff data returned normally
 *
 * @task T5123
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core modules before importing session-engine
vi.mock('../../../core/sessions/index.js', () => ({
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
  findSessions: vi.fn(),
}));

vi.mock('../../../core/sessions/handoff.js', () => ({
  computeDebrief: vi.fn(),
}));

vi.mock('../../../core/sessions/session-id.js', () => ({
  generateSessionId: vi.fn(),
}));

vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../core/task-work/index.js', () => ({
  currentTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
}));

import { sessionHandoff } from '../session-engine.js';
import { getLastHandoff } from '../../../core/sessions/index.js';
import { CleoError } from '../../../core/errors.js';
import { ExitCode } from '../../../types/exit-codes.js';

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
    expect(result.error!.code).toBe('E_SESSION_NOT_FOUND');
    expect(result.error!.message).toBe('Session not found');
  });

  it('should wrap generic errors as E_GENERAL', async () => {
    mockGetLastHandoff.mockRejectedValue(new Error('Database connection lost'));

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('E_GENERAL');
    expect(result.error!.message).toBe('Database connection lost');
  });

  it('should handle non-Error thrown values', async () => {
    mockGetLastHandoff.mockRejectedValue('unexpected string error');

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('E_GENERAL');
    expect(result.error!.message).toBe('unexpected string error');
  });

  it('should pass scope filter through to getLastHandoff', async () => {
    mockGetLastHandoff.mockResolvedValue(null);

    const scope = { type: 'epic', epicId: 'T500' };
    await sessionHandoff(projectRoot, scope);

    expect(mockGetLastHandoff).toHaveBeenCalledWith(projectRoot, scope);
  });

  it('should preserve CleoError fix suggestion', async () => {
    const err = new CleoError(ExitCode.SESSION_NOT_FOUND, 'Session not found');
    err.fix = 'cleo session list';
    mockGetLastHandoff.mockRejectedValue(err);

    const result = await sessionHandoff(projectRoot);

    expect(result.success).toBe(false);
    expect(result.error!.fix).toBe('cleo session list');
  });
});
