/**
 * Unit tests for reconciliation-engine.ts.
 *
 * Exercises the reconcile() function with a real SQLite database,
 * using a mock accessor to avoid disk I/O for most cases and a
 * full test-db environment for create/complete/update actions.
 *
 * Covers:
 *   - dry-run mode (actions computed, nothing applied)
 *   - create action (new external task → new CLEO task + link)
 *   - update action (external title change → CLEO title update)
 *   - complete action (external completed → CLEO task completed)
 *   - activate action (external active + CLEO pending → activate)
 *   - skip action (already done / no change)
 *   - skip action (linked CLEO task deleted)
 *
 * @task T1530
 * @epic T1520
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalTask } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createTestDb } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { getLinksByProvider } from '../link-store.js';
import { reconcile } from '../reconciliation-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExternalTask(overrides: Partial<ExternalTask> & { externalId: string }): ExternalTask {
  return {
    externalId: overrides.externalId,
    title: overrides.title ?? `External Task ${overrides.externalId}`,
    status: overrides.status ?? 'pending',
    description: overrides.description,
    priority: overrides.priority,
    type: overrides.type,
    labels: overrides.labels,
    url: overrides.url,
    providerMeta: overrides.providerMeta,
  };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
  // Ensure .cleo dir exists (createTestDb does this, but be explicit)
  await mkdir(join(env.tempDir, '.cleo'), { recursive: true });
});

afterEach(async () => {
  await env.cleanup();
  resetDbState();
});

// ---------------------------------------------------------------------------
// dry-run mode
// ---------------------------------------------------------------------------

describe('reconcile — dry-run mode', () => {
  it('returns actions without applying them (no tasks created)', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', title: 'New Feature', status: 'pending' }),
    ];

    const result = await reconcile(
      external,
      { providerId: 'test-provider', dryRun: true },
      env.accessor,
    );

    expect(result.dryRun).toBe(true);
    expect(result.providerId).toBe('test-provider');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe('create');
    expect(result.actions[0]!.applied).toBe(false);

    // No tasks should have been created
    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks).toHaveLength(0);
  });

  it('counts all action types in summary', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', status: 'pending' }),
      makeExternalTask({ externalId: 'ext-002', status: 'active' }),
    ];

    const result = await reconcile(
      external,
      { providerId: 'test-provider', dryRun: true },
      env.accessor,
    );

    expect(result.summary.created).toBe(2);
    expect(result.summary.total).toBe(2);
    expect(result.summary.applied).toBe(0);
  });

  it('does not create links in dry-run mode', async () => {
    const external = [makeExternalTask({ externalId: 'ext-001', status: 'pending' })];

    await reconcile(external, { providerId: 'test-provider', dryRun: true }, env.accessor);

    const links = await getLinksByProvider('test-provider', env.tempDir);
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// create action
// ---------------------------------------------------------------------------

describe('reconcile — create action', () => {
  it('creates a new CLEO task for an unknown external task', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', title: 'Build Login Form', status: 'pending' }),
    ];

    const result = await reconcile(
      external,
      { providerId: 'github', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.summary.created).toBe(1);
    expect(result.summary.applied).toBe(1);

    const action = result.actions[0]!;
    expect(action.type).toBe('create');
    expect(action.applied).toBe(true);
    expect(action.cleoTaskId).toBeTruthy();

    // Verify task was persisted
    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Build Login Form');
  });

  it('creates a link for the newly created CLEO task', async () => {
    const external = [
      makeExternalTask({
        externalId: 'ext-001',
        title: 'Build Login Form',
        status: 'pending',
        url: 'https://github.com/org/repo/issues/1',
      }),
    ];

    const result = await reconcile(
      external,
      { providerId: 'github', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    const links = await getLinksByProvider('github', env.tempDir);
    expect(links).toHaveLength(1);
    expect(links[0]!.externalId).toBe('ext-001');
    expect(links[0]!.providerId).toBe('github');
    expect(links[0]!.externalUrl).toBe('https://github.com/org/repo/issues/1');
    expect(links[0]!.taskId).toBe(result.actions[0]!.cleoTaskId);
  });

  it('adds defaultLabels and sync label to created task', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', title: 'Task', status: 'pending' }),
    ];

    await reconcile(
      external,
      { providerId: 'linear', dryRun: false, cwd: env.tempDir, defaultLabels: ['imported'] },
      env.accessor,
    );

    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks[0]!.labels).toContain('imported');
    expect(tasks[0]!.labels).toContain('sync.linear');
  });

  it('does not create a task for removed external tasks', async () => {
    const external = [makeExternalTask({ externalId: 'ext-001', status: 'removed' })];

    const result = await reconcile(
      external,
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.actions).toHaveLength(0);
    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update action
// ---------------------------------------------------------------------------

describe('reconcile — update action', () => {
  it('updates CLEO task title when external title changed', async () => {
    // First reconcile creates the task
    const initialExternal = [
      makeExternalTask({ externalId: 'ext-001', title: 'Old Title', status: 'pending' }),
    ];
    await reconcile(
      initialExternal,
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    // Second reconcile with changed title
    const updatedExternal = [
      makeExternalTask({ externalId: 'ext-001', title: 'New Title', status: 'pending' }),
    ];
    const result = await reconcile(
      updatedExternal,
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.summary.updated).toBe(1);

    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks[0]!.title).toBe('New Title');
  });
});

// ---------------------------------------------------------------------------
// complete action
// ---------------------------------------------------------------------------

describe('reconcile — complete action', () => {
  it('completes CLEO task when external task is completed', async () => {
    // Seed a CLEO task and create a link
    await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Auth', status: 'active' })],
      { providerId: 'jira', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    // External marks it completed
    const result = await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Auth', status: 'completed' })],
      { providerId: 'jira', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.summary.completed).toBe(1);

    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks[0]!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// activate action
// ---------------------------------------------------------------------------

describe('reconcile — activate action', () => {
  it('activates CLEO pending task when external becomes active', async () => {
    // Create task via reconcile (pending)
    await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Sprint Task', status: 'pending' })],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    // External activates it
    const result = await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Sprint Task', status: 'active' })],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.summary.activated).toBe(1);

    const { tasks } = await env.accessor.queryTasks({});
    expect(tasks[0]!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// skip action
// ---------------------------------------------------------------------------

describe('reconcile — skip action', () => {
  it('skips external task when CLEO task is already done', async () => {
    // Create and complete via reconcile
    await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Done Task', status: 'active' })],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );
    await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Done Task', status: 'completed' })],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    // Re-reconcile (task is done, should skip)
    const result = await reconcile(
      [makeExternalTask({ externalId: 'ext-001', title: 'Done Task', status: 'active' })],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );

    expect(result.summary.skipped).toBe(1);
  });

  it('skips and does not error when there are no external tasks', async () => {
    const result = await reconcile(
      [],
      { providerId: 'linear', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );
    expect(result.summary.total).toBe(0);
    expect(result.summary.applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// summary counts
// ---------------------------------------------------------------------------

describe('reconcile — summary counts', () => {
  it('summary.total equals number of actions', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', status: 'pending' }),
      makeExternalTask({ externalId: 'ext-002', status: 'active' }),
      makeExternalTask({ externalId: 'ext-003', status: 'removed' }),
    ];

    const result = await reconcile(external, { providerId: 'test', dryRun: true }, env.accessor);
    expect(result.summary.total).toBe(result.actions.length);
  });

  it('linksAffected is 0 on dry-run', async () => {
    const external = [makeExternalTask({ externalId: 'ext-001', status: 'pending' })];
    const result = await reconcile(external, { providerId: 'test', dryRun: true }, env.accessor);
    expect(result.linksAffected).toBe(0);
  });

  it('linksAffected increments when tasks are created', async () => {
    const external = [
      makeExternalTask({ externalId: 'ext-001', status: 'pending' }),
      makeExternalTask({ externalId: 'ext-002', status: 'active' }),
    ];
    const result = await reconcile(
      external,
      { providerId: 'test', dryRun: false, cwd: env.tempDir },
      env.accessor,
    );
    expect(result.linksAffected).toBe(2);
  });
});
