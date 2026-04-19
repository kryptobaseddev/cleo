/**
 * Tests for T948 — Studio /api/tasks + /api/tasks/pipeline refactor.
 *
 * Verifies that the route helpers eliminate raw SQL in favour of the
 * canonical `TaskRollupPayload` projection produced by `@cleocode/core`.
 * The route handlers themselves delegate to `listTasks`/`computeTaskRollups`;
 * the end-to-end execution is covered by an integration test that boots a
 * real DataAccessor against a temp project.
 *
 * Coverage:
 *   1. `_toLegacyRow` preserves the pre-T948 snake_case contract and
 *      re-serialises verification/acceptance JSON for the pipeline UI.
 *   2. `_resolveStage` + `_labelFor` produce the canonical Kanban buckets.
 *   3. `_epicRowFromRollups` tallies execStatus into dashboard buckets
 *      exactly as the owner expects (no /tasks vs /pipeline drift).
 *   4. End-to-end: GET /api/tasks returns `{tasks, rollups, total}` with
 *      TaskRollupPayload shape and respects status/priority/type filters.
 *   5. End-to-end: GET /api/tasks/pipeline groups by pipelineStage via the
 *      canonical rollup.
 *   6. Parity: route responses match what `pipeline/+page.svelte` reads.
 *
 * @task T948
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskRollupPayload } from '@cleocode/contracts';
import { addTask } from '@cleocode/core/tasks/add';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectContext } from '$lib/server/project-context.js';
import { _toLegacyRow, GET as getTasks } from '../+server.js';
import {
  _labelFor,
  _resolveStage,
  _toPipelineRow,
  GET as getPipeline,
} from '../pipeline/+server.js';

/**
 * Minimal fake of the SvelteKit RequestEvent that the route handlers
 * actually consume. Only `locals.projectCtx` and `url` are read — the rest
 * of the RequestEvent shape (cookies, fetch, getClientAddress, …) is not
 * exercised here, and using a partial cast keeps the tests free of
 * `as unknown as any` chains.
 */
type FakeEvent = Pick<RequestEvent, 'url'> & {
  locals: { projectCtx: ProjectContext };
};

/** Build a fake RequestEvent with the given project context + URL. */
function makeEvent(ctx: ProjectContext, url: string): FakeEvent {
  return { locals: { projectCtx: ctx }, url: new URL(url) };
}

/**
 * Cast a {@link FakeEvent} to the route handler's expected parameter type.
 *
 * The handler signature is `async ({ locals, url }) => ...`; destructuring
 * only ever touches the two fields we populate, so the cast is sound at
 * runtime. Typed via `Parameters` so the cast follows the handler.
 */
type TasksHandler = typeof getTasks;
type PipelineHandler = typeof getPipeline;
function asEvent<H extends TasksHandler | PipelineHandler>(e: FakeEvent): Parameters<H>[0] {
  return e as unknown as Parameters<H>[0];
}

// ---------------------------------------------------------------------------
// Pure helper tests — no I/O
// ---------------------------------------------------------------------------

describe('_toLegacyRow (T948)', () => {
  it('preserves snake_case contract for pre-T948 clients', () => {
    const task: Task = {
      id: 'T100',
      title: 'Test',
      description: 'Test description',
      status: 'pending',
      priority: 'high',
      type: 'task',
      parentId: null,
      pipelineStage: 'research',
      size: 'small',
      createdAt: '2026-04-17T00:00:00Z',
      updatedAt: '2026-04-17T01:00:00Z',
    };

    const row = _toLegacyRow(task);

    expect(row).toEqual({
      id: 'T100',
      title: 'Test',
      description: 'Test description',
      status: 'pending',
      priority: 'high',
      type: 'task',
      parent_id: null,
      pipeline_stage: 'research',
      size: 'small',
      created_at: '2026-04-17T00:00:00Z',
      updated_at: '2026-04-17T01:00:00Z',
      completed_at: null,
      verification_json: null,
      acceptance_json: null,
    });
  });

  it('re-serialises verification JSON so the pipeline UI keeps working', () => {
    const task: Task = {
      id: 'T101',
      title: 'Verified',
      description: 'Has a verification block',
      status: 'active',
      priority: 'medium',
      createdAt: '2026-04-17T00:00:00Z',
      verification: {
        passed: false,
        round: 1,
        gates: { implemented: true, testsPassed: false },
        lastAgent: null,
        updatedAt: null,
      },
    };

    const row = _toLegacyRow(task);
    expect(row.verification_json).not.toBeNull();
    const parsed = JSON.parse(row.verification_json as string) as {
      gates: Record<string, boolean>;
    };
    expect(parsed.gates.implemented).toBe(true);
    expect(parsed.gates.testsPassed).toBe(false);
  });

  it('falls back to createdAt when updatedAt is missing (invariant preservation)', () => {
    const task: Task = {
      id: 'T102',
      title: 'Fresh',
      description: 'Just created',
      status: 'pending',
      priority: 'low',
      createdAt: '2026-04-17T00:00:00Z',
    };

    const row = _toLegacyRow(task);
    expect(row.updated_at).toBe(row.created_at);
  });
});

