/**
 * Per-agent session model tests (T9975).
 *
 * Verifies:
 * 1. session start --agent <handle> tags session row with agentHandle
 * 2. Conflict check is scoped per agent handle (multi-agent parallelism)
 * 3. resolveSessionIdFromEnv() env-precedence: CLEO_SESSION_ID → CLAUDE_SESSION_ID → AIDER_SESSION_ID
 * 4. sessionAdopt returns exportCommand for env rebind
 * 5. Session list params include `all` flag
 *
 * @task T9975
 * @epic T9964
 */

import type { Session } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadSessions = vi.fn<() => Promise<Session[]>>();
const mockUpsertSingleSession = vi.fn<(session: Session) => Promise<void>>();
const mockRemoveSingleSession = vi.fn<(id: string) => Promise<void>>();
const mockGetActiveSession = vi.fn<() => Promise<Session | null>>();
const mockGetMetaValue = vi.fn();
const mockSetMetaValue = vi.fn().mockResolvedValue(undefined);
const mockLoadSingleTask = vi.fn();

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn().mockImplementation(() =>
    Promise.resolve({
      loadSessions: mockLoadSessions,
      upsertSingleSession: mockUpsertSingleSession,
      removeSingleSession: mockRemoveSingleSession,
      getActiveSession: mockGetActiveSession,
      getMetaValue: mockGetMetaValue,
      setMetaValue: mockSetMetaValue,
      loadSingleTask: mockLoadSingleTask,
    }),
  ),
}));

