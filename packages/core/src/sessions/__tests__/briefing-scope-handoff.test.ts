/**
 * Tests for T9967 bug fixes:
 * 1. Default relatedDocs ranking — scope-relevant docs surface above unrelated ones.
 * 2. Scoped briefing (--scope epic:T###) resolves lastSession.handoff from docs
 *    when no matching session exists.
 *
 * @task T9967
 * @epic T9964
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data-accessor before importing briefing module
vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

// Mock handoff module — return null by default to exercise docs fallback
const mockGetLastHandoff = vi.fn().mockResolvedValue(null);
vi.mock('../handoff.js', () => ({
  getLastHandoff: (...args: unknown[]) => mockGetLastHandoff(...args),
}));

// Mock lifecycle pipeline
vi.mock('../../lifecycle/pipeline.js', () => ({
  getPipeline: vi.fn().mockResolvedValue(null),
}));

// Mock attachment store
const mockListByOwner = vi.fn().mockResolvedValue([]);
const mockListAllInProject = vi.fn().mockResolvedValue([]);
vi.mock('../../store/attachment-store.js', () => ({
  createAttachmentStore: vi.fn(() => ({
    listByOwner: mockListByOwner,
    listAllInProject: mockListAllInProject,
    put: vi.fn(),
    get: vi.fn(),
    getMetadata: vi.fn(),
    ref: vi.fn(),
    deref: vi.fn(),
  })),
}));

// Mock session-memory to suppress noise
vi.mock('../../memory/session-memory.js', () => ({
  getSessionMemoryContext: vi.fn().mockResolvedValue(undefined),
}));

// Mock brain-retrieval to suppress noise
vi.mock('../../memory/brain-retrieval.js', () => ({
  buildRetrievalBundle: vi.fn().mockResolvedValue(undefined),
}));

// Mock dream-cycle
vi.mock('../../memory/dream-cycle.js', () => ({
  checkAndDream: vi.fn().mockResolvedValue(undefined),
}));

// Mock config — disable opportunistic dream
vi.mock('../../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ briefing: { opportunisticDream: false } }),
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AttachmentMetadata fixture. */
function makeAttachmentMeta(
  id: string,
  createdAt: string,
  opts: { description?: string; kind?: string } = {},
) {
  return {
    id,
    sha256: 'aa'.repeat(32),
    attachment: {
      kind: opts.kind ?? 'blob',
      storageKey: `key-${id}`,
      sha256: 'aa'.repeat(32),
      mime: 'text/markdown',
      size: 100,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    },
    createdAt,
    refCount: 1,
  };
}

/** Shared task list used by multiple tests. */
function makeEpicTaskList() {
  return [
    {
      id: 'T900',
      type: 'epic',
      status: 'active',
      title: 'Target Epic',
      priority: 'high',
      parentId: undefined,
      origin: 'production',
    },
    {
      id: 'T901',
      status: 'pending',
      title: 'Epic child A',
      priority: 'high',
      parentId: 'T900',
    },
    {
      id: 'T902',
      status: 'pending',
      title: 'Epic child B',
      priority: 'medium',
      parentId: 'T900',
    },
    {
      id: 'T950',
      status: 'pending',
      title: 'Unrelated task',
      priority: 'low',
      parentId: undefined,
    },
    {
      id: 'T951',
      status: 'pending',
      title: 'Another unrelated task',
      priority: 'low',
      parentId: undefined,
    },
  ];
}

function setupMockAccessor(tasks = makeEpicTaskList(), focusTaskId: string | null = 'T901') {
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue([]),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    removeSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockImplementation((key: string) => {
      if (key === 'focus_state')
        return Promise.resolve(
          focusTaskId ? { currentTask: focusTaskId, currentPhase: null } : null,
        );
      return Promise.resolve(null);
    }),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);
  return mockAccessor;
}

// ---------------------------------------------------------------------------
// AC1 — Default relatedDocs ranking: scope-relevant docs surface first
// ---------------------------------------------------------------------------