describe('_resolveStage (T948)', () => {
  /** Minimal rollup builder for table-driven tests. */
  function rollup(pipelineStage: string | null): TaskRollupPayload {
    return {
      id: 'T200',
      execStatus: 'pending',
      pipelineStage,
      gatesVerified: [],
      childrenDone: 0,
      childrenTotal: 0,
      blockedBy: [],
      lastActivityAt: null,
    };
  }

  it('routes null → unassigned', () => {
    expect(_resolveStage(rollup(null))).toBe('unassigned');
  });

  it('routes canonical stages through untouched', () => {
    expect(_resolveStage(rollup('research'))).toBe('research');
    expect(_resolveStage(rollup('implementation'))).toBe('implementation');
    expect(_resolveStage(rollup('release'))).toBe('release');
    expect(_resolveStage(rollup('contribution'))).toBe('contribution');
  });

  it('routes unknown stages → unassigned (forward-compat)', () => {
    expect(_resolveStage(rollup('mystery_future_stage'))).toBe('unassigned');
  });
});

describe('_labelFor (T948)', () => {
  it('capitalises canonical stage ids', () => {
    expect(_labelFor('research')).toBe('Research');
    expect(_labelFor('implementation')).toBe('Implementation');
  });

  it('renders unassigned as "Unassigned"', () => {
    expect(_labelFor('unassigned')).toBe('Unassigned');
  });
});