// Stub out all side-effect imports that aren't under test
vi.mock('../../hooks/registry.js', () => ({
  hooks: {
    dispatch: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
  },
}));
vi.mock('../../hooks/handlers/index.js', () => ({}));
vi.mock('../session-journal.js', () => ({
  appendSessionJournalEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../metrics/provider-detection.js', () => ({
  detectRuntimeProviderContext: vi.fn().mockReturnValue({ runtimeProviderId: null }),
}));
vi.mock('../../memory/memory-bridge.js', () => ({
  refreshMemoryBridge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../agent-session-adapter.js', () => ({
  openAgentSession: vi.fn().mockResolvedValue(null),
  closeAgentSession: vi.fn().mockResolvedValue(undefined),
  wrapWithAgentSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Session fixture.
 */
function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: `session-${id}`,
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveSessionIdFromEnv
// ---------------------------------------------------------------------------

describe('resolveSessionIdFromEnv', () => {
  afterEach(() => {
    delete process.env['CLEO_SESSION_ID'];
    delete process.env['CLAUDE_SESSION_ID'];
    delete process.env['AIDER_SESSION_ID'];
  });

  it('returns null when no session env vars are set', async () => {
    const { resolveSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveSessionIdFromEnv()).toBeNull();
  });

  it('prefers CLEO_SESSION_ID over CLAUDE_SESSION_ID', async () => {
    process.env['CLEO_SESSION_ID'] = 'ses-cleo-001';
    process.env['CLAUDE_SESSION_ID'] = 'ses-claude-001';
    const { resolveSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveSessionIdFromEnv()).toBe('ses-cleo-001');
  });

  it('falls back to CLAUDE_SESSION_ID when CLEO_SESSION_ID is unset', async () => {
    process.env['CLAUDE_SESSION_ID'] = 'ses-claude-002';
    const { resolveSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveSessionIdFromEnv()).toBe('ses-claude-002');
  });

  it('falls back to AIDER_SESSION_ID as third priority', async () => {
    process.env['AIDER_SESSION_ID'] = 'ses-aider-003';
    const { resolveSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveSessionIdFromEnv()).toBe('ses-aider-003');
  });

  it('returns CLEO_SESSION_ID over AIDER_SESSION_ID', async () => {
    process.env['CLEO_SESSION_ID'] = 'ses-cleo-004';
    process.env['AIDER_SESSION_ID'] = 'ses-aider-004';
    const { resolveSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveSessionIdFromEnv()).toBe('ses-cleo-004');
  });
});

// ---------------------------------------------------------------------------
// resolveParentSessionIdFromEnv — fork-tree parent (supervisor-stamped, T11629)
// ---------------------------------------------------------------------------

describe('resolveParentSessionIdFromEnv (T11629)', () => {
  afterEach(() => {
    delete process.env['CLEO_PARENT_SESSION_ID'];
    delete process.env['CLEO_SESSION_ID'];
  });

  it('returns null when CLEO_PARENT_SESSION_ID is unset (root process)', async () => {
    const { resolveParentSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveParentSessionIdFromEnv()).toBeNull();
  });

  it('returns null when CLEO_PARENT_SESSION_ID is empty (treated as absent)', async () => {
    process.env['CLEO_PARENT_SESSION_ID'] = '';
    const { resolveParentSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveParentSessionIdFromEnv()).toBeNull();
  });

  it('returns the supervisor-stamped fork-tree parent session id', async () => {
    process.env['CLEO_PARENT_SESSION_ID'] = 'ses_root_supervisor';
    const { resolveParentSessionIdFromEnv } = await import('../session-id.js');
    expect(resolveParentSessionIdFromEnv()).toBe('ses_root_supervisor');
  });

  it('is independent of the process own session id (child vs parent edge)', async () => {
    // The fork-tree CHILD (this process) and its PARENT are distinct edges.
    process.env['CLEO_SESSION_ID'] = 'ses_worker_child';
    process.env['CLEO_PARENT_SESSION_ID'] = 'ses_root_parent';
    const { resolveParentSessionIdFromEnv, resolveSessionIdFromEnv } = await import(
      '../session-id.js'
    );
    expect(resolveSessionIdFromEnv()).toBe('ses_worker_child');
    expect(resolveParentSessionIdFromEnv()).toBe('ses_root_parent');
  });

  it('exposes CLEO_PARENT_SESSION_ID as the canonical PARENT_SESSION_ENV_KEY', async () => {
    const { PARENT_SESSION_ENV_KEY } = await import('../session-id.js');
    expect(PARENT_SESSION_ENV_KEY).toBe('CLEO_PARENT_SESSION_ID');
  });
});

// ---------------------------------------------------------------------------
// sessionStart — per-agent conflict scoping
// ---------------------------------------------------------------------------

describe('sessionStart — per-agent conflict check (T9975)', () => {
  const PROJECT_ROOT = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetaValue.mockResolvedValue(null);
    mockSetMetaValue.mockResolvedValue(undefined);
    mockUpsertSingleSession.mockResolvedValue(undefined);
    mockLoadSingleTask.mockResolvedValue({ id: 'T001', title: 'test' });
  });

  it('blocks a second session start when no agent handle is provided', async () => {
    const existingSession = makeSession('ses-existing');
    mockGetActiveSession.mockResolvedValue(existingSession);
    mockLoadSessions.mockResolvedValue([existingSession]);

    const { sessionStart } = await import('../../session/engine-ops.js');
    const result = await sessionStart(PROJECT_ROOT, {
      scope: 'global',
      name: 'my-session',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SESSION_CONFLICT');
  });

  it('allows two sessions with different agent handles', async () => {
    // Agent A has an existing session
    const sessionA = makeSession('ses-agent-a', { agentHandle: 'agent-A' });
    mockGetActiveSession.mockResolvedValue(sessionA);
    mockLoadSessions.mockResolvedValue([sessionA]);

    const { sessionStart } = await import('../../session/engine-ops.js');

    // Agent B starts a new session with a different handle — should succeed
    const result = await sessionStart(PROJECT_ROOT, {
      scope: 'global',
      name: 'agent-b-session',
      agentHandle: 'agent-B',
    });

    expect(result.success).toBe(true);
    const newSession = result.data as Session & { agentHandle?: string };
    expect(newSession.agentHandle).toBe('agent-B');
  });

  it('blocks a second session start for the same agent handle', async () => {
    const existingSession = makeSession('ses-agent-a', { agentHandle: 'agent-A' });
    mockGetActiveSession.mockResolvedValue(existingSession);
    mockLoadSessions.mockResolvedValue([existingSession]);

    const { sessionStart } = await import('../../session/engine-ops.js');
    const result = await sessionStart(PROJECT_ROOT, {
      scope: 'global',
      name: 'agent-a-duplicate',
      agentHandle: 'agent-A',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SESSION_CONFLICT');
  });

  it('stores agentHandle, scopeKind, scopeId on the new session', async () => {
    mockGetActiveSession.mockResolvedValue(null);
    mockLoadSessions.mockResolvedValue([]);

    let upsertedSession: Session | undefined;
    mockUpsertSingleSession.mockImplementation(async (s: Session) => {
      upsertedSession = s;
    });

    const { sessionStart } = await import('../../session/engine-ops.js');
    const result = await sessionStart(PROJECT_ROOT, {
      scope: 'global',
      name: 'my-agent-session',
      agentHandle: 'worker-1',
    });

    expect(result.success).toBe(true);
    expect(upsertedSession?.agentHandle).toBe('worker-1');
    expect(upsertedSession?.scopeKind).toBe('global');
    expect(upsertedSession?.scopeId).toBeNull();
  });

  it('stores scopeKind=epic and scopeId=T9964 for epic scopes', async () => {
    mockGetActiveSession.mockResolvedValue(null);
    mockLoadSessions.mockResolvedValue([]);
    // epic scope: root task must exist
    mockLoadSingleTask.mockResolvedValue({ id: 'T9964', title: 'Epic' });

    let upsertedSession: Session | undefined;
    mockUpsertSingleSession.mockImplementation(async (s: Session) => {
      upsertedSession = s;
    });

    const { sessionStart } = await import('../../session/engine-ops.js');
    const result = await sessionStart(PROJECT_ROOT, {
      scope: 'epic:T9964',
      name: 'epic-agent-session',
      agentHandle: 'worker-2',
    });

    expect(result.success).toBe(true);
    expect(upsertedSession?.scopeKind).toBe('epic');
    expect(upsertedSession?.scopeId).toBe('T9964');
    expect(upsertedSession?.agentHandle).toBe('worker-2');
  });
});

// ---------------------------------------------------------------------------
// sessionAdopt
// ---------------------------------------------------------------------------

describe('sessionAdopt (T9975)', () => {
  const PROJECT_ROOT = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exportCommand for an active session', async () => {
    const activeSession = makeSession('ses-active-001');
    mockLoadSessions.mockResolvedValue([activeSession]);

    const { sessionAdopt } = await import('../../session/engine-ops.js');
    const result = await sessionAdopt(PROJECT_ROOT, 'ses-active-001');

    expect(result.success).toBe(true);
    expect(result.data?.sessionId).toBe('ses-active-001');
    expect(result.data?.exportCommand).toBe('export CLEO_SESSION_ID=ses-active-001');
    expect(result.data?.envVar).toBe('CLEO_SESSION_ID');
  });

  it('returns E_NOT_FOUND for a non-existent session', async () => {
    mockLoadSessions.mockResolvedValue([]);

    const { sessionAdopt } = await import('../../session/engine-ops.js');
    const result = await sessionAdopt(PROJECT_ROOT, 'ses-nonexistent');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('returns E_SESSION_NOT_FOUND for an ended session', async () => {
    const endedSession = makeSession('ses-ended-001', { status: 'ended' });
    mockLoadSessions.mockResolvedValue([endedSession]);

    const { sessionAdopt } = await import('../../session/engine-ops.js');
    const result = await sessionAdopt(PROJECT_ROOT, 'ses-ended-001');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Concurrent 2-agent test: two isolated sessions
// ---------------------------------------------------------------------------

describe('concurrent 2-agent isolated sessions (T9975 AC4)', () => {
  const PROJECT_ROOT = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetaValue.mockResolvedValue(null);
    mockSetMetaValue.mockResolvedValue(undefined);
    mockUpsertSingleSession.mockResolvedValue(undefined);
    mockLoadSingleTask.mockResolvedValue(null);
  });

  it("two agents can each start their own session and adopt each other's", async () => {
    const sessionA = makeSession('ses-a001', { agentHandle: 'agent-A' });
    const sessionB = makeSession('ses-b001', { agentHandle: 'agent-B', status: 'active' });

    // Both sessions exist
    mockLoadSessions.mockResolvedValue([sessionA, sessionB]);

    const { sessionAdopt } = await import('../../session/engine-ops.js');

    // Agent B adopts agent A's session
    const adoptResult = await sessionAdopt(PROJECT_ROOT, 'ses-a001');
    expect(adoptResult.success).toBe(true);
    expect(adoptResult.data?.exportCommand).toBe('export CLEO_SESSION_ID=ses-a001');

    // Agent A adopts agent B's session
    const adoptResult2 = await sessionAdopt(PROJECT_ROOT, 'ses-b001');
    expect(adoptResult2.success).toBe(true);
    expect(adoptResult2.data?.exportCommand).toBe('export CLEO_SESSION_ID=ses-b001');
  });
});
