/**
 * Tests for the docs context pillar in session briefing.
 *
 * Validates that computeBriefing correctly surfaces task-attached document
 * references (the third pillar: state + rationale + references).
 *
 * @task T1616
 * @epic T1611
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock data-accessor before importing briefing module
vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

// Mock handoff module — getLastHandoff is called by computeLastSession
vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

// Mock lifecycle pipeline
vi.mock('../../lifecycle/pipeline.js', () => ({
  getPipeline: vi.fn().mockResolvedValue(null),
}));

// Mock attachment store — the docs pillar uses createAttachmentStore
const mockListByOwner = vi.fn().mockResolvedValue([]);
vi.mock('../../store/attachment-store.js', () => ({
  createAttachmentStore: vi.fn(() => ({
    listByOwner: mockListByOwner,
    put: vi.fn(),
    get: vi.fn(),
    getMetadata: vi.fn(),
    ref: vi.fn(),
    deref: vi.fn(),
  })),
}));

import { getAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AttachmentMetadata fixture. */
function makeAttachmentMeta(overrides: {
  id?: string;
  kind?: string;
  description?: string;
  labels?: string[];
  createdAt?: string;
}) {
  return {
    id: overrides.id ?? 'att-001',
    sha256: 'deadbeef'.repeat(8),
    attachment: {
      kind: overrides.kind ?? 'local-file',
      path: 'docs/adr/ADR-001.md',
      sha256: 'deadbeef'.repeat(8),
      mime: 'text/markdown',
      size: 1024,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.labels !== undefined ? { labels: overrides.labels } : {}),
    },
    createdAt: overrides.createdAt ?? '2026-04-29T00:00:00.000Z',
    refCount: 1,
  };
}

