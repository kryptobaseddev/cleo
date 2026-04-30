/**
 * Tests for T1609 — session_handoff_entries append-only enforcement.
 *
 * Verifies that:
 *   1. persistHandoff() routes through insertHandoffEntry() (not updateSession).
 *   2. A second call to persistHandoff() for the same session is rejected with
 *      CleoError(ALREADY_EXISTS) when the store returns a UNIQUE constraint error.
 *   3. insertHandoffEntry() from session-store.ts is the sole write path.
 *
 * @task T1609
 * @epic T1603
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- mock data-accessor so persistHandoff can load sessions ---
vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// --- mock decisions (required by computeHandoff) ---
vi.mock('../decisions.js', () => ({
  getDecisionLog: vi.fn().mockResolvedValue([]),
}));

// --- mock session-store so we control insertHandoffEntry ---
vi.mock('../../store/session-store.js', () => ({
  insertHandoffEntry: vi.fn(),
}));

import type { Session } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { getAccessor } from '../../store/data-accessor.js';
import { insertHandoffEntry } from '../../store/session-store.js';
import { persistHandoff } from '../handoff.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_t1609_test',
    name: 'T1609 test session',
    status: 'ended',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: '2026-04-29T00:00:00Z',
    endedAt: '2026-04-29T01:00:00Z',
    tasksCompleted: [],
    tasksCreated: [],
    notes: [],
    ...overrides,
  };
}

const HANDOFF_DATA = {
  lastTask: 'T999',
  tasksCompleted: ['T998'],
  tasksCreated: [],
  decisionsRecorded: 0,
  nextSuggested: [],
  openBlockers: [],
  openBugs: [],
};

function setupAccessor(sessions: Session[]) {
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue({
    loadSessions: vi.fn().mockResolvedValue(sessions),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T1609 — persistHandoff append-only enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes writes through insertHandoffEntry, not updateSession', async () => {
    const session = makeSession();
    setupAccessor([session]);
    (insertHandoffEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await persistHandoff('/fake/root', 'ses_t1609_test', HANDOFF_DATA);

    // insertHandoffEntry MUST have been called exactly once
    expect(insertHandoffEntry).toHaveBeenCalledOnce();
    expect(insertHandoffEntry).toHaveBeenCalledWith(
      'ses_t1609_test',
      JSON.stringify(HANDOFF_DATA),
      '/fake/root',
    );
  });

  it('rejects a second persist call with CleoError(ALREADY_EXISTS)', async () => {
    const session = makeSession();
    setupAccessor([session]);

    // First call succeeds
    (insertHandoffEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await persistHandoff('/fake/root', 'ses_t1609_test', HANDOFF_DATA);

    // Second call: insertHandoffEntry throws the UNIQUE constraint error
    const uniqueErr = new Error(
      'LibsqlError: UNIQUE constraint failed: session_handoff_entries.session_id',
    );
    (insertHandoffEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(uniqueErr);

    // Reload accessor so loadSessions still returns the session
    setupAccessor([session]);

    await expect(
      persistHandoff('/fake/root', 'ses_t1609_test', HANDOFF_DATA),
    ).rejects.toMatchObject({
      code: ExitCode.ALREADY_EXISTS,
      message: expect.stringContaining('write-once'),
    });
  });

  it('throws CleoError(SESSION_NOT_FOUND) when session does not exist', async () => {
    setupAccessor([]); // no sessions

    await expect(
      persistHandoff('/fake/root', 'ses_does_not_exist', HANDOFF_DATA),
    ).rejects.toMatchObject({
      code: ExitCode.SESSION_NOT_FOUND,
    });

    // insertHandoffEntry must NOT be called when session not found
    expect(insertHandoffEntry).not.toHaveBeenCalled();
  });

  it('re-throws non-UNIQUE errors without wrapping', async () => {
    const session = makeSession();
    setupAccessor([session]);

    const ioErr = new Error('disk full');
    (insertHandoffEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(ioErr);

    await expect(persistHandoff('/fake/root', 'ses_t1609_test', HANDOFF_DATA)).rejects.toThrow(
      'disk full',
    );
  });

  it('passes the serialised handoff JSON to insertHandoffEntry', async () => {
    const session = makeSession();
    setupAccessor([session]);
    (insertHandoffEntry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const handoff = { ...HANDOFF_DATA, lastTask: 'T777', note: 'important context' };
    await persistHandoff('/fake/root', 'ses_t1609_test', handoff);

    const [, passedJson] = (insertHandoffEntry as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const parsed = JSON.parse(passedJson as string);
    expect(parsed.lastTask).toBe('T777');
    expect(parsed.note).toBe('important context');
  });
});
