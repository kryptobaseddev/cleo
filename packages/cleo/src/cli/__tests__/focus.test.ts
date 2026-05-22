/**
 * Tests for `cleo focus` — single-envelope task orientation.
 *
 * Covers three scope types:
 *   1. Task scope  — focus on a task (T####)
 *   2. Epic scope  — focus on an Epic
 *   3. Saga scope  — focus on a Saga (with members)
 *
 * Registry and CLI-shape tests are pure (no DB). Handler unit-tests use
 * `vi.mock` at the module level (hoisted by Vitest) so they do not touch
 * any real database.
 *
 * @task T9973
 * @epic T9964 E-ORIENT-V2
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by Vitest before any import is resolved)
// ---------------------------------------------------------------------------

// Mock @cleocode/animations (not built in test env — imported by animation-bridge.ts
// which is transitively pulled in by dispatch/adapters/cli.ts → focusCommand).
vi.mock('@cleocode/animations', () => ({
  createAnimateContext: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
  spinnerFrames: {},
}));

// Mock @cleocode/core so CLI imports do not blow up in a non-project context.
vi.mock('@cleocode/core', () => ({
  getProjectRoot: vi.fn().mockReturnValue('/tmp/test-project'),
  pushWarning: vi.fn(),
  getLogger: vi
    .fn()
    .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Provide overrides for @cleocode/core/internal — spread importOriginal so
// every other export (llmList, llmTest, etc.) keeps its real binding.
vi.mock('@cleocode/core/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...actual,
    taskShow: vi.fn(),
    taskRelates: vi.fn(),
    orchestrateReady: vi.fn(),
    createAttachmentStore: vi.fn(),
    memoryFind: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are registered)
// ---------------------------------------------------------------------------

import {
  createAttachmentStore,
  memoryFind,
  orchestrateReady,
  taskRelates,
  taskShow,
} from '@cleocode/core/internal';
import { FocusHandler } from '../../dispatch/domains/focus.js';
import { resolve, validateRequiredParams } from '../../dispatch/registry.js';
import { focusCommand } from '../commands/focus.js';

// ---------------------------------------------------------------------------
// Shared mock store (used by all handler tests)
// ---------------------------------------------------------------------------

const mockStore = {
  listByOwner: vi.fn().mockResolvedValue([]),
  getExtras: vi.fn().mockResolvedValue(null),
};
vi.mocked(createAttachmentStore).mockReturnValue(
  mockStore as ReturnType<typeof createAttachmentStore>,
);

const emptyMemory = { success: true, data: { results: [], total: 0, tokensEstimated: 0 } };
vi.mocked(memoryFind).mockResolvedValue(emptyMemory);

const emptyReady = { success: true, data: { epicId: 'T9964', readyTasks: [], total: 0 } };
vi.mocked(orchestrateReady).mockResolvedValue(emptyReady);

const emptyRelates = { success: true, data: { taskId: 'T9831', relations: [], count: 0 } };
vi.mocked(taskRelates).mockResolvedValue(emptyRelates);

// ---------------------------------------------------------------------------
// Helper: build a minimal task record
// ---------------------------------------------------------------------------

function makeTask(
  overrides: Partial<{
    id: string;
    title: string;
    type: string;
    status: string;
    parentId: string | null;
    labels: string[];
    depends: string[];
    blockedBy: string[];
  }> = {},
) {
  return {
    id: overrides.id ?? 'T9973',
    title: overrides.title ?? 'Test task',
    type: overrides.type ?? 'task',
    status: overrides.status ?? 'active',
    parentId: overrides.parentId ?? null,
    labels: overrides.labels ?? [],
    depends: overrides.depends ?? [],
    blockedBy: overrides.blockedBy ?? [],
  };
}

// ---------------------------------------------------------------------------
// 1. Registry wiring
// ---------------------------------------------------------------------------

describe('focus.show — dispatch registry wiring (T9973)', () => {
  it('focus.show resolves through the dispatch registry', () => {
    const result = resolve('query', 'focus', 'show');
    expect(result, 'focus.show must be registered as a query operation').toBeDefined();
    expect(result!.domain).toBe('focus');
    expect(result!.operation).toBe('show');
  });

  it('focus.show is a tier-0 idempotent query (no session required)', () => {
    const result = resolve('query', 'focus', 'show');
    expect(result).toBeDefined();
    expect(result!.def.gateway).toBe('query');
    expect(result!.def.tier).toBe(0);
    expect(result!.def.idempotent).toBe(true);
    expect(result!.def.sessionRequired).toBe(false);
  });

  it('focus.show requires the id param', () => {
    const result = resolve('query', 'focus', 'show');
    expect(result).toBeDefined();
    const missing = validateRequiredParams(result!.def, {});
    expect(missing).toContain('id');
  });

  it('id param satisfies required params check', () => {
    const result = resolve('query', 'focus', 'show');
    expect(result).toBeDefined();
    const missing = validateRequiredParams(result!.def, { id: 'T9973' });
    expect(missing).toEqual([]);
  });

  it('focus.show does NOT resolve as a mutate', () => {
    const mutate = resolve('mutate', 'focus', 'show');
    expect(mutate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. CLI command shape
// ---------------------------------------------------------------------------

describe('focusCommand — CLI command shape (T9973)', () => {
  it('exports focusCommand as a defined command', () => {
    expect(focusCommand).toBeDefined();
  });

  it('has meta.name === "focus"', () => {
    const meta = typeof focusCommand.meta === 'function' ? focusCommand.meta() : focusCommand.meta;
    expect((meta as { name: string }).name).toBe('focus');
  });

  it('description mentions "single-envelope" or "orientation"', () => {
    const meta = typeof focusCommand.meta === 'function' ? focusCommand.meta() : focusCommand.meta;
    const desc = (meta as { description?: string }).description ?? '';
    expect(desc.toLowerCase()).toMatch(/orientation|single-envelope/);
  });

  it('has a required positional arg "id"', () => {
    const args = focusCommand.args as
      | Record<string, { type?: string; required?: boolean }>
      | undefined;
    expect(args).toBeDefined();
    expect(args!['id']).toBeDefined();
    expect(args!['id'].type).toBe('positional');
    expect(args!['id'].required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. FocusHandler — missing id
// ---------------------------------------------------------------------------

describe('FocusHandler — missing id (T9973)', () => {
  it('returns E_INVALID_INPUT when id is missing', async () => {
    const handler = new FocusHandler();
    const response = await handler.query('show', {});
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// 4. FocusHandler — task scope
// ---------------------------------------------------------------------------

describe('FocusHandler — task scope (T9973)', () => {
  it('returns a complete focus envelope for a valid task', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: {
        task: makeTask({ id: 'T9973', type: 'task', parentId: 'T9964' }),
        view: null,
      },
    });
    vi.mocked(orchestrateReady).mockResolvedValue({
      success: true,
      data: {
        epicId: 'T9964',
        readyTasks: [{ id: 'T9973', title: 'focus macro', priority: 'high', depends: [] }],
        total: 1,
      },
    });

    const handler = new FocusHandler();
    const response = await handler.query('show', { id: 'T9973' });
    expect(response.success).toBe(true);

    const data = response.data as {
      identity: { id: string; type: string };
      scope: { taskId?: string; epicId?: string };
      blockers: unknown[];
      tokensEstimated: number;
      readyWave?: unknown[];
    };

    expect(data.identity.id).toBe('T9973');
    expect(data.identity.type).toBe('task');
    expect(data.scope.taskId).toBe('T9973');
    expect(data.scope.epicId).toBe('T9964');
    expect(Array.isArray(data.blockers)).toBe(true);
    expect(typeof data.tokensEstimated).toBe('number');
    expect(data.tokensEstimated).toBeGreaterThan(0);
    expect(Array.isArray(data.readyWave)).toBe(true);
  });

  it('returns E_NOT_FOUND for an unknown task ID', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Task not found: T0001' },
    });

    const handler = new FocusHandler();
    const response = await handler.query('show', { id: 'T0001' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. FocusHandler — epic scope
// ---------------------------------------------------------------------------

describe('FocusHandler — epic scope (T9973)', () => {
  it('resolves scope.epicId when focused on an Epic directly', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: {
        task: makeTask({ id: 'T9964', title: 'E-ORIENT-V2', type: 'epic', parentId: null }),
        view: null,
      },
    });
    vi.mocked(orchestrateReady).mockResolvedValue({
      success: true,
      data: { epicId: 'T9964', readyTasks: [], total: 0 },
    });

    const handler = new FocusHandler();
    const response = await handler.query('show', { id: 'T9964' });
    expect(response.success).toBe(true);

    const data = response.data as {
      identity: { type: string };
      scope: { epicId?: string; taskId?: string };
    };
    expect(data.identity.type).toBe('epic');
    expect(data.scope.epicId).toBe('T9964');
    expect(data.scope.taskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. FocusHandler — saga scope
// ---------------------------------------------------------------------------

describe('FocusHandler — saga scope (T9973)', () => {
  const SAGA_ID = 'T9831';
  const MEMBER_EPIC_ID = 'T9832';

  it('resolves scope.sagaId and populates members when focused on a Saga', async () => {
    // First call = saga itself; second call = member epic
    vi.mocked(taskShow)
      .mockResolvedValueOnce({
        success: true,
        data: {
          task: makeTask({
            id: SAGA_ID,
            title: 'SG-ARCH-SOLID',
            type: 'epic',
            parentId: null,
            labels: ['saga'],
          }),
          view: null,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          task: makeTask({
            id: MEMBER_EPIC_ID,
            title: 'E-CONTRACTS-FOUNDATION',
            type: 'epic',
            status: 'done',
            parentId: SAGA_ID,
          }),
          view: null,
        },
      });

    vi.mocked(taskRelates).mockResolvedValue({
      success: true,
      data: {
        taskId: SAGA_ID,
        relations: [{ taskId: MEMBER_EPIC_ID, type: 'groups' }],
        count: 1,
      },
    });

    vi.mocked(orchestrateReady).mockResolvedValue({
      success: true,
      data: { epicId: SAGA_ID, readyTasks: [], total: 0 },
    });

    const handler = new FocusHandler();
    const response = await handler.query('show', { id: SAGA_ID });
    expect(response.success).toBe(true);

    const data = response.data as {
      identity: { type: string };
      scope: { sagaId?: string };
      members?: Array<{ epicId: string; status: string }>;
    };

    expect(data.identity.type).toBe('saga');
    expect(data.scope.sagaId).toBe(SAGA_ID);
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members!.some((m) => m.epicId === MEMBER_EPIC_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. FocusHandler — unsupported operations
// ---------------------------------------------------------------------------

describe('FocusHandler — unsupported operations (T9973)', () => {
  it('returns unsupported error for mutate operations', async () => {
    const handler = new FocusHandler();
    const response = await handler.mutate('show', { id: 'T9973' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBeDefined();
  });

  it('getSupportedOperations returns only query:show', () => {
    const handler = new FocusHandler();
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('show');
    expect(ops.mutate).toEqual([]);
  });
});