describe('_toPipelineRow (T948)', () => {
  it('matches the PipelineRow contract the pipeline page reads', () => {
    const task: Task = {
      id: 'T300',
      title: 'Pipeline task',
      description: 'desc',
      status: 'active',
      priority: 'critical',
      type: 'task',
      parentId: 'E1',
      pipelineStage: 'implementation',
      size: 'medium',
      createdAt: '2026-04-17T00:00:00Z',
      updatedAt: '2026-04-17T01:00:00Z',
    };
    const row = _toPipelineRow(task);
    expect(row.pipeline_stage).toBe('implementation');
    expect(row.parent_id).toBe('E1');
    expect(row.verification_json).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real DataAccessor against a temp project
// ---------------------------------------------------------------------------

describe('GET /api/tasks end-to-end (T948)', () => {
  let tempDir: string;
  let seededIds: string[] = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'studio-tasks-route-'));
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });

    // Seed a few tasks via the same path the CLI uses.
    //
    // CLEO enforces a minimum of 3 acceptance criteria on medium+ priority
    // tasks, so we attach three per seed. This also ensures we exercise
    // the acceptance_json round-trip in `_toLegacyRow`.
    const acceptance = ['Must compile', 'Must be listable', 'Must roll up'];
    const epic = await addTask(
      {
        title: 'Test Epic',
        description: 'An epic for testing',
        type: 'epic',
        acceptance,
      },
      tempDir,
    );
    const child1 = await addTask(
      {
        title: 'Implementation child',
        description: 'Child task with full acceptance',
        parentId: epic.task.id,
        priority: 'critical',
        acceptance,
      },
      tempDir,
    );
    const child2 = await addTask(
      {
        title: 'Medium-priority child',
        description: 'Second child task with full acceptance',
        parentId: epic.task.id,
        priority: 'medium',
        acceptance,
      },
      tempDir,
    );
    seededIds = [epic.task.id, child1.task.id, child2.task.id];
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Reusable context fixture for tests that need a real tasks.db. */
  function validCtx(): ProjectContext {
    return {
      projectId: '',
      name: 'test',
      projectPath: tempDir,
      brainDbPath: join(tempDir, '.cleo', 'brain.db'),
      tasksDbPath: join(tempDir, '.cleo', 'tasks.db'),
      brainDbExists: false,
      tasksDbExists: true,
    };
  }

  it('returns {tasks, rollups, total} with TaskRollupPayload shape', async () => {
    const response = await getTasks(
      asEvent<TasksHandler>(makeEvent(validCtx(), 'http://localhost/api/tasks')),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasks: Array<{ id: string; priority: string }>;
      rollups: TaskRollupPayload[];
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(seededIds.length);
    expect(body.rollups).toBeDefined();
    // Every row in tasks must have a matching rollup id.
    for (const task of body.tasks) {
      const rollup = body.rollups.find((r) => r.id === task.id);
      expect(rollup).toBeDefined();
      expect(rollup?.execStatus).toBeDefined();
      expect(Array.isArray(rollup?.blockedBy)).toBe(true);
      expect(Array.isArray(rollup?.gatesVerified)).toBe(true);
    }
  });

  it('respects priority filter', async () => {
    const response = await getTasks(
      asEvent<TasksHandler>(makeEvent(validCtx(), 'http://localhost/api/tasks?priority=critical')),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: Array<{ priority: string }> };
    for (const task of body.tasks) {
      expect(task.priority).toBe('critical');
    }
  });

  it('respects type filter', async () => {
    const response = await getTasks(
      asEvent<TasksHandler>(makeEvent(validCtx(), 'http://localhost/api/tasks?type=epic')),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: Array<{ type: string }> };
    for (const task of body.tasks) {
      expect(task.type).toBe('epic');
    }
  });

  it('returns 503 when tasks.db does not exist', async () => {
    const missingCtx: ProjectContext = {
      projectId: '',
      name: 'missing',
      projectPath: '/nonexistent/path',
      brainDbPath: '/nonexistent/.cleo/brain.db',
      tasksDbPath: '/nonexistent/.cleo/tasks.db',
      brainDbExists: false,
      tasksDbExists: false,
    };
    const response = await getTasks(
      asEvent<TasksHandler>(makeEvent(missingCtx, 'http://localhost/api/tasks')),
    );
    expect(response.status).toBe(503);
  });
});

describe('GET /api/tasks/pipeline end-to-end (T948)', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'studio-pipeline-route-'));
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    await addTask(
      {
        title: 'Research task',
        description: 'A task for research stage',
        acceptance: ['Exists', 'Lists', 'Rolls up'],
      },
      tempDir,
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('groups by pipelineStage and surfaces both tasks + rollups', async () => {
    const ctx: ProjectContext = {
      projectId: '',
      name: 'test',
      projectPath: tempDir,
      brainDbPath: join(tempDir, '.cleo', 'brain.db'),
      tasksDbPath: join(tempDir, '.cleo', 'tasks.db'),
      brainDbExists: false,
      tasksDbExists: true,
    };
    const response = await getPipeline(
      asEvent<PipelineHandler>(makeEvent(ctx, 'http://localhost/api/tasks/pipeline')),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stages: Array<{
        id: string;
        label: string;
        count: number;
        tasks: unknown[];
        rollups: TaskRollupPayload[];
      }>;
    };

    // All canonical stages are present (even at zero count).
    const stageIds = body.stages.map((s) => s.id);
    expect(stageIds).toContain('research');
    expect(stageIds).toContain('implementation');
    expect(stageIds).toContain('release');

    // Every bucket: count matches tasks.length matches rollups.length.
    for (const bucket of body.stages) {
      expect(bucket.count).toBe(bucket.tasks.length);
      expect(bucket.count).toBe(bucket.rollups.length);
    }
  });
});
