/**
 * Integration tests for T932 — orchestrate-engine routes every spawn through
 * {@link composeSpawnPayload}.
 *
 * These tests spin up a real on-disk tasks.db + signaldock.db, seed a ready
 * worker task with an explicit `files` scope (so the atomicity gate permits
 * the spawn), then invoke the engine's spawn API. They assert that the
 * response envelope exposes the T932 composer contract:
 *
 *  - `data.meta.composerVersion === '3.0.0'`
 *  - `data.atomicity.allowed === true`
 *  - `data.prompt` is a fully-resolved spawn prompt (contains the task id)
 *  - `data.role` + `data.tier` are populated by the composer
 *
 * We also verify the negative path: a worker task with no `files` is blocked
 * by the atomicity gate with the `E_ATOMICITY_NO_SCOPE` LAFS code.
 *
 * @task T932
 * @epic T910
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orchestrateSpawn } from '../orchestrate-engine.js';

/**
 * Minimal task shape seeded through the store during setup.
 *
 * Mirrors the columns actually persisted by `createTask`: the rest of the
 * task envelope is filled in with sensible defaults by the store.
 */
interface SeededTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  parentId?: string;
  depends?: string[];
  files?: string[];
  type?: string;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Seed a set of tasks via `createTask`. Each task is inserted into the
 * on-disk tasks.db for the given project root.
 */
async function seedTasks(testRoot: string, tasks: SeededTask[]): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  const { createTask, getDb } = await import('@cleocode/core/internal');
  await getDb(testRoot);
  for (const task of tasks) {
    // `createTask` accepts a partial Task shape — cast narrowed to the known
    // fixture columns we seed above.
    await createTask(task as unknown as Parameters<typeof createTask>[0], testRoot);
  }
}

let TEST_ROOT: string;

const PARENT_EPIC: SeededTask = {
  id: 'T932E',
  title: 'T932 integration epic',
  description: 'Parent epic for composer integration test',
  status: 'active',
  priority: 'high',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

const READY_WORKER: SeededTask = {
  id: 'T932W',
  title: 'T932 worker with explicit files',
  description: 'Ready worker task with declared AC.files',
  status: 'pending',
  priority: 'medium',
  parentId: 'T932E',
  // Atomicity gate permits ≤ MAX_WORKER_FILES (3) files.
  files: ['packages/cleo/src/sample.ts', 'packages/cleo/src/sample.test.ts'],
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

const READY_WORKER_NO_SCOPE: SeededTask = {
  id: 'T932WX',
  title: 'T932 worker without files',
  description: 'Ready worker task with NO declared AC.files',
  status: 'pending',
  priority: 'medium',
  parentId: 'T932E',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

/**
 * T1014: Epic task with no files. Must auto-promote to role=lead so atomicity
 * gate is bypassed (leads have broad scope by design).
 */
const EPIC_NO_FILES: SeededTask = {
  id: 'T932EP',
  title: 'T932 standalone epic with no files',
  description: 'Epic for T1014 role auto-promotion test',
  type: 'epic',
  status: 'active',
  priority: 'high',
  createdAt: '2026-04-17T00:00:00Z',
  updatedAt: null,
};

describe('T932 — orchestrate-engine integration with composeSpawnPayload', () => {
  beforeEach(async () => {
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-t932-'));
    await seedTasks(TEST_ROOT, [PARENT_EPIC, READY_WORKER, READY_WORKER_NO_SCOPE, EPIC_NO_FILES]);
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('@cleocode/core/internal');
      await closeAllDatabases();
    } catch {
      /* ignore */
    }
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('emits payload with composerVersion 3.0.0 meta', async () => {
    const result = await orchestrateSpawn('T932W', undefined, TEST_ROOT);

    expect(result.success).toBe(true);
    const data = result.data as {
      taskId: string;
      prompt: string;
      role: string;
      tier: number;
      harnessHint: string;
      atomicity: { allowed: boolean; code?: string };
      meta: {
        composerVersion: string;
        dedupSavedChars: number;
        promptChars: number;
        protocol: string;
        sourceTier: string;
      };
    };

    // The composer contract is what T932 asserts: composerVersion === 3.0.0.
    expect(data.meta.composerVersion).toBe('3.0.0');
    expect(data.atomicity.allowed).toBe(true);

    // The composer populates diagnostic meta even on happy-path spawns.
    expect(data.meta.promptChars).toBeGreaterThan(0);
    expect(data.meta.protocol).toBeTruthy();
    expect(data.meta.dedupSavedChars).toBeGreaterThanOrEqual(0);

    // The prompt is fully-rendered and contains the task id.
    expect(data.prompt).toContain('T932W');
    expect(data.taskId).toBe('T932W');
    // Role surfaces the composer's derivation (worker by default).
    expect(data.role).toBeDefined();
    expect(typeof data.tier).toBe('number');
  });

  it('rejects worker spawn when AC.files is missing (E_ATOMICITY_NO_SCOPE)', async () => {
    const result = await orchestrateSpawn('T932WX', undefined, TEST_ROOT);

    // Composer rejects; engine surfaces the atomicity code as a first-class
    // LAFS envelope.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_ATOMICITY_NO_SCOPE');

    const details = result.error?.details as { atomicity?: { allowed: boolean } } | undefined;
    expect(details?.atomicity?.allowed).toBe(false);
  });

  it('T1014 — epic spawn auto-promotes to role=lead, bypassing atomicity file-scope gate', async () => {
    // T932EP is type=epic with no files declared. Without the T1014 fix this
    // would return E_ATOMICITY_NO_SCOPE because the default resolved role is
    // worker (cleo-subagent.orchLevel = 2). With the fix the engine detects
    // task.type === 'epic' and forces role=lead before entering the atomicity
    // gate (leads pass through unconditionally).
    const result = await orchestrateSpawn('T932EP', undefined, TEST_ROOT);

    expect(result.success).toBe(true);
    const data = result.data as {
      role: string;
      atomicity: { allowed: boolean };
      prompt: string;
    };
    expect(data.role).toBe('lead');
    expect(data.atomicity.allowed).toBe(true);
    // Prompt contains the task id so we know the right task was rendered.
    expect(data.prompt).toContain('T932EP');
  });
});
