/**
 * Integration test for the full session handoff round-trip.
 * Tests the end-to-end flow: start session → end session → compute handoff → persist → retrieve.
 *
 * Uses mocked data accessors to simulate SQLite behavior without real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock data accessor
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// Mock decisions (required by computeHandoff)
vi.mock('../decisions.js', () => ({
  getDecisionLog: vi.fn().mockResolvedValue([]),
}));

import { getAccessor } from '../../../store/data-accessor.js';
import { computeHandoff, persistHandoff, getHandoff, getLastHandoff } from '../handoff.js';
import { computeBriefing } from '../briefing.js';
import type { Session, SessionScope } from '../../../types/session.js';

/**
 * Simulates the session store — sessions live in one array (like SQLite).
 * Tests that ended sessions are NOT removed from the array.
 */
function createMockStore() {
  const tasks = [
    { id: 'T100', status: 'active', parentId: undefined, title: 'Epic', description: 'Epic task', type: 'epic' },
    { id: 'T101', status: 'pending', parentId: 'T100', title: 'Child task 1', description: 'First child', priority: 'high' },
    { id: 'T102', status: 'blocked', parentId: 'T100', title: 'Child task 2 (blocked)', description: 'Blocked child' },
    { id: 'T103', status: 'pending', parentId: 'T101', title: 'Grandchild', description: 'Grandchild task', priority: 'medium' },
    { id: 'T200', status: 'pending', parentId: undefined, title: 'Outside epic', description: 'Not in scope', priority: 'critical' },
    { id: 'T300', status: 'active', parentId: undefined, title: 'Bug outside scope', description: 'Bug task', type: 'bug', labels: ['bug'], priority: 'high' },
  ];

  const sessions: Session[] = [];
  const taskData = {
    tasks,
    focus: { currentTask: null, currentPhase: null, blockedUntil: null, sessionNote: null, sessionNotes: [], nextAction: null, primarySession: null },
    _meta: { schemaVersion: '1.0.0', activeSession: null, multiSessionEnabled: false },
  };

  return {
    sessions,
    taskData,
    accessor: {
      loadSessions: vi.fn().mockImplementation(() => Promise.resolve(sessions)),
      saveSessions: vi.fn().mockImplementation(() => Promise.resolve()),
      loadTaskFile: vi.fn().mockImplementation(() => Promise.resolve(taskData)),
      saveTaskFile: vi.fn().mockImplementation(() => Promise.resolve()),
    },
  };
}

