/**
 * Tests for T1858: `cleo orchestrate ready` dep-graph validation guard.
 *
 * Tests the pre-validation step added to `orchestrateReady()` which respects
 * `LifecycleConfig.mode` (strict / advisory / off) and the CLI-only
 * `--ignore-deps-validate` bypass flag.
 *
 * Four cases:
 *  1. invalid dep-graph + strict mode  → E_DEP_GRAPH_INVALID error (no ready set)
 *  2. valid dep-graph               → proceeds normally to ready set
 *  3. --ignore-deps-validate (CLI)  → bypass + audit entry written
 *  4. sentient mode                 → no bypass parameter available; strict enforced
 *
 * All tests call `orchestrateReady()` directly from `@cleocode/core/internal`,
 * mocking the heavy dependencies (DB accessor, config) to avoid SQLite.
 *
 * @task T1858
 * @epic T1855
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE, orchestrateReady } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted before imports by vitest
// ---------------------------------------------------------------------------

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../../../core/src/store/file-utils.js', () => ({
  resolveProjectRoot: vi.fn(() => '/tmp/test-project-root'),
}));

vi.mock('../../../../../core/src/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../../../core/src/orchestration/index.js', () => ({
  getReadyTasks: vi.fn(),
  analyzeEpic: vi.fn(),
  getNextTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks are set up
// ---------------------------------------------------------------------------

import { loadConfig } from '../../../../../core/src/config.js';
import { getReadyTasks } from '../../../../../core/src/orchestration/index.js';
import { getAccessor } from '../../../../../core/src/store/data-accessor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Task with sensible defaults. */
function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: `Description for ${overrides.title}`,
    status: 'pending',
    priority: 'medium',
    type: 'task',
    createdAt: new Date().toISOString(),
    depends: [],
    ...overrides,
  } as Task;
}

function makeEpic(overrides: Partial<Task> & { id: string; title: string }): Task {
  return makeTask({ type: 'epic', ...overrides });
}

/** A minimal task set that passes dep-graph validation: epic with two children, no issues. */
function validTaskSet(epicId = 'E001'): Task[] {
  return [
    makeEpic({ id: epicId, title: 'Test Epic' }),
    makeTask({ id: 'T001', title: 'Child 1', parentId: epicId }),
    makeTask({ id: 'T002', title: 'Child 2', parentId: epicId, depends: ['T001'] }),
  ];
}

/**
 * A task set that fails dep-graph validation with a circular dependency.
 *
 * Uses a circular dep (T_A1 → T_A2 → T_A1) rather than a cross-epic gap
 * because E_CIRCULAR issues survive the scope-aware filter (they only involve
 * tasks within the epic) whereas cross-epic gap detection drops tasks that are
 * outside the scoped task map.
 */
function invalidTaskSet(epicId = 'E001'): Task[] {
  return [
    makeEpic({ id: epicId, title: 'Epic A' }),
    makeTask({ id: 'T_A1', title: 'Child 1', parentId: epicId, depends: ['T_A2'] }),
    makeTask({ id: 'T_A2', title: 'Child 2', parentId: epicId, depends: ['T_A1'] }),
  ];
}

/** Stub `getReadyTasks` to return one ready task. */
function stubReadyTasks(epicId: string): void {
  vi.mocked(getReadyTasks).mockResolvedValue([
    {
      taskId: 'T001',
      title: 'Child 1',
      ready: true,
      blockers: [],
      epicId,
    },
  ] as ReturnType<typeof getReadyTasks> extends Promise<infer R> ? R : never);
}

