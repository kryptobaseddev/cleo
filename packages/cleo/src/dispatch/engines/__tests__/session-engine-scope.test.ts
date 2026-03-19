/**
 * Session Engine Scope Tests
 *
 * Verifies:
 * 1. Does not auto-end active session when scope is invalid
 * 2. Starts session with global scope
 * 3. Starts session with epic:T### scope
 *
 * @task T5240
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadSessions = vi.fn<() => Promise<Session[]>>();
const mockSaveSessions = vi.fn<(sessions: Session[]) => Promise<void>>();
const mockGetMetaValue = vi.fn();
const mockSetMetaValue = vi.fn().mockResolvedValue(undefined);
const mockLoadSingleTask = vi.fn();

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockImplementation(() =>
    Promise.resolve({
      loadSessions: mockLoadSessions,
      saveSessions: mockSaveSessions,
      getMetaValue: mockGetMetaValue,
      setMetaValue: mockSetMetaValue,
      loadSingleTask: mockLoadSingleTask,
    }),
  ),
}));

vi.mock('../../../../../core/src/sessions/index.js', () => ({
  parseScope: vi.fn().mockImplementation((scopeStr: string) => {
    if (scopeStr === 'global') return { type: 'global' };
    const match = scopeStr.match(/^epic:(T\d+)$/);
    if (match) return { type: 'epic', epicId: match[1], rootTaskId: match[1] };
    throw new Error(`Invalid scope format: ${scopeStr}. Use 'epic:T###' or 'global'.`);
  }),
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

vi.mock('../../../../../core/src/sessions/handoff.js', () => ({
  computeDebrief: vi.fn(),
}));

vi.mock('../../../../../core/src/sessions/session-id.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('ses-test-scope-001'),
}));

vi.mock('../../../../../core/src/task-work/index.js', () => ({
  currentTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
  getTaskHistory: vi.fn(),
}));

import { sessionStart } from '../session-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up meta value mocks for a given activeSession value. */
function setupMetaMocks(activeSession: string | null = null) {
  mockGetMetaValue.mockImplementation((key: string) => {
    if (key === 'file_meta') return Promise.resolve({ activeSession, checksum: 'abc', generation: 1 });
    if (key === 'focus_state') return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

const PROJECT_ROOT = '/mock/project';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Engine Scope (T5240)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSessions.mockResolvedValue([]);
    mockSaveSessions.mockResolvedValue(undefined);
    mockSetMetaValue.mockResolvedValue(undefined);
    mockLoadSingleTask.mockResolvedValue(null);
  });

  it('does not auto-end active session when scope is invalid', async () => {
    // Set up an active session
    setupMetaMocks('ses-existing');

    const result = await sessionStart(PROJECT_ROOT, { scope: 'invalid-scope' });

    // Should fail without auto-ending the active session
    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('Invalid scope format');
    // saveSessions should NOT have been called (no auto-end happened)
    expect(mockSaveSessions).not.toHaveBeenCalled();
  });

  it('starts session with global scope', async () => {
    setupMetaMocks(null);

    const result = await sessionStart(PROJECT_ROOT, { scope: 'global' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scope).toEqual({ type: 'global' });
    expect(result.data!.id).toBe('ses-test-scope-001');
  });

  it('starts session with epic:T### scope', async () => {
    setupMetaMocks(null);
    mockLoadSingleTask.mockResolvedValue({ id: 'T001', title: 'Epic task', status: 'active' });

    const result = await sessionStart(PROJECT_ROOT, { scope: 'epic:T001' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scope.type).toBe('epic');
    expect(result.data!.scope.rootTaskId).toBe('T001');
  });

  it('rejects epic scope when root task does not exist', async () => {
    setupMetaMocks(null);
    // T999 does not exist — loadSingleTask returns null
    mockLoadSingleTask.mockResolvedValue(null);

    const result = await sessionStart(PROJECT_ROOT, { scope: 'epic:T999' });

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('not found');
  });
});
