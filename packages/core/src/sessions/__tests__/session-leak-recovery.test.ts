/**
 * Recovering from leaked active sessions (gh#1469).
 *
 * ## The defect
 *
 * `cleo session start` is the FIRST command the protocol tells every agent to
 * run. Measured in this repo on 2026-09-21 it refused with:
 *
 *     An active session already exists (ses_…). End it first with 'cleo session end'.
 *
 * `session end` ends ONE session. Sessions leak active — an agent that crashes
 * never ends its own — and there were **70**, the oldest four months old. So
 * following the fix ended one, the next `start` named a different id, and the
 * loop had no count and no terminator: a 70-step drain presented as a one-step
 * fix.
 *
 * Enumeration did not rescue it either. `cleo session list` defaults to ten
 * rows ordered oldest-first, so it showed ZERO active sessions while `start`
 * insisted one existed — and `--limit 0`, the documented "every match" escape
 * (gh#1302), was read as falsy and silently became that same ten-row default.
 *
 * `cleo session gc --max-age 1` already existed and cleared all 70 in one call.
 * Nothing pointed at it.
 *
 * ## What these tests pin
 *
 * 1. `--limit 0` returns every matching session, not a page.
 * 2. Past one stale session the conflict names the COUNT and routes to
 *    `session gc`, instead of prescribing a per-session `end`.
 * 3. With exactly one, the original single-session advice is unchanged.
 */

import type { Session } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      resolveCurrentSession: mockGetActiveSession,
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
// gh#1469 — enumeration and bulk recovery
// ---------------------------------------------------------------------------

describe('sessionList --limit 0 enumerates every match (gh#1469)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetaValue.mockResolvedValue(undefined);
  });

  it('returns all rows for --limit 0, not the ten-row default', async () => {
    const many = Array.from({ length: 70 }, (_, i) => makeSession(`ses-${i}`));
    mockLoadSessions.mockResolvedValue(many);
    const { sessionList } = await import('../../session/engine-ops.js');
    const res = await sessionList('/tmp/p', { status: 'active', limit: 0 });
    expect(res.success).toBe(true);
    expect(res.data?.sessions).toHaveLength(70);
    expect(res.data?._meta.truncated).toBe(false);
  });

  it('still defaults to ten rows when no limit is given', async () => {
    mockLoadSessions.mockResolvedValue(
      Array.from({ length: 70 }, (_, i) => makeSession(`ses-${i}`)),
    );
    const { sessionList } = await import('../../session/engine-ops.js');
    const res = await sessionList('/tmp/p', { status: 'active' });
    expect(res.data?.sessions).toHaveLength(10);
    expect(res.data?._meta.truncated).toBe(true);
  });

  it('honours an explicit positive limit unchanged', async () => {
    mockLoadSessions.mockResolvedValue(
      Array.from({ length: 70 }, (_, i) => makeSession(`ses-${i}`)),
    );
    const { sessionList } = await import('../../session/engine-ops.js');
    const res = await sessionList('/tmp/p', { status: 'active', limit: 25 });
    expect(res.data?.sessions).toHaveLength(25);
  });

  it('does not break on an empty result set', async () => {
    mockLoadSessions.mockResolvedValue([]);
    const { sessionList } = await import('../../session/engine-ops.js');
    const res = await sessionList('/tmp/p', { status: 'active', limit: 0 });
    expect(res.data?.sessions).toHaveLength(0);
  });
});

describe('E_SESSION_CONFLICT routes to bulk recovery when several leak (gh#1469)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetaValue.mockResolvedValue(undefined);
    mockLoadSingleTask.mockResolvedValue({ id: 'T1' });
  });

  it('names the count and `session gc` when more than one is active', async () => {
    const many = Array.from({ length: 70 }, (_, i) => makeSession(`ses-${i}`));
    mockLoadSessions.mockResolvedValue(many);
    mockGetActiveSession.mockResolvedValue(many[0]!);
    const { sessionStart } = await import('../../session/engine-ops.js');
    const res = await sessionStart('/tmp/p', { scope: 'global', name: 'x' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_SESSION_CONFLICT');
    // The count is the fact the old message withheld — without it the agent
    // cannot tell a one-step fix from a seventy-step one.
    expect(res.error?.message).toContain('70');
    expect(res.error?.message).toContain('session gc');
    expect(res.error?.details?.activeSessionCount).toBe(70);
  });

  it('keeps the single-session advice when exactly one is active', async () => {
    const one = makeSession('ses-only');
    mockLoadSessions.mockResolvedValue([one]);
    mockGetActiveSession.mockResolvedValue(one);
    const { sessionStart } = await import('../../session/engine-ops.js');
    const res = await sessionStart('/tmp/p', { scope: 'global', name: 'x' });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain("End it first with 'cleo session end'");
    expect(res.error?.message).not.toContain('session gc');
  });
});