describe('Session handoff full round-trip', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(store.accessor);
  });

  it('full round-trip: start → end → compute handoff → persist → retrieve → successor start', async () => {
    // === Step 1: Simulate session start ===
    const session1: Session = {
      id: 'ses_001',
      name: 'Session 1',
      status: 'active',
      scope: { type: 'epic', epicId: 'T100', rootTaskId: 'T100' },
      taskWork: { taskId: 'T101', setAt: new Date().toISOString() },
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      notes: [],
      tasksCompleted: ['T103'],
      tasksCreated: [],
    };
    store.sessions.push(session1);

    // === Step 2: Simulate session end (update in-place, NO splice) ===
    session1.status = 'ended';
    session1.endedAt = new Date().toISOString();
    // Session stays in sessions array — this is the splice bug fix

    // === Step 3: Compute handoff ===
    const handoff = await computeHandoff('/test', { sessionId: 'ses_001', note: 'Continue with T101' });

    expect(handoff.lastTask).toBe('T101');
    expect(handoff.tasksCompleted).toEqual(['T103']);
    expect(handoff.note).toBe('Continue with T101');
    // nextSuggested should only contain T100-scope tasks (T101, T103), NOT T200
    expect(handoff.nextSuggested).not.toContain('T200');
    // openBlockers should contain T102 (blocked, in scope)
    expect(handoff.openBlockers).toContain('T102');

    // === Step 4: Persist handoff ===
    await persistHandoff('/test', 'ses_001', handoff);

    // Verify session still in sessions array (not deleted by splice)
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].status).toBe('ended');
    expect(store.sessions[0].handoffJson).toBeDefined();

    // === Step 5: Retrieve handoff ===
    const retrieved = await getHandoff('/test', 'ses_001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.lastTask).toBe('T101');
    expect(retrieved!.note).toBe('Continue with T101');

    // === Step 6: getLastHandoff with epic scope ===
    const last = await getLastHandoff('/test', { type: 'epic', epicId: 'T100' });
    expect(last).not.toBeNull();
    expect(last!.sessionId).toBe('ses_001');
    expect(last!.handoff.lastTask).toBe('T101');

    // === Step 7: getLastHandoff with rootTaskId (engine-layer style) ===
    const lastByRoot = await getLastHandoff('/test', { type: 'epic', rootTaskId: 'T100' } as any);
    expect(lastByRoot).not.toBeNull();
    expect(lastByRoot!.sessionId).toBe('ses_001');
  });

  it('handoff NOT found when session was spliced (simulates old bug)', async () => {
    // Simulate the OLD buggy behavior: session created, then removed from array
    const session1: Session = {
      id: 'ses_old',
      name: 'Old Session',
      status: 'ended',
      scope: { type: 'epic', epicId: 'T100', rootTaskId: 'T100' },
      taskWork: { taskId: 'T101', setAt: new Date().toISOString() },
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      endedAt: new Date(Date.now() - 3600000).toISOString(),
      handoffJson: JSON.stringify({ lastTask: 'T101', tasksCompleted: [], tasksCreated: [], decisionsRecorded: 0, nextSuggested: [], openBlockers: [], openBugs: [] }),
    };
    // Session is in the array — handoff should be found
    store.sessions.push(session1);
    const found = await getLastHandoff('/test', { type: 'epic', epicId: 'T100' });
    expect(found).not.toBeNull();

    // Now simulate splice (old bug) — remove from array
    store.sessions.splice(0, 1);
    const notFound = await getLastHandoff('/test', { type: 'epic', epicId: 'T100' });
    expect(notFound).toBeNull(); // Lost!
  });

  it('scope filter matches across epicId/rootTaskId mismatch', async () => {
    // Engine-created session has rootTaskId but no epicId
    const engineSession: Session = {
      id: 'ses_engine',
      name: 'Engine Session',
      status: 'ended',
      scope: { type: 'epic', rootTaskId: 'T100' } as SessionScope,
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date(Date.now() - 7200000).toISOString(),
      endedAt: new Date().toISOString(),
      handoffJson: JSON.stringify({ lastTask: null, tasksCompleted: [], tasksCreated: [], decisionsRecorded: 0, nextSuggested: [], openBlockers: [], openBugs: [] }),
    };
    store.sessions.push(engineSession);

    // Core-layer query uses epicId
    const result = await getLastHandoff('/test', { type: 'epic', epicId: 'T100' });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('ses_engine');
  });

  it('briefing scope-filters all sections for epic scope', async () => {
    // Add an active session so briefing can detect scope
    const session: Session = {
      id: 'ses_brief',
      name: 'Briefing Session',
      status: 'active',
      scope: { type: 'epic', epicId: 'T100', rootTaskId: 'T100' },
      taskWork: { taskId: 'T101', setAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
    };
    store.sessions.push(session);
    store.taskData._meta!.activeSession = 'ses_brief';
    store.taskData.focus!.currentTask = 'T101';

    const briefing = await computeBriefing('/test', { scope: 'epic:T100' });

    // nextTasks should only contain T100-scope tasks
    const nextIds = briefing.nextTasks.map(t => t.id);
    expect(nextIds).not.toContain('T200'); // Outside scope
    expect(nextIds).not.toContain('T300'); // Outside scope

    // openBugs should NOT contain T300 (outside scope)
    const bugIds = briefing.openBugs.map(b => b.id);
    expect(bugIds).not.toContain('T300');

    // currentTask should be set
    expect(briefing.currentTask).not.toBeNull();
    expect(briefing.currentTask!.id).toBe('T101');
  });
});
