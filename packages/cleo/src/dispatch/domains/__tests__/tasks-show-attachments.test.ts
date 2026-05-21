/**
 * tasks.show — attachments[] surface fix (T9966)
 *
 * Verifies that `cleo show <taskId>` always returns an `attachments[]` array
 * (never null) in the response envelope. Three scenarios:
 *   - Task with 0 attachments → `attachments: []`
 *   - Task with 1 attachment  → `attachments: [{ attachmentId, kind }]`
 *   - Task with N attachments → full array with slug/type when present
 *
 * @task T9966
 * @epic T9964
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before imports
// ---------------------------------------------------------------------------

/** Mutable attachment store state — replaced per test. */
const _mockListByOwner =
  vi.fn<
    (
      ownerType: string,
      ownerId: string,
      cwd?: string,
    ) => Promise<
      Array<{
        id: string;
        sha256: string;
        attachment: { kind: string; description?: string };
        createdAt: string;
        refCount: number;
      }>
    >
  >();

const _mockGetExtras =
  vi.fn<
    (id: string, cwd?: string) => Promise<{ slug: string | null; type: string | null } | null>
  >();

vi.mock('@cleocode/core/internal', () => ({
  createAttachmentStore: () => ({
    listByOwner: _mockListByOwner,
    getExtras: _mockGetExtras,
  }),
}));

vi.mock('../../lib/engine.js', () => ({
  taskShow: vi.fn(),
  taskShowWithHistory: vi.fn(),
  taskShowIvtrHistory: vi.fn(),
  taskList: vi.fn(),
  taskFind: vi.fn(),
  taskExists: vi.fn(),
  addTaskWithSessionScope: vi.fn(),
  taskUpdate: vi.fn(),
  taskComplete: vi.fn(),
  completeTaskStrict: vi.fn(),
  taskDelete: vi.fn(),
  taskArchive: vi.fn(),
  taskNext: vi.fn(),
  taskBlockers: vi.fn(),
  taskTree: vi.fn(),
  taskRelates: vi.fn(),
  taskRelatesAdd: vi.fn(),
  taskRelatesRemove: vi.fn(),
  taskAnalyze: vi.fn(),
  taskRestore: vi.fn(),
  taskReorder: vi.fn(),
  taskReparent: vi.fn(),
  taskPromote: vi.fn(),
  taskComplexityEstimate: vi.fn(),
  taskDepends: vi.fn(),
  taskCurrentGet: vi.fn(),
  taskStart: vi.fn(),
  taskStop: vi.fn(),
  taskSyncReconcile: vi.fn(),
  taskSyncLinks: vi.fn(),
  taskSyncLinksRemove: vi.fn(),
  taskHistory: vi.fn(),
  taskWorkHistory: vi.fn(),
  taskLabelList: vi.fn(),
  taskClaim: vi.fn(),
  taskUnclaim: vi.fn(),
  taskRelatesFind: vi.fn(),
  taskCancel: vi.fn(),
  taskReopen: vi.fn(),
  taskUnarchive: vi.fn(),
  taskImpact: vi.fn(),
  taskPlan: vi.fn(),
  taskDepsCycles: vi.fn(),
  taskDepsOverview: vi.fn(),
  taskDepsValidate: vi.fn(),
  taskDepsTree: vi.fn(),
  tasksAddBatchOp: vi.fn(),
}));

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { taskShow } from '../../lib/engine.js';
import { TasksHandler } from '../tasks.js';

// ---------------------------------------------------------------------------
// Minimal task record fixture
// ---------------------------------------------------------------------------

