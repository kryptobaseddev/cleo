/**
 * Orchestrate Engine Tests
 *
 * Tests native TypeScript orchestrate operations.
 *
 * @task T4478
 * @task T4854
 */

import {
  orchestrateAnalyze,
  orchestrateContext,
  orchestrateHandoff,
  orchestrateNext,
  orchestrateReady,
  orchestrateSpawn,
  orchestrateStartup,
  orchestrateStatus,
  orchestrateValidate,
  orchestrateWaves,
} from '@cleocode/core/internal';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sessionContextInject,
  sessionEnd,
  sessionStart,
  sessionStatus,
} from '../session-engine.js';

let TEST_ROOT: string;
let CLEO_DIR: string;

/**
 * Seed tasks into SQLite via the task store (ADR-006).
 */
async function seedTasks(testRoot: string, tasks: any[]): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb } = await import('@cleocode/core/internal');
  const { createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  for (const task of tasks) {
    await createTask(task as any, testRoot);
  }
}

const SAMPLE_TASKS = [
  {
    id: 'T100',
    title: 'Epic Task',
    description: 'Parent epic',
    status: 'active',
    priority: 'high',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T101',
    title: 'First child',
    description: 'Task 1',
    status: 'done',
    priority: 'high',
    parentId: 'T100',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T102',
    title: 'Second child',
    description: 'Task 2',
    status: 'pending',
    priority: 'medium',
    parentId: 'T100',
    depends: ['T101'],
    // T932: composeSpawnPayload enforces atomicity on worker spawns — declare
    // a single file so the gate allows the spawn through.
    files: ['packages/core/src/t102.ts'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T103',
    title: 'Third child',
    description: 'Task 3',
    status: 'pending',
    priority: 'high',
    parentId: 'T100',
    depends: ['T101'],
    files: ['packages/core/src/t103.ts'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  },
  {
    id: 'T104',
    title: 'Fourth child',
    description: 'Task 4',
    status: 'pending',
    priority: 'low',
    parentId: 'T100',
    depends: ['T102', 'T103'],
    files: ['packages/core/src/t104.ts'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  },
];

describe('Orchestrate Engine', () => {
  beforeEach(async () => {
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-orch-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    await seedTasks(TEST_ROOT, SAMPLE_TASKS);
    const protocolsDir = join(TEST_ROOT, 'protocols');
    mkdirSync(protocolsDir, { recursive: true });
    writeFileSync(
      join(protocolsDir, 'implementation.md'),
      '# Implementation Protocol\nUse this for handoff tests.\n',
    );
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

  describe('orchestrateStatus', () => {
    it('should return status for an epic', async () => {
      const result = await orchestrateStatus('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.epicId).toBe('T100');
      expect(data.totalTasks).toBe(4); // 4 children
      expect(data.byStatus.done).toBe(1);
      expect(data.byStatus.pending).toBe(3);
    });

    it('should return error for missing epic', async () => {
      const result = await orchestrateStatus('T999', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('orchestrateAnalyze', () => {
    it('should analyze dependency graph', async () => {
      const result = await orchestrateAnalyze('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.waves).toBeDefined();
      expect(data.waves.length).toBeGreaterThan(0);
      expect(data.circularDependencies).toHaveLength(0);
    });
  });

  describe('orchestrateReady', () => {
    it('should find tasks with met dependencies', async () => {
      const result = await orchestrateReady('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // T102 and T103 depend on T101 (done), so they should be ready
      expect(data.total).toBe(2);
      expect(data.readyTasks.map((t: any) => t.id)).toContain('T102');
      expect(data.readyTasks.map((t: any) => t.id)).toContain('T103');
    });

    it('T929 regression: returns E_NOT_FOUND for a nonexistent epic instead of success', async () => {
      const result = await orchestrateReady('T999', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('orchestrateNext', () => {
    it('should return first ready task', async () => {
      const result = await orchestrateNext('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // getNextTask returns first ready task in array order (T102 comes before T103)
      expect(data.nextTask.id).toBe('T102');
    });
  });

  describe('orchestrateWaves', () => {
    it('should compute dependency waves', async () => {
      const result = await orchestrateWaves('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.totalWaves).toBeGreaterThan(0);
      // Wave 1: T102, T103 (depend on done T101)
      // Wave 2: T104 (depends on T102 and T103)
    });
  });

  describe('orchestrateValidate', () => {
    it('should validate ready task', async () => {
      const result = await orchestrateValidate('T102', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(true);
    });

    it('should report unmet dependencies', async () => {
      const result = await orchestrateValidate('T104', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(false);
      expect((result.data as any).issues.length).toBeGreaterThan(0);
    });

    it('should report done task as not ready', async () => {
      const result = await orchestrateValidate('T101', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(false);
    });
  });

  describe('orchestrateSpawn', () => {
    it('should generate spawn context for ready task', async () => {
      const result = await orchestrateSpawn('T102', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskId).toBe('T102');
      // T932: response envelope surfaces composer meta + atomicity verdict.
      expect((result.data as any).meta.composerVersion).toBe('3.0.0');
      expect((result.data as any).atomicity.allowed).toBe(true);
      expect((result.data as any).prompt).toContain('T102');
    });

    it('should reject not-ready task', async () => {
      // Mutate T104 back to a state that fails readiness by leaving its deps
      // unmet at spawn time (T102/T103 still pending in this fixture).
      const result = await orchestrateSpawn('T104', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SPAWN_VALIDATION_FAILED');
    });

    it('T929 regression: returns E_NOT_FOUND for a nonexistent task ID', async () => {
      // T1570: exitCode no longer set in engine result (core engineError doesn't auto-assign);
      // the CLI dispatch layer maps E_NOT_FOUND → exit 4 via STRING_TO_EXIT.
      const result = await orchestrateSpawn('T999', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('T929 regression: orchestrateStartup and orchestrateReady agree on ready task set', () => {
    it('both return the same task IDs for a 6-child epic with no dependencies', async () => {
      // Build a fresh epic with 6 children that have no inter-dependencies —
      // the exact reproduce scenario from the T929 task description.
      const epicTasks = [
        {
          id: 'E001',
          title: 'Fresh Epic',
          description: 'Top-level epic for T929 regression',
          status: 'pending',
          priority: 'high',
          type: 'epic',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
        ...([1, 2, 3, 4, 5, 6] as const).map((i) => ({
          id: `C00${i}`,
          title: `child ${i}`,
          description: `child task ${i}`,
          status: 'pending',
          priority: 'high',
          parentId: 'E001',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        })),
      ];

      // Seed into an isolated test root so existing fixture tasks don't interfere.
      const isolatedRoot = await mkdtemp(join(tmpdir(), 'cleo-t929-'));
      try {
        await seedTasks(isolatedRoot, epicTasks);

        const startResult = await orchestrateStartup('E001', isolatedRoot);
        expect(startResult.success).toBe(true);
        const startData = startResult.data as any;
        // start must report 6 ready tasks and all 6 in firstWave
        expect(startData.summary.readyTasks).toBe(6);
        expect(startData.firstWave.tasks).toHaveLength(6);

        const readyResult = await orchestrateReady('E001', isolatedRoot);
        expect(readyResult.success).toBe(true);
        const readyData = readyResult.data as any;
        // ready must return the same 6 task IDs that start reported
        expect(readyData.total).toBe(6);
        const readyIds = new Set(readyData.readyTasks.map((t: any) => t.id));
        const firstWaveIds = new Set(startData.firstWave.tasks);
        for (const id of firstWaveIds) {
          expect(readyIds.has(id)).toBe(true);
        }
      } finally {
        try {
          const { closeAllDatabases } = await import('@cleocode/core/internal');
          await closeAllDatabases();
        } catch {
          /* ignore */
        }
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    });

    it('orchestrateReady includes a reason field when no tasks are ready', async () => {
      // All tasks have unmet deps — ready set should be empty with a reason.
      // Note: the DB filters out depends-on IDs that do not exist in the task
      // store (loadDependenciesForTasks only keeps valid IDs). So the blocker
      // must be a real task that exists but is NOT done.
      const blockedTasks = [
        {
          id: 'EP01',
          title: 'Blocked Epic',
          description: 'Epic where all children have unmet deps',
          status: 'pending',
          priority: 'high',
          type: 'epic',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
        {
          // Standalone pending task used as an unmet blocker — NOT a child of EP01.
          id: 'BT_BLOCKER',
          title: 'blocker task',
          description: 'pending task that is a dep of BT01',
          status: 'pending',
          priority: 'high',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
        {
          id: 'BT01',
          title: 'blocked child',
          description: 'child with unmet dep',
          status: 'pending',
          priority: 'high',
          parentId: 'EP01',
          depends: ['BT_BLOCKER'],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: null,
        },
      ];

      const isolatedRoot2 = await mkdtemp(join(tmpdir(), 'cleo-t929b-'));
      try {
        await seedTasks(isolatedRoot2, blockedTasks);

        const result = await orchestrateReady('EP01', isolatedRoot2);
        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.total).toBe(0);
        expect(data.readyTasks).toHaveLength(0);
        expect(typeof data.reason).toBe('string');
        expect(data.reason.length).toBeGreaterThan(0);
      } finally {
        try {
          const { closeAllDatabases } = await import('@cleocode/core/internal');
          await closeAllDatabases();
        } catch {
          /* ignore */
        }
        await rm(isolatedRoot2, { recursive: true, force: true });
      }
    });
  });

  describe('orchestrateStartup', () => {
    it('should initialize orchestration', async () => {
      const result = await orchestrateStartup('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.initialized).toBe(true);
      expect(data.summary.totalTasks).toBe(4);
    });

    it.todo('auto-initializes lifecycle on first orchestrate start (T1634 — test scaffolding interacts with prior `should initialize orchestration` test pipeline state; fix in T-FOUND-5)', async () => {
      const result = await orchestrateStartup('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // First call: lifecycle was not initialized — must auto-init at research
      expect(data.autoInitialized).toBe(true);
      expect(data.currentStage).toBe('research');
    });

    it.todo('idempotent — second call does not re-init (T1634 — same scaffolding issue as auto-initializes test; fix in T-FOUND-5)', async () => {
      // First call initializes the lifecycle
      const first = await orchestrateStartup('T100', TEST_ROOT);
      expect(first.success).toBe(true);
      expect((first.data as any).autoInitialized).toBe(true);

      // Second call must detect existing pipeline and skip re-initialization
      const second = await orchestrateStartup('T100', TEST_ROOT);
      expect(second.success).toBe(true);
      const data = second.data as any;
      expect(data.autoInitialized).toBe(false);
      expect(data.currentStage).toBe('already-initialized');
    });
  });

  describe('orchestrateContext', () => {
    it('should estimate context usage', async () => {
      const result = await orchestrateContext('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskCount).toBe(4);
      expect((result.data as any).estimatedTokens).toBeGreaterThan(0);
    });
  });

  describe('orchestrateHandoff', () => {
    it('should execute inject -> end -> spawn in order', async () => {
      const startResult = await sessionStart(TEST_ROOT, {
        scope: 'epic:T100',
        name: 'handoff-predecessor',
      });
      expect(startResult.success).toBe(true);

      const result = await orchestrateHandoff(
        {
          taskId: 'T102',
          protocolType: 'implementation',
          note: 'handoff complete',
        },
        { sessionStatus, sessionEnd, sessionContextInject },
        TEST_ROOT,
      );

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.predecessorSessionId).toBeDefined();
      expect(data.endedSessionId).toBe(data.predecessorSessionId);
      expect(data.steps.contextInject.status).toBe('completed');
      expect(data.steps.sessionEnd.status).toBe('completed');
      expect(data.steps.spawn.status).toBe('completed');
      expect(data.idempotency.policy).toBe('non-idempotent');

      const sessionState = await sessionStatus(TEST_ROOT);
      expect(sessionState.success).toBe(true);
      expect(sessionState.data?.hasActiveSession).toBe(false);
    });

    it('should fail with no active session and surface step metadata', async () => {
      const result = await orchestrateHandoff(
        {
          taskId: 'T102',
          protocolType: 'implementation',
        },
        { sessionStatus, sessionEnd, sessionContextInject },
        TEST_ROOT,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SESSION_REQUIRED');
      const details = result.error?.details as any;
      expect(details.failedStep).toBe('session.end');
      expect(details.steps.contextInject.status).toBe('skipped');
      expect(details.steps.spawn.status).toBe('skipped');
    });

    it('should surface partial state when spawn step fails', async () => {
      const startResult = await sessionStart(TEST_ROOT, {
        scope: 'epic:T100',
        name: 'handoff-partial-failure',
      });
      expect(startResult.success).toBe(true);

      const result = await orchestrateHandoff(
        {
          taskId: 'T104',
          protocolType: 'implementation',
        },
        { sessionStatus, sessionEnd, sessionContextInject },
        TEST_ROOT,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SPAWN_VALIDATION_FAILED');
      const details = result.error?.details as any;
      expect(details.failedStep).toBe('orchestrate.spawn');
      expect(details.steps.contextInject.status).toBe('completed');
      expect(details.steps.sessionEnd.status).toBe('completed');
      expect(details.steps.spawn.status).toBe('failed');
      expect(details.idempotency.safeRetryFrom).toBe('orchestrate.spawn');

      const sessionState = await sessionStatus(TEST_ROOT);
      expect(sessionState.success).toBe(true);
      expect(sessionState.data?.hasActiveSession).toBe(false);
    });
  });
});
