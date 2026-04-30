/**
 * Unit tests for the parent-epic lifecycle gate in taskCompleteStrict (T788).
 *
 * Verifies that when lifecycle.mode === 'strict' AND a child task's parent is
 * an epic AND the epic's pipelineStage is in the planning set
 * (research | consensus | architecture_decision | specification | decomposition),
 * cleo complete <childId> rejects with E_LIFECYCLE_GATE_FAILED (exit code 80).
 *
 * Also verifies:
 * - Advisory mode logs a warning but proceeds.
 * - Tasks with no parent skip the gate entirely.
 * - Tasks whose parent is not an epic skip the gate.
 * - Tasks whose parent epic is in implementation or later are allowed through.
 *
 * As of T832 / ADR-051, the `--force` bypass has been REMOVED.  Tasks cannot
 * be completed with a research-stage parent epic via any bypass path.
 *
 * @task T788
 * @task T832
 * @adr ADR-051
 * @epic T769
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Source-level mocks — completeTaskStrict imports from relative paths in core,
// not through @cleocode/core/internal. We mock those source modules directly.
// ---------------------------------------------------------------------------

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../../../core/src/lifecycle/ivtr-loop.js', () => ({
  getIvtrState: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../../core/src/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ lifecycle: { mode: 'strict' } }),
  getRawConfigValue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../core/src/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../../../core/src/tasks/evidence.js', () => ({
  revalidateEvidence: vi.fn().mockResolvedValue({ stillValid: true, failedAtoms: [] }),
  parseEvidence: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadConfig } from '../../../../../core/src/config.js';
import { getIvtrState } from '../../../../../core/src/lifecycle/ivtr-loop.js';
import { getAccessor } from '../../../../../core/src/store/data-accessor.js';
import { completeTaskStrict } from '../../../../../core/src/tasks/complete.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DataAccessor mock for a given child + optional parent. */
function makeAccessorMock(opts: {
  child: {
    id: string;
    parentId: string | null | undefined;
    verification?: Record<string, unknown> | null;
  };
  parent?: {
    id: string;
    type: string;
    pipelineStage: string | null | undefined;
  } | null;
  upsertSingleTask?: ReturnType<typeof vi.fn>;
}) {
  const upsert = opts.upsertSingleTask ?? vi.fn().mockResolvedValue(undefined);
  return {
    loadSingleTask: vi.fn(async (id: string) => {
      if (id === opts.child.id) {
        return {
          id: opts.child.id,
          title: 'Child task',
          description: '',
          status: 'active',
          priority: 'medium',
          type: 'task',
          parentId: opts.child.parentId ?? null,
          verification: opts.child.verification ?? null,
          pipelineStage: 'implementation',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      if (opts.parent && id === opts.parent.id) {
        return {
          id: opts.parent.id,
          title: 'Parent epic',
          description: 'An epic',
          status: 'active',
          priority: 'high',
          type: opts.parent.type,
          parentId: null,
          pipelineStage: opts.parent.pipelineStage ?? null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    }),
    upsertSingleTask: upsert,
  };
}

const PROJECT_ROOT = '/mock/project';
const CHILD_ID = 'T200';
const EPIC_ID = 'T100';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('taskCompleteStrict — parent-epic lifecycle gate (T788)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no IVTR state (gate passes the IVTR check)
    vi.mocked(getIvtrState).mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // Strict mode — planning stages must reject
  // -------------------------------------------------------------------------

  describe('strict mode + parent epic in planning stage', () => {
    const planningStages = [
      'research',
      'consensus',
      'architecture_decision',
      'specification',
      'decomposition',
    ] as const;

    for (const stage of planningStages) {
      it(`rejects with E_LIFECYCLE_GATE_FAILED when epic is at '${stage}'`, async () => {
        vi.mocked(loadConfig).mockResolvedValue({
          lifecycle: { mode: 'strict' },
        } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

        vi.mocked(getAccessor).mockResolvedValue(
          makeAccessorMock({
            child: { id: CHILD_ID, parentId: EPIC_ID },
            parent: { id: EPIC_ID, type: 'epic', pipelineStage: stage },
          }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
        );

        const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
        expect(result.error?.exitCode).toBe(80);
        expect(result.error?.message).toContain(CHILD_ID);
        expect(result.error?.message).toContain(EPIC_ID);
        expect(result.error?.message).toContain(stage);
        expect((result.error?.details as Record<string, unknown>)?.['epicStage']).toBe(stage);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Strict mode — implementation or later must pass through
  // -------------------------------------------------------------------------

  describe('strict mode + parent epic in implementation or later', () => {
    const allowedStages = ['implementation', 'validation', 'testing', 'release'] as const;

    for (const stage of allowedStages) {
      it(`allows completion when epic is at '${stage}'`, async () => {
        vi.mocked(loadConfig).mockResolvedValue({
          lifecycle: { mode: 'strict' },
        } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

        vi.mocked(getAccessor).mockResolvedValue(
          makeAccessorMock({
            child: { id: CHILD_ID, parentId: EPIC_ID },
            parent: { id: EPIC_ID, type: 'epic', pipelineStage: stage },
          }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
        );

        const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

        // Should NOT fail with E_LIFECYCLE_GATE_FAILED — may still fail at other gates or succeed
        if (!result.success) {
          expect(result.error?.code).not.toBe('E_LIFECYCLE_GATE_FAILED');
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Advisory mode — planning stage should warn but not reject
  // -------------------------------------------------------------------------

  it('advisory mode: warns but does not reject when epic is in planning stage', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'advisory' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorMock({
        child: { id: CHILD_ID, parentId: EPIC_ID },
        parent: { id: EPIC_ID, type: 'epic', pipelineStage: 'research' },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

    // In advisory mode the gate must not reject with E_LIFECYCLE_GATE_FAILED
    if (!result.success) {
      expect(result.error?.code).not.toBe('E_LIFECYCLE_GATE_FAILED');
    }
  });

  // -------------------------------------------------------------------------
  // Off mode — no gate check at all
  // -------------------------------------------------------------------------

  it('off mode: skips the lifecycle gate entirely', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'off' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorMock({
        child: { id: CHILD_ID, parentId: EPIC_ID },
        parent: { id: EPIC_ID, type: 'epic', pipelineStage: 'research' },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

    if (!result.success) {
      expect(result.error?.code).not.toBe('E_LIFECYCLE_GATE_FAILED');
    }
  });

  // -------------------------------------------------------------------------
  // No parent — gate is skipped
  // -------------------------------------------------------------------------

  it('skips gate when child has no parent', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorMock({
        child: { id: CHILD_ID, parentId: null },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

    if (!result.success) {
      expect(result.error?.code).not.toBe('E_LIFECYCLE_GATE_FAILED');
    }
  });

  // -------------------------------------------------------------------------
  // Parent is not an epic — gate is skipped
  // -------------------------------------------------------------------------

  it('skips gate when parent is a task (not an epic)', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorMock({
        child: { id: CHILD_ID, parentId: EPIC_ID },
        parent: { id: EPIC_ID, type: 'task', pipelineStage: 'research' },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

    if (!result.success) {
      expect(result.error?.code).not.toBe('E_LIFECYCLE_GATE_FAILED');
    }
  });

  // -------------------------------------------------------------------------
  // T832 / ADR-051: --force has been removed.  taskCompleteStrict no longer
  // accepts a `force` parameter.  The dispatch layer rejects `force` in its
  // request params with E_FLAG_REMOVED (see tasks.test.ts).  Here we simply
  // verify the engine signature rejects the previous bypass path.
  // -------------------------------------------------------------------------

  it('rejects parent-epic gate even when extra args are passed (T832)', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);

    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorMock({
        child: { id: CHILD_ID, parentId: EPIC_ID, verification: null },
        parent: { id: EPIC_ID, type: 'epic', pipelineStage: 'research' },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    // Current signature: taskCompleteStrict(projectRoot, taskId, notes?).
    // Passing extra args is a compile-time error; at runtime the gate STILL
    // rejects research-stage parent epics.
    const result = await completeTaskStrict(PROJECT_ROOT, CHILD_ID);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
    expect(result.error?.fix).toContain('lifecycle complete');
  });
});