/** Stub `getAccessor` to return a minimal no-op stub. */
function stubAccessor(): void {
  vi.mocked(getAccessor).mockResolvedValue(
    {} as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never,
  );
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-t1858-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 1: invalid dep-graph + strict mode → E_DEP_GRAPH_INVALID
// ---------------------------------------------------------------------------

describe('orchestrateReady — dep-graph guard', () => {
  it('1. returns E_DEP_GRAPH_INVALID when graph is invalid and mode is strict', async () => {
    const tasks = invalidTaskSet('E001');
    // loadTasks is called via getAccessor + accessor.queryTasks — but orchestrateReady
    // also calls loadTasks(root) directly. We mock getAccessor to supply the task list
    // via the internal loadTasks path by making the accessor return the task set.
    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    const result = await orchestrateReady('E001', tmpDir);

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string; details?: unknown } }).error;
    expect(error.code).toBe('E_DEP_GRAPH_INVALID');
    expect(error.details).toBeDefined();
    // The error details must include issues
    const details = error.details as { issueCount: number; issues: unknown[] };
    expect(details.issueCount).toBeGreaterThan(0);
    expect(details.issues.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Case 2: valid dep-graph → proceeds to return ready set
  // -------------------------------------------------------------------------

  it('2. returns ready set when dep-graph is valid (strict mode)', async () => {
    const tasks = validTaskSet('E001');

    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    stubReadyTasks('E001');

    const result = await orchestrateReady('E001', tmpDir);

    expect(result.success).toBe(true);
    const data = (result as { data: { epicId: string; total: number } }).data;
    expect(data.epicId).toBe('E001');
    expect(data.total).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Case 3: --ignore-deps-validate → bypass + audit entry written
  // -------------------------------------------------------------------------

  it('3. bypasses validation and writes audit entry when ignoreDepsValidate is true', async () => {
    const tasks = invalidTaskSet('E001');

    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    stubReadyTasks('E001');

    const result = await orchestrateReady('E001', tmpDir, { ignoreDepsValidate: true });

    // Should succeed despite invalid graph
    expect(result.success).toBe(true);

    // Audit log must have been written
    const auditPath = join(tmpDir, ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(true);

    const content = readFileSync(auditPath, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as {
      ts: string;
      epicId: string;
      source: string;
      issueCount: number;
      issues: unknown[];
    };
    expect(entry.epicId).toBe('E001');
    expect(entry.source).toBe('cli');
    expect(entry.issueCount).toBeGreaterThan(0);
    expect(Array.isArray(entry.issues)).toBe(true);
    // timestamp must be ISO-8601
    expect(() => new Date(entry.ts).toISOString()).not.toThrow();
    // Each issue must have code and taskId
    const issue = entry.issues[0] as { code: string; taskId: string };
    expect(typeof issue.code).toBe('string');
    expect(typeof issue.taskId).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Case 4: sentient mode — no bypass available; strict mode is enforced
  // -------------------------------------------------------------------------

  it('4. sentient (programmatic) call — no ignoreDepsValidate, strict mode enforced', async () => {
    // Sentient callers call orchestrateReady without opts (or with opts = undefined).
    // The guard must still enforce strict mode — this test verifies the function
    // rejects an invalid graph even with no opts argument (simulates sentient path).
    const tasks = invalidTaskSet('E001');

    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    // No opts — simulates a programmatic sentient caller (no bypass available)
    const result = await orchestrateReady('E001', tmpDir /* no opts */);

    expect(result.success).toBe(false);
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe('E_DEP_GRAPH_INVALID');

    // No audit entry written (bypass was not requested)
    const auditPath = join(tmpDir, ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Advisory mode: warn + proceed even on invalid graph
// ---------------------------------------------------------------------------

describe('orchestrateReady — advisory mode', () => {
  it('proceeds with a depsWarning when graph is invalid and mode is advisory', async () => {
    const tasks = invalidTaskSet('E001');

    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'advisory' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    stubReadyTasks('E001');

    const result = await orchestrateReady('E001', tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as { depsWarning?: string };
    expect(data.depsWarning).toBeDefined();
    expect(typeof data.depsWarning).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Off mode: skip validation entirely
// ---------------------------------------------------------------------------

describe('orchestrateReady — off mode', () => {
  it('proceeds without validation when mode is off', async () => {
    const tasks = invalidTaskSet('E001');

    vi.mocked(loadConfig).mockResolvedValue({
      lifecycle: { mode: 'off' },
    } as ReturnType<typeof loadConfig> extends Promise<infer R> ? R : never);

    vi.mocked(getAccessor).mockResolvedValue({
      queryTasks: vi.fn().mockResolvedValue({ tasks }),
    } as ReturnType<typeof getAccessor> extends Promise<infer R> ? R : never);

    stubReadyTasks('E001');

    const result = await orchestrateReady('E001', tmpDir);

    expect(result.success).toBe(true);
    // No depsWarning in off mode
    const data = result.data as { depsWarning?: string };
    expect(data.depsWarning).toBeUndefined();
  });
});