const BASE_TASK = {
  id: 'T9831',
  title: 'SG-ARCH-SOLID',
  description: 'test',
  status: 'pending',
  priority: 'medium',
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tasks.show — attachments[] surface (T9966)', () => {
  let handler: TasksHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TasksHandler();
    // Default: taskShow returns a minimal success result
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: BASE_TASK, view: null },
    });
  });

  // -----------------------------------------------------------------------
  // AC2: empty array when no attachments (never null)
  // -----------------------------------------------------------------------

  describe('AC2: empty array when no attachments', () => {
    it('returns attachments: [] when task has no docs attached', async () => {
      _mockListByOwner.mockResolvedValue([]);

      const result = await handler.query('show', { taskId: 'T9831' });

      expect(result.success).toBe(true);
      const data = result.data as { attachments: unknown[] };
      expect(Array.isArray(data.attachments)).toBe(true);
      expect(data.attachments).toHaveLength(0);
    });

    it('attachments field is never null — always an array', async () => {
      _mockListByOwner.mockResolvedValue([]);

      const result = await handler.query('show', { taskId: 'T1234' });

      const data = result.data as { attachments: unknown };
      expect(data.attachments).not.toBeNull();
      expect(data.attachments).not.toBeUndefined();
    });

    it('still returns attachments: [] when attachment store throws', async () => {
      _mockListByOwner.mockRejectedValue(new Error('DB not initialised'));

      const result = await handler.query('show', { taskId: 'T9831' });

      // show must succeed; store errors are silently swallowed
      expect(result.success).toBe(true);
      const data = result.data as { attachments: unknown[] };
      expect(Array.isArray(data.attachments)).toBe(true);
      expect(data.attachments).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // AC1: attachment entries carry {attachmentId, kind, slug?, type?}
  // -----------------------------------------------------------------------

  describe('AC1: attachment entries include required fields', () => {
    it('returns one entry with attachmentId and kind when no extras', async () => {
      _mockListByOwner.mockResolvedValue([
        {
          id: 'att_abc123',
          sha256: 'aabbccdd',
          attachment: { kind: 'local-file' },
          createdAt: '2026-05-21T00:00:00.000Z',
          refCount: 1,
        },
      ]);
      _mockGetExtras.mockResolvedValue({ slug: null, type: null });

      const result = await handler.query('show', { taskId: 'T9831' });

      expect(result.success).toBe(true);
      const data = result.data as { attachments: Array<Record<string, unknown>> };
      expect(data.attachments).toHaveLength(1);
      expect(data.attachments[0]).toMatchObject({
        attachmentId: 'att_abc123',
        kind: 'local-file',
      });
      // No slug/type when not set
      expect(data.attachments[0]).not.toHaveProperty('slug');
      expect(data.attachments[0]).not.toHaveProperty('type');
    });

    it('includes slug and type in entry when attachment has extras', async () => {
      _mockListByOwner.mockResolvedValue([
        {
          id: 'att_xyz789',
          sha256: 'deadbeef',
          attachment: { kind: 'local-file' },
          createdAt: '2026-05-21T00:00:00.000Z',
          refCount: 1,
        },
      ]);
      _mockGetExtras.mockResolvedValue({ slug: 'sg-arch-solid-master-plan', type: 'research' });

      const result = await handler.query('show', { taskId: 'T9831' });

      const data = result.data as { attachments: Array<Record<string, unknown>> };
      expect(data.attachments[0]).toMatchObject({
        attachmentId: 'att_xyz789',
        kind: 'local-file',
        slug: 'sg-arch-solid-master-plan',
        type: 'research',
      });
    });

    it('returns N entries for N attachments with correct data', async () => {
      _mockListByOwner.mockResolvedValue([
        {
          id: 'att_001',
          sha256: 'aaa',
          attachment: { kind: 'local-file' },
          createdAt: '2026-05-21T00:00:00.000Z',
          refCount: 1,
        },
        {
          id: 'att_002',
          sha256: 'bbb',
          attachment: { kind: 'url' },
          createdAt: '2026-05-20T00:00:00.000Z',
          refCount: 2,
        },
      ]);
      _mockGetExtras
        .mockResolvedValueOnce({ slug: 'sg-arch-solid-session-1-handoff', type: 'handoff' })
        .mockResolvedValueOnce({ slug: null, type: null });

      const result = await handler.query('show', { taskId: 'T9831' });

      const data = result.data as { attachments: Array<Record<string, unknown>> };
      expect(data.attachments).toHaveLength(2);
      expect(data.attachments[0]).toMatchObject({
        attachmentId: 'att_001',
        kind: 'local-file',
        slug: 'sg-arch-solid-session-1-handoff',
        type: 'handoff',
      });
      expect(data.attachments[1]).toMatchObject({
        attachmentId: 'att_002',
        kind: 'url',
      });
      expect(data.attachments[1]).not.toHaveProperty('slug');
    });
  });

  // -----------------------------------------------------------------------
  // Core task data is still returned correctly
  // -----------------------------------------------------------------------

  describe('task data integrity', () => {
    it('still includes task and view fields alongside attachments', async () => {
      _mockListByOwner.mockResolvedValue([]);

      const result = await handler.query('show', { taskId: 'T9831' });

      const data = result.data as Record<string, unknown>;
      expect(data).toHaveProperty('task');
      expect(data).toHaveProperty('view');
      expect(data).toHaveProperty('attachments');
    });

    it('passes taskId to the attachment store listByOwner with ownerType=task', async () => {
      _mockListByOwner.mockResolvedValue([]);

      await handler.query('show', { taskId: 'T9831' });

      expect(_mockListByOwner).toHaveBeenCalledWith('task', 'T9831', '/mock/project');
    });

    it('propagates core task-not-found errors without calling attachment store', async () => {
      vi.mocked(taskShow).mockResolvedValue({
        success: false,
        error: { code: 'E_NOT_FOUND', message: 'Task not found: T9999' },
      });

      const result = await handler.query('show', { taskId: 'T9999' });

      expect(result.success).toBe(false);
    });

    it('ivtr-history path still delegates to taskShowIvtrHistory (no attachment injection)', async () => {
      const { taskShowIvtrHistory } = await import('../../lib/engine.js');
      vi.mocked(taskShowIvtrHistory).mockResolvedValue({
        success: true,
        data: { ivtrHistory: [] },
      });

      const result = await handler.query('show', { taskId: 'T9831', ivtrHistory: true });

      expect(result.success).toBe(true);
      // ivtrHistory path bypasses attachment fetch
      expect(_mockListByOwner).not.toHaveBeenCalled();
    });
  });
});
