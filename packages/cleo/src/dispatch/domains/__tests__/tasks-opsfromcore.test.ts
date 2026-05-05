/**
 * Regression coverage for the T1445 tasks dispatch type-source migration.
 *
 * @task T1445
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