function setupMockAccessor(tasks: unknown[] = [], focusTaskId: string | null = null) {
  const meta: Record<string, unknown> = {
    focus_state: { currentTask: focusTaskId, currentPhase: null },
    file_meta: { schemaVersion: '2.10.0' },
  };
  const mockAccessor = {
    loadSessions: vi.fn().mockResolvedValue([]),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    removeSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockImplementation((key: string) => Promise.resolve(meta[key] ?? null)),
    setMetaValue: vi.fn().mockImplementation((key: string, value: unknown) => {
      meta[key] = value;
      return Promise.resolve();
    }),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  };

  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAccessor);
  return mockAccessor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeBriefing docs context pillar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListByOwner.mockResolvedValue([]);
  });

  it('omits docsContext when no attachments exist', async () => {
    setupMockAccessor([{ id: 'T100', status: 'pending', title: 'A task', priority: 'medium' }]);

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeUndefined();
  });

  it('surfaces currentTaskDocs when focused task has attachments', async () => {
    const attachment = makeAttachmentMeta({
      id: 'att-current-001',
      kind: 'local-file',
      description: 'ADR-001 design doc',
      labels: ['adr'],
    });

    // listByOwner returns attachment for T100, nothing for others
    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T100') return [attachment];
      return [];
    });

    setupMockAccessor(
      [{ id: 'T100', status: 'active', title: 'Current task', priority: 'high' }],
      'T100',
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs).toHaveLength(1);
    expect(briefing.docsContext!.currentTaskDocs[0].taskId).toBe('T100');
    expect(briefing.docsContext!.currentTaskDocs[0].attachmentId).toBe('att-current-001');
    expect(briefing.docsContext!.currentTaskDocs[0].kind).toBe('local-file');
    expect(briefing.docsContext!.currentTaskDocs[0].description).toBe('ADR-001 design doc');
    expect(briefing.docsContext!.currentTaskDocs[0].labels).toEqual(['adr']);
    expect(briefing.docsContext!.totalDocs).toBe(1);
  });

  it('surfaces relatedDocs for other tasks with attachments', async () => {
    const attachment = makeAttachmentMeta({
      id: 'att-related-001',
      kind: 'url',
      description: 'RFC reference',
    });

    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T200') return [attachment];
      return [];
    });

    setupMockAccessor(
      [
        { id: 'T100', status: 'active', title: 'Focused task', priority: 'high' },
        { id: 'T200', status: 'pending', title: 'Other task', priority: 'medium' },
      ],
      'T100',
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs).toHaveLength(0);
    expect(briefing.docsContext!.relatedDocs).toHaveLength(1);
    expect(briefing.docsContext!.relatedDocs[0].taskId).toBe('T200');
    expect(briefing.docsContext!.relatedDocs[0].kind).toBe('url');
    expect(briefing.docsContext!.totalDocs).toBe(1);
  });

  it('separates currentTaskDocs from relatedDocs correctly', async () => {
    const currentAtt = makeAttachmentMeta({ id: 'att-current', kind: 'blob' });
    const relatedAtt = makeAttachmentMeta({ id: 'att-related', kind: 'llms-txt' });

    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T100') return [currentAtt];
      if (ownerId === 'T200') return [relatedAtt];
      return [];
    });

    setupMockAccessor(
      [
        { id: 'T100', status: 'active', title: 'Focused', priority: 'high' },
        { id: 'T200', status: 'pending', title: 'Related', priority: 'medium' },
      ],
      'T100',
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs).toHaveLength(1);
    expect(briefing.docsContext!.currentTaskDocs[0].attachmentId).toBe('att-current');
    expect(briefing.docsContext!.relatedDocs).toHaveLength(1);
    expect(briefing.docsContext!.relatedDocs[0].attachmentId).toBe('att-related');
    expect(briefing.docsContext!.totalDocs).toBe(2);
  });

  it('respects MAX_DOCS_PER_TASK limit (10) for focused task', async () => {
    const attachments = Array.from({ length: 15 }, (_, i) =>
      makeAttachmentMeta({ id: `att-${i.toString().padStart(3, '0')}`, kind: 'blob' }),
    );

    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T100') return attachments;
      return [];
    });

    setupMockAccessor([{ id: 'T100', status: 'active', title: 'Task', priority: 'high' }], 'T100');

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs.length).toBeLessThanOrEqual(10);
  });

  it('respects scope filter — excludes out-of-scope task attachments', async () => {
    const attachment = makeAttachmentMeta({ id: 'att-out-of-scope', kind: 'local-file' });

    // T200 is outside epic T100 hierarchy
    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T200') return [attachment];
      return [];
    });

    setupMockAccessor([
      {
        id: 'T100',
        status: 'active',
        title: 'Epic',
        type: 'epic',
        priority: 'high',
        parentId: undefined,
      },
      {
        id: 'T101',
        status: 'pending',
        title: 'Child',
        priority: 'medium',
        parentId: 'T100',
      },
      {
        id: 'T200',
        status: 'pending',
        title: 'Outside',
        priority: 'medium',
        parentId: undefined,
      },
    ]);

    const briefing = await computeBriefing('/fake/project', { scope: 'epic:T100' });

    // T200 is outside scope — its attachment should NOT appear
    const allDocTaskIds = [
      ...(briefing.docsContext?.currentTaskDocs ?? []),
      ...(briefing.docsContext?.relatedDocs ?? []),
    ].map((d) => d.taskId);

    expect(allDocTaskIds).not.toContain('T200');
  });

  it('continues gracefully when attachment store throws for a task', async () => {
    // First task throws, second task has an attachment
    const attachment = makeAttachmentMeta({ id: 'att-ok', kind: 'blob' });

    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T100') throw new Error('DB error');
      if (ownerId === 'T200') return [attachment];
      return [];
    });

    setupMockAccessor(
      [
        { id: 'T100', status: 'active', title: 'Focused', priority: 'high' },
        { id: 'T200', status: 'pending', title: 'Other', priority: 'medium' },
      ],
      'T100',
    );

    // Should not throw — best-effort
    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    // currentTaskDocs is empty (T100 threw), but T200 still surfaced
    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs).toHaveLength(0);
    expect(briefing.docsContext!.relatedDocs).toHaveLength(1);
    expect(briefing.docsContext!.relatedDocs[0].attachmentId).toBe('att-ok');
  });

  it('omits description and labels when not present on attachment', async () => {
    const attachment = makeAttachmentMeta({ id: 'att-bare', kind: 'blob' });
    // Remove description and labels explicitly
    (attachment.attachment as Record<string, unknown>)['description'] = undefined;
    (attachment.attachment as Record<string, unknown>)['labels'] = undefined;

    mockListByOwner.mockResolvedValue([attachment]);

    setupMockAccessor(
      [{ id: 'T100', status: 'active', title: 'Task', priority: 'medium' }],
      'T100',
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    const ref = briefing.docsContext!.currentTaskDocs[0];
    expect(ref).toBeDefined();
    expect(ref.description).toBeUndefined();
    expect(ref.labels).toBeUndefined();
  });

  it('works when no task is focused — only relatedDocs populated', async () => {
    const attachment = makeAttachmentMeta({ id: 'att-unfocused', kind: 'url' });

    mockListByOwner.mockImplementation(async (_ownerType: string, ownerId: string) => {
      if (ownerId === 'T300') return [attachment];
      return [];
    });

    setupMockAccessor(
      [{ id: 'T300', status: 'pending', title: 'Some task', priority: 'medium' }],
      null, // no focus
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.docsContext).toBeDefined();
    expect(briefing.docsContext!.currentTaskDocs).toHaveLength(0);
    expect(briefing.docsContext!.relatedDocs).toHaveLength(1);
    expect(briefing.docsContext!.totalDocs).toBe(1);
  });
});