describe('T9967 AC1 — relatedDocs ranking (default mode, auto-detected epic scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLastHandoff.mockResolvedValue(null);
    mockListByOwner.mockResolvedValue([]);
    mockListAllInProject.mockResolvedValue([]);
  });

  it('scope-relevant docs rank above unrelated docs before the 5-entry cap is applied', async () => {
    setupMockAccessor();

    const recentTs = new Date().toISOString();
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    // T950 and T951 (unrelated) have 3 older docs each.
    // T902 (in-scope) has 1 recent doc — should rank first.
    mockListByOwner.mockImplementation(async (_ownerType: string, taskId: string) => {
      if (taskId === 'T901') return []; // focused task, no docs
      if (taskId === 'T902')
        return [makeAttachmentMeta('scope-doc-1', recentTs, { description: 'Epic spec' })];
      if (taskId === 'T950')
        return [
          makeAttachmentMeta('unrelated-doc-1', oldTs),
          makeAttachmentMeta('unrelated-doc-2', oldTs),
          makeAttachmentMeta('unrelated-doc-3', oldTs),
        ];
      if (taskId === 'T951')
        return [
          makeAttachmentMeta('unrelated-doc-4', oldTs),
          makeAttachmentMeta('unrelated-doc-5', oldTs),
        ];
      return [];
    });

    // Simulate auto-detected epic scope from the active session.
    const mockAccessor = setupMockAccessor();
    mockAccessor.getActiveSession.mockResolvedValue({
      id: 'sess-auto',
      scope: { type: 'epic', rootTaskId: 'T900' },
    });

    // No explicit scope param — relies on auto-detection.
    const briefing = await computeBriefing('/fake/project', {});

    const relatedIds = (briefing.docsContext?.relatedDocs ?? []).map((d) => d.attachmentId);

    // The scope-relevant doc should appear before unrelated docs.
    const scopeDocIdx = relatedIds.indexOf('scope-doc-1');
    const firstUnrelatedIdx = relatedIds.findIndex((id) => id.startsWith('unrelated-'));

    if (scopeDocIdx !== -1 && firstUnrelatedIdx !== -1) {
      expect(scopeDocIdx).toBeLessThan(firstUnrelatedIdx);
    }
  });

  it('explicit --scope epic:T900 ranks T900-descendant docs above T950/T951 docs', async () => {
    setupMockAccessor();

    const recentTs = new Date().toISOString();
    const oldTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    mockListByOwner.mockImplementation(async (_ownerType: string, taskId: string) => {
      if (taskId === 'T901') return []; // focused task
      if (taskId === 'T902')
        return [makeAttachmentMeta('epic-child-doc', recentTs, { description: 'ADR in scope' })];
      // T950 and T951 are excluded by scope filter, so they won't be queried.
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    const relatedIds = (briefing.docsContext?.relatedDocs ?? []).map((d) => d.attachmentId);
    expect(relatedIds).toContain('epic-child-doc');
    // Out-of-scope task docs must not appear.
    expect(relatedIds.filter((id) => id.startsWith('unrelated-'))).toHaveLength(0);
  });

  it('unscoped global mode preserves existing behaviour (no crash, docs returned)', async () => {
    setupMockAccessor();

    const ts = new Date().toISOString();
    mockListByOwner.mockImplementation(async (_ownerType: string, taskId: string) => {
      if (taskId === 'T901') return [];
      if (taskId === 'T902') return [makeAttachmentMeta('any-doc', ts)];
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    // Should not throw; relatedDocs may or may not be populated.
    expect(briefing).toBeDefined();
    expect(briefing.docsContext?.relatedDocs).toBeDefined();
  });

  it('when multiple scope docs exist, more-recent ones rank first within the scope group', async () => {
    setupMockAccessor();

    const newerTs = new Date().toISOString();
    const olderTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    mockListByOwner.mockImplementation(async (_ownerType: string, taskId: string) => {
      if (taskId === 'T901') return []; // focused task
      if (taskId === 'T902') return [makeAttachmentMeta('older-scope-doc', olderTs)];
      if (taskId === 'T900')
        return [makeAttachmentMeta('newer-scope-doc', newerTs, { description: 'newest' })];
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    const relatedIds = (briefing.docsContext?.relatedDocs ?? []).map((d) => d.attachmentId);
    const newerIdx = relatedIds.indexOf('newer-scope-doc');
    const olderIdx = relatedIds.indexOf('older-scope-doc');

    if (newerIdx !== -1 && olderIdx !== -1) {
      expect(newerIdx).toBeLessThan(olderIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — Scoped handoff: --scope epic:T### resolves lastSession.handoff from docs
// ---------------------------------------------------------------------------

describe('T9967 AC2 — scoped handoff resolution from docs when no matching session exists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getLastHandoff always returns null — simulates no session with matching scope.
    mockGetLastHandoff.mockResolvedValue(null);
    mockListByOwner.mockResolvedValue([]);
    mockListAllInProject.mockResolvedValue([]);
  });

  it('returns non-null lastSession.handoff from docs when no matching session exists', async () => {
    setupMockAccessor();

    const handoffTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    // Simulate one handoff-type doc attached to a task in scope.
    mockListAllInProject.mockImplementation(async (_cwd: string, filter?: { type?: string }) => {
      if (filter?.type === 'handoff') {
        return [
          {
            metadata: makeAttachmentMeta('handoff-doc-1', handoffTs, {
              description: 'Wave 1 session summary',
              kind: 'blob',
            }),
            slug: 'sg-arch-solid-session-1-handoff',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T901', // in scope (child of T900)
          },
        ];
      }
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    expect(briefing.lastSession).not.toBeNull();
    expect(briefing.lastSession!.handoff).toBeDefined();
    expect(briefing.lastSession!.handoff.note).toBe('Wave 1 session summary');
    expect(briefing.lastSession!.handoff.lastTask).toBe('T901');
    expect(briefing.lastSession!.endedAt).toBe(handoffTs);
  });

  it('picks the most-recent handoff doc when multiple exist in scope', async () => {
    setupMockAccessor();

    const olderTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const newerTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    mockListAllInProject.mockImplementation(async (_cwd: string, filter?: { type?: string }) => {
      if (filter?.type === 'handoff') {
        return [
          {
            metadata: makeAttachmentMeta('old-handoff', olderTs, {
              description: 'Older handoff',
            }),
            slug: 'old-handoff',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T901',
          },
          {
            metadata: makeAttachmentMeta('new-handoff', newerTs, {
              description: 'Newer handoff',
            }),
            slug: 'new-handoff',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T902',
          },
        ];
      }
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    // Should pick the newer handoff doc.
    expect(briefing.lastSession!.handoff.note).toBe('Newer handoff');
    expect(briefing.lastSession!.handoff.lastTask).toBe('T902');
  });

  it('ignores handoff docs outside the scope', async () => {
    setupMockAccessor();

    const ts = new Date().toISOString();

    mockListAllInProject.mockImplementation(async (_cwd: string, filter?: { type?: string }) => {
      if (filter?.type === 'handoff') {
        return [
          {
            // T950 is NOT in epic T900's scope.
            metadata: makeAttachmentMeta('out-of-scope-handoff', ts, {
              description: 'Unrelated handoff',
            }),
            slug: 'out-of-scope-handoff',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T950',
          },
        ];
      }
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    // No in-scope handoff docs — should stay null.
    expect(briefing.lastSession).toBeNull();
  });

  it('returns null when no handoff docs exist in scope and no session exists', async () => {
    setupMockAccessor();
    mockListAllInProject.mockResolvedValue([]);

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    expect(briefing.lastSession).toBeNull();
  });

  it('session handoff takes precedence over docs fallback when session exists', async () => {
    setupMockAccessor();

    // Simulate a real session with handoff data.
    const sessionEndedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const sessionStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60000).toISOString();

    mockGetLastHandoff.mockResolvedValue({
      sessionId: 'sess-real',
      handoff: {
        lastTask: 'T901',
        tasksCompleted: ['T901'],
        tasksCreated: [],
        decisionsRecorded: 2,
        nextSuggested: ['T902'],
        openBlockers: [],
        openBugs: [],
        note: 'Real session note',
      },
    });

    const mockAccessor = setupMockAccessor();
    mockAccessor.loadSessions.mockResolvedValue([
      {
        id: 'sess-real',
        status: 'ended',
        endedAt: sessionEndedAt,
        startedAt: sessionStartedAt,
        scope: { type: 'epic', rootTaskId: 'T900' },
        handoffJson: JSON.stringify({
          lastTask: 'T901',
          tasksCompleted: ['T901'],
          tasksCreated: [],
          decisionsRecorded: 2,
          nextSuggested: ['T902'],
          openBlockers: [],
          openBugs: [],
          note: 'Real session note',
        }),
      },
    ]);

    const docTs = new Date().toISOString();
    mockListAllInProject.mockImplementation(async (_cwd: string, filter?: { type?: string }) => {
      if (filter?.type === 'handoff') {
        return [
          {
            metadata: makeAttachmentMeta('doc-handoff', docTs, {
              description: 'Doc fallback note',
            }),
            slug: 'doc-handoff',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T901',
          },
        ];
      }
      return [];
    });

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T900' });

    // Real session handoff must take precedence over docs fallback.
    expect(briefing.lastSession!.handoff.note).toBe('Real session note');
    expect(briefing.lastSession!.handoff.decisionsRecorded).toBe(2);
  });

  it('global scope does NOT trigger docs-based handoff fallback', async () => {
    setupMockAccessor();

    const ts = new Date().toISOString();
    mockListAllInProject.mockImplementation(async (_cwd: string, filter?: { type?: string }) => {
      if (filter?.type === 'handoff') {
        return [
          {
            metadata: makeAttachmentMeta('global-handoff-doc', ts, {
              description: 'Should not appear',
            }),
            slug: 'global-handoff-doc',
            type: 'handoff',
            ownerType: 'task',
            ownerId: 'T901',
          },
        ];
      }
      return [];
    });

    // Global scope: no session handoff found, no docs fallback expected.
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    // Global scope does not use the docs fallback path — lastSession stays null.
    expect(briefing.lastSession).toBeNull();
  });
});
