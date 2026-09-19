/**
 * Regression coverage for the T1445 tasks dispatch type-source migration.
 *
 * @task T1445
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const dispatchSourcePath = resolve(testDir, '../tasks.ts');
const coreIndexSourcePath = resolve(testDir, '../../../../../core/src/tasks/index.ts');
const coreOpsSourcePath = resolve(testDir, '../../../../../core/src/tasks/ops.ts');

describe('tasks dispatch OpsFromCore inference', () => {
  it('infers TasksOps from Core signatures instead of per-op contract imports', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    expect(source).toContain("import type { tasks as coreTasks } from '@cleocode/core';");
    expect(source).toContain('type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>;');
    expect(source).toContain('const _tasksTypedHandler = defineTypedHandler<TasksOps>');
    expect(source).not.toMatch(/from ['"]@cleocode\/contracts['"]/);
    expect(source).not.toMatch(/Tasks[A-Za-z0-9]+(?:Query)?Params/);
  });

  it('keeps task dispatch behavior-preservation guards in place', async () => {
    const source = await readFile(dispatchSourcePath, 'utf-8');

    expect(source).toContain('E_FLAG_REMOVED');
    expect(source).toContain('relatedId (or targetId) is required');
    expect(source).toContain('change is required (free-text description of the proposed change)');
  });

  it('exposes the tasks Core operation signature registry', async () => {
    const [indexSource, opsSource] = await Promise.all([
      readFile(coreIndexSourcePath, 'utf-8'),
      readFile(coreOpsSourcePath, 'utf-8'),
    ]);

    expect(indexSource).toContain("export type { tasksCoreOps } from './ops.js';");
    expect(opsSource).toContain('export declare const tasksCoreOps');
    expect(opsSource).toContain("readonly add: TaskCoreOperation<'add'>;");
    expect(opsSource).toContain(
      "readonly 'sync.links.remove': TaskCoreOperation<'sync.links.remove'>;",
    );
  });
});

vi.mock('@cleocode/runtime/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/runtime/gateway')>();
  return { ...actual, addTaskWithSessionScope: vi.fn(), taskUpdate: vi.fn() };
});
vi.mock('../../../../../core/src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../core/src/paths.js')>();
  return { ...actual, getProjectRoot: vi.fn(() => '/mock/project') };
});

import { addTaskWithSessionScope, taskUpdate } from '@cleocode/runtime/gateway';
import { TasksHandler } from '../tasks.js';

describe('canonical task input forwarding', () => {
  let handler: TasksHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TasksHandler();
  });
  it.each([
    true,
    false,
  ])('update - retains explicit auto-complete %s, phase and waiver fields', async (noAutoComplete) => {
    vi.mocked(taskUpdate).mockResolvedValue({
      success: false,
      error: { code: 'E_TEST', message: 'Boundary-only fixture' },
    });
    const input = {
      taskId: 'T001',
      noAutoComplete,
      phase: 'verification',
      priority: 'critical',
      dependsWaiver: 'Independent restoration',
    };
    await handler.mutate('update', input);
    const { taskId, ...updates } = input;
    expect(taskUpdate).toHaveBeenCalledWith(
      '/mock/project',
      taskId,
      expect.objectContaining(updates),
    );
  });

  it('add - retains creation dependency-waiver provenance', async () => {
    vi.mocked(addTaskWithSessionScope).mockResolvedValue({
      success: false,
      error: { code: 'E_TEST', message: 'Boundary-only fixture' },
    });
    const input = {
      title: 'Critical task',
      description: 'Create with sourced waiver',
      priority: 'critical',
      dependsWaiver: 'Independent restoration',
    };
    await handler.mutate('add', input);
    expect(addTaskWithSessionScope).toHaveBeenCalledWith(
      '/mock/project',
      expect.objectContaining(input),
    );
  });
});
