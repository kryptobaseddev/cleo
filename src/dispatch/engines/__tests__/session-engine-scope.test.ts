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
import type { Session } from '../../../types/session.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadSessions = vi.fn<() => Promise<Session[]>>();
const mockSaveSessions = vi.fn<(sessions: Session[]) => Promise<void>>();
const mockLoadTaskFile = vi.fn();
const mockSaveTaskFile = vi.fn();

vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockImplementation(() =>
    Promise.resolve({
      loadSessions: mockLoadSessions,
      saveSessions: mockSaveSessions,
      loadTaskFile: mockLoadTaskFile,
      saveTaskFile: mockSaveTaskFile,
    }),
  ),
}));

vi.mock('../../../core/sessions/index.js', () => ({
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

vi.mock('../../../core/sessions/handoff.js', () => ({
  computeDebrief: vi.fn(),
}));

vi.mock('../../../core/sessions/session-id.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('ses-test-scope-001'),
}));

vi.mock('../../../core/task-work/index.js', () => ({
  currentTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
  getTaskHistory: vi.fn(),
}));

import { sessionStart } from '../session-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskFile(tasks: Array<{ id: string; title: string; status: string }>) {
  return {
    tasks,
    _meta: {
      activeSession: null,
      checksum: 'abc',
      generation: 1,
    },
    focus: null,
    lastUpdated: new Date().toISOString(),
  };
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
    mockSaveTaskFile.mockResolvedValue(undefined);
  });

  it('does not auto-end active session when scope is invalid', async () => {
    // Set up an active session
    mockLoadTaskFile.mockResolvedValue({
      tasks: [{ id: 'T001', title: 'Test', status: 'active' }],
      _meta: { activeSession: 'ses-existing', checksum: 'abc', generation: 1 },
      focus: null,
      lastUpdated: new Date().toISOString(),
    });

    const result = await sessionStart(PROJECT_ROOT, { scope: 'invalid-scope' });

    // Should fail without auto-ending the active session
    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('Invalid scope format');
    // saveSessions should NOT have been called (no auto-end happened)
    expect(mockSaveSessions).not.toHaveBeenCalled();
  });

  it('starts session with global scope', async () => {
    mockLoadTaskFile.mockResolvedValue(
      makeTaskFile([{ id: 'T001', title: 'Test task', status: 'pending' }]),
    );

    const result = await sessionStart(PROJECT_ROOT, { scope: 'global' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scope).toEqual({ type: 'global' });
    expect(result.data!.id).toBe('ses-test-scope-001');
  });

  it('starts session with epic:T### scope', async () => {
    mockLoadTaskFile.mockResolvedValue(
      makeTaskFile([{ id: 'T001', title: 'Epic task', status: 'active' }]),
    );

    const result = await sessionStart(PROJECT_ROOT, { scope: 'epic:T001' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.scope.type).toBe('epic');
    expect(result.data!.scope.rootTaskId).toBe('T001');
  });

  it('rejects epic scope when root task does not exist', async () => {
    mockLoadTaskFile.mockResolvedValue(
      makeTaskFile([{ id: 'T001', title: 'Test', status: 'pending' }]),
    );

    const result = await sessionStart(PROJECT_ROOT, { scope: 'epic:T999' });

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('not found');
  });
});
