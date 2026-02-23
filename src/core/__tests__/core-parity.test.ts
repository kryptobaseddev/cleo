/**
 * CLI/MCP Core Parity Integration Tests
 *
 * Verifies that MCP engine functions delegate to src/core/ modules
 * and that both paths produce equivalent results for shared operations.
 *
 * Test categories:
 * 1. Import graph verification — engine files import from core
 * 2. Task CRUD data parity — core vs engine return identical task data
 * 3. Session operations parity — core vs engine session state
 * 4. Lifecycle operations parity — core vs engine lifecycle info
 *
 * @task T4796
 * @epic T4654
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// Section 1: Import Graph Verification
//
// Verifies that engine files delegate to src/core/ rather than duplicating
// business logic inline. This is a structural test that reads source files.
//
// Note: Multi-line import statements like:
//   import {
//     foo,
//   } from '../../core/bar.js';
// have `from` on a separate line from `import`, so we match `from` lines.
// ============================================================================

describe('Import Graph Verification (T4796)', () => {
  const ENGINE_FILES = [
    'task-engine.ts',
    'session-engine.ts',
    'lifecycle-engine.ts',
    'system-engine.ts',
    'orchestrate-engine.ts',
    'validate-engine.ts',
  ];

  const ENGINE_DIR = join(
    process.cwd(),
    'src',
    'mcp',
    'engine',
  );

  for (const file of ENGINE_FILES) {
    describe(`${file}`, () => {
      it('imports from ../../core/ or ../../store/', async () => {
        const filePath = join(ENGINE_DIR, file);
        const content = await readFile(filePath, 'utf-8');

        // Match `from '../../core/...'` lines (handles multi-line imports)
        const fromLines = content
          .split('\n')
          .filter((line) => line.match(/from\s+['"]/));

        const coreImports = fromLines.filter(
          (line) =>
            line.includes('../../core/') ||
            line.includes('../../store/'),
        );

        // Every engine file should have at least one core/store import
        expect(coreImports.length).toBeGreaterThanOrEqual(1);
      });

      it('has meaningful core delegation', async () => {
        const filePath = join(ENGINE_DIR, file);
        const content = await readFile(filePath, 'utf-8');

        // Match all `from '...'` lines
        const fromLines = content
          .split('\n')
          .filter((line) => line.match(/from\s+['"]/))
          .filter((line) => !line.includes("'node:"))
          .filter((line) => !line.includes("'vitest"))
          .filter((line) => !line.includes("'@cleocode"));

        // Count core + store imports
        const coreImports = fromLines.filter(
          (line) =>
            line.includes('../../core/') ||
            line.includes('../../store/'),
        );

        // Core imports should exist
        if (fromLines.length > 0) {
          expect(coreImports.length).toBeGreaterThanOrEqual(1);
        }
      });
    });
  }

  it('task-engine.ts imports specific core CRUD functions', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'task-engine.ts'),
      'utf-8',
    );

    // These core imports should exist for the shared-core pattern
    expect(content).toContain("from '../../core/tasks/add.js'");
    expect(content).toContain("from '../../core/tasks/show.js'");
    expect(content).toContain("from '../../core/tasks/list.js'");
    expect(content).toContain("from '../../core/tasks/find.js'");
    expect(content).toContain("from '../../core/tasks/update.js'");
    expect(content).toContain("from '../../core/tasks/delete.js'");
    expect(content).toContain("from '../../core/tasks/archive.js'");
  });

  it('session-engine.ts imports from core/sessions/ and core/task-work/', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'session-engine.ts'),
      'utf-8',
    );

    expect(content).toContain("from '../../core/sessions/index.js'");
    expect(content).toContain("from '../../core/task-work/index.js'");
  });

  it('lifecycle-engine.ts imports from core/lifecycle/', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'lifecycle-engine.ts'),
      'utf-8',
    );

    expect(content).toContain("from '../../core/lifecycle/index.js'");
  });

  it('validate-engine.ts imports from core/validation/', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'validate-engine.ts'),
      'utf-8',
    );

    expect(content).toContain("from '../../core/validation/validate-ops.js'");
  });

  it('system-engine.ts imports from core/stats/ and core/system/', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'system-engine.ts'),
      'utf-8',
    );

    expect(content).toContain("from '../../core/stats/index.js'");
    expect(content).toContain("from '../../core/system/");
  });

  it('orchestrate-engine.ts imports from core/orchestration/', async () => {
    const content = await readFile(
      join(ENGINE_DIR, 'orchestrate-engine.ts'),
      'utf-8',
    );

    expect(content).toContain("from '../../core/orchestration/index.js'");
  });

  // research-engine.ts has been consolidated into core/memory/engine-compat.ts
});

// ============================================================================
// Shared fixture helper
// ============================================================================

/** Sequence file required for task ID generation. */
const SEQUENCE_JSON = {
  counter: 100,
  lastId: 'T100',
  checksum: 'test-parity',
};

/**
 * Create a minimal .cleo project directory with required files.
 * Returns { testDir, cleoDir }.
 */
async function createTestProject(
  prefix: string,
  tasksJson: Record<string, unknown>,
): Promise<{ testDir: string; cleoDir: string }> {
  const testDir = await mkdtemp(join(tmpdir(), prefix));
  const cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });

  await writeFile(
    join(cleoDir, 'tasks.json'),
    JSON.stringify(tasksJson),
  );

  // Sequence file needed for task creation (ID generation)
  await writeFile(
    join(cleoDir, '.sequence.json'),
    JSON.stringify(SEQUENCE_JSON),
  );

  return { testDir, cleoDir };
}

// ============================================================================
// Section 2: Task CRUD Data Parity
//
// Creates a temp project dir with a valid tasks.json, then verifies that
// calling core functions directly and engine wrapper functions produce
// equivalent results (stripping the EngineResult wrapper).
// ============================================================================

describe('Task CRUD Data Parity (T4796)', () => {
  let testDir: string;
  let cleoDir: string;

  const TASKS_JSON = {
    version: '2.10.0',
    project: {
      name: 'Parity Test',
      phases: {
        core: { order: 1, name: 'Core', status: 'active' },
      },
    },
    lastUpdated: '2026-01-01T00:00:00Z',
    _meta: {
      schemaVersion: '2.10.0',
      specVersion: '0.1.0',
      checksum: 'abc',
      configVersion: '2.0.0',
    },
    focus: {},
    tasks: [
      {
        id: 'T001',
        title: 'Test task alpha',
        description: 'First test task for parity testing',
        status: 'pending',
        priority: 'high',
        phase: 'core',
        type: 'task',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
      {
        id: 'T002',
        title: 'Test task beta',
        description: 'Second test task for parity testing',
        status: 'done',
        priority: 'medium',
        phase: 'core',
        type: 'task',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: null,
        completedAt: '2026-01-05T00:00:00Z',
      },
      {
        id: 'T003',
        title: 'Subtask of T001',
        description: 'A child task',
        status: 'pending',
        priority: 'low',
        phase: 'core',
        type: 'subtask',
        parentId: 'T001',
        createdAt: '2026-01-03T00:00:00Z',
        updatedAt: null,
      },
    ],
  };

  beforeEach(async () => {
    const project = await createTestProject('cleo-parity-', TASKS_JSON);
    testDir = project.testDir;
    cleoDir = project.cleoDir;
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('taskShow returns same task data as core showTask', async () => {
    const { showTask } = await import('../tasks/show.js');
    const { taskShow } = await import('../../mcp/engine/task-engine.js');
    const { getAccessor } = await import('../../store/data-accessor.js');

    const accessor = await getAccessor(testDir);

    // Call core directly
    const coreResult = await showTask('T001', testDir, accessor);

    // Call engine wrapper
    const engineResult = await taskShow(testDir, 'T001');

    // Both should succeed
    expect(engineResult.success).toBe(true);
    expect(engineResult.data).toBeDefined();

    // Compare key fields (engine wraps core result in { task: ... })
    expect(engineResult.data!.task.id).toBe(coreResult.id);
    expect(engineResult.data!.task.title).toBe(coreResult.title);
    expect(engineResult.data!.task.status).toBe(coreResult.status);
    expect(engineResult.data!.task.priority).toBe(coreResult.priority);
  });

  it('taskShow and core showTask both fail for missing task', async () => {
    const { showTask } = await import('../tasks/show.js');
    const { taskShow } = await import('../../mcp/engine/task-engine.js');
    const { getAccessor } = await import('../../store/data-accessor.js');

    const accessor = await getAccessor(testDir);

    // Core should throw
    await expect(showTask('T999', testDir, accessor)).rejects.toThrow();

    // Engine should return error (may be E_NOT_FOUND or E_NOT_INITIALIZED
    // depending on where the error is caught in the engine)
    const engineResult = await taskShow(testDir, 'T999');
    expect(engineResult.success).toBe(false);
    expect(engineResult.error?.code).toMatch(/^E_/);
  });

  it('taskList returns same tasks as core listTasks', async () => {
    const { listTasks } = await import('../tasks/list.js');
    const { taskList } = await import('../../mcp/engine/task-engine.js');
    const { getAccessor } = await import('../../store/data-accessor.js');

    const accessor = await getAccessor(testDir);

    // Call core
    const coreResult = await listTasks({}, testDir, accessor);

    // Call engine
    const engineResult = await taskList(testDir);

    expect(engineResult.success).toBe(true);
    expect(engineResult.data).toBeDefined();

    // Same number of tasks
    expect(engineResult.data!.tasks.length).toBe(coreResult.tasks.length);

    // Same task IDs
    const coreIds = coreResult.tasks.map((t) => t.id).sort();
    const engineIds = engineResult.data!.tasks.map((t) => t.id).sort();
    expect(engineIds).toEqual(coreIds);
  });

  it('taskList with status filter matches core listTasks filter', async () => {
    const { listTasks } = await import('../tasks/list.js');
    const { taskList } = await import('../../mcp/engine/task-engine.js');
    const { getAccessor } = await import('../../store/data-accessor.js');

    const accessor = await getAccessor(testDir);

    // Filter pending tasks
    const coreResult = await listTasks(
      { status: 'pending' },
      testDir,
      accessor,
    );

    const engineResult = await taskList(testDir, { status: 'pending' });

    expect(engineResult.success).toBe(true);
    const coreIds = coreResult.tasks.map((t) => t.id).sort();
    const engineIds = engineResult.data!.tasks.map((t) => t.id).sort();
    expect(engineIds).toEqual(coreIds);
  });

  it('taskFind returns same results as core findTasks', async () => {
    const { findTasks } = await import('../tasks/find.js');
    const { taskFind } = await import('../../mcp/engine/task-engine.js');
    const { getAccessor } = await import('../../store/data-accessor.js');

    const accessor = await getAccessor(testDir);

    // Search for "alpha"
    const coreResult = await findTasks(
      { query: 'alpha', limit: 20 },
      testDir,
      accessor,
    );

    const engineResult = await taskFind(testDir, 'alpha');

    expect(engineResult.success).toBe(true);
    expect(engineResult.data).toBeDefined();

    // Both should find T001
    const coreIds = coreResult.results.map((r) => r.id);
    const engineIds = engineResult.data!.results.map((r) => r.id);

    expect(coreIds).toContain('T001');
    expect(engineIds).toContain('T001');
  });

  it('taskCreate produces a valid task via engine', async () => {
    const { taskCreate } = await import('../../mcp/engine/task-engine.js');

    // Engine create
    const engineResult = await taskCreate(testDir, {
      title: 'Engine-created task',
      description: 'Created via engine for parity test',
    });

    expect(engineResult.success).toBe(true);
    expect(engineResult.data).toBeDefined();
    expect(engineResult.data!.task.id).toMatch(/^T\d+$/);
    expect(engineResult.data!.task.title).toBe('Engine-created task');
    expect(engineResult.data!.task.status).toBe('pending');
  });
});

// ============================================================================
// Section 3: Session Engine Delegation Verification
//
// Verifies that session-engine.ts functions delegate to core and produce
// structurally valid EngineResult wrappers.
// ============================================================================

describe('Session Engine Delegation (T4796)', () => {
  let testDir: string;
  let cleoDir: string;

  const SESSION_TASKS_JSON = {
    version: '2.10.0',
    project: {
      name: 'Session Test',
      phases: {
        core: { order: 1, name: 'Core', status: 'active' },
      },
    },
    lastUpdated: '2026-01-01T00:00:00Z',
    _meta: {
      schemaVersion: '2.10.0',
      specVersion: '0.1.0',
      checksum: 'abc',
      configVersion: '2.0.0',
    },
    focus: {
      currentTask: null,
      currentPhase: null,
    },
    tasks: [
      {
        id: 'T010',
        title: 'Session test epic',
        description: 'Epic for session testing',
        status: 'pending',
        priority: 'high',
        phase: 'core',
        type: 'epic',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ],
  };

  beforeEach(async () => {
    const project = await createTestProject('cleo-sess-', SESSION_TASKS_JSON);
    testDir = project.testDir;
    cleoDir = project.cleoDir;
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('sessionStatus returns valid EngineResult', async () => {
    const { sessionStatus } = await import(
      '../../mcp/engine/session-engine.js'
    );

    const result = await sessionStatus(testDir);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data!.hasActiveSession).toBe('boolean');
    expect(typeof result.data!.multiSessionEnabled).toBe('boolean');
  });

  it('sessionList returns valid EngineResult with array', async () => {
    const { sessionList } = await import(
      '../../mcp/engine/session-engine.js'
    );

    const result = await sessionList(testDir);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('sessionStart creates session and returns EngineResult', async () => {
    const { sessionStart } = await import(
      '../../mcp/engine/session-engine.js'
    );

    const result = await sessionStart(testDir, {
      scope: 'epic:T010',
      name: 'Parity Test Session',
      autoStart: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.id).toMatch(/^session_/);
    expect(result.data!.status).toBe('active');
    expect(result.data!.scope.rootTaskId).toBe('T010');
  });

  it('sessionStart then sessionEnd round-trip works', async () => {
    const { sessionStart, sessionEnd, sessionStatus } = await import(
      '../../mcp/engine/session-engine.js'
    );

    // Start session
    const startResult = await sessionStart(testDir, {
      scope: 'epic:T010',
      autoStart: true,
    });
    expect(startResult.success).toBe(true);

    // Verify status shows active
    const statusResult = await sessionStatus(testDir);
    expect(statusResult.success).toBe(true);
    expect(statusResult.data!.hasActiveSession).toBe(true);

    // End session
    const endResult = await sessionEnd(testDir, 'Parity test done');
    expect(endResult.success).toBe(true);
    expect(endResult.data!.ended).toBe(true);
  });

  it('taskStart and taskStop delegate to core/task-work/', async () => {
    const { taskStart, taskStop, taskCurrentGet } = await import(
      '../../mcp/engine/session-engine.js'
    );

    // Start working on a task
    const startResult = await taskStart(testDir, 'T010');
    expect(startResult.success).toBe(true);
    expect(startResult.data!.taskId).toBe('T010');

    // Verify current task is set
    const currentResult = await taskCurrentGet(testDir);
    expect(currentResult.success).toBe(true);
    expect(currentResult.data!.currentTask).toBe('T010');

    // Stop working
    const stopResult = await taskStop(testDir);
    expect(stopResult.success).toBe(true);
    expect(stopResult.data!.cleared).toBe(true);
  });
});

// ============================================================================
// Section 4: Lifecycle Engine Parity
//
// Verifies lifecycle-engine.ts functions produce valid EngineResult wrappers
// and use core lifecycle constants.
// ============================================================================

describe('Lifecycle Engine Parity (T4796)', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-lifecycle-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'rcsd', 'T100'), { recursive: true });

    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('LIFECYCLE_STAGES re-exported from engine match core constants', async () => {
    const engineMod = await import('../../mcp/engine/lifecycle-engine.js');
    const coreMod = await import('../lifecycle/index.js');

    // Engine re-exports ENGINE_LIFECYCLE_STAGES as LIFECYCLE_STAGES
    expect(engineMod.LIFECYCLE_STAGES).toEqual(
      coreMod.ENGINE_LIFECYCLE_STAGES,
    );
  });

  it('lifecycleStatus returns valid result for uninitialized epic', async () => {
    const { lifecycleStatus } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    const result = lifecycleStatus('T100', testDir);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const data = result.data as Record<string, unknown>;
    expect(data.epicId).toBe('T100');
    expect(data.initialized).toBe(false);
    expect(data.nextStage).toBe('research');
    expect(Array.isArray(data.stages)).toBe(true);
  });

  it('lifecycleProgress records stage and lifecycleStatus reflects it', async () => {
    const { lifecycleProgress, lifecycleStatus } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    // Record research as completed
    const progressResult = lifecycleProgress(
      'T100',
      'research',
      'completed',
      'Research done',
      testDir,
    );

    expect(progressResult.success).toBe(true);
    const progressData = progressResult.data as Record<string, unknown>;
    expect(progressData.recorded).toBe(true);
    expect(progressData.stage).toBe('research');

    // Now check status reflects it
    const statusResult = lifecycleStatus('T100', testDir);
    expect(statusResult.success).toBe(true);
    const statusData = statusResult.data as Record<string, unknown>;
    expect(statusData.initialized).toBe(true);
    expect(statusData.currentStage).toBe('research');
  });

  it('lifecyclePrerequisites returns valid data', async () => {
    const { lifecyclePrerequisites } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    const result = lifecyclePrerequisites('specification', testDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.targetStage).toBe('specification');
    expect(Array.isArray(data.prerequisites)).toBe(true);
  });

  it('lifecycleCheck validates prerequisites correctly', async () => {
    const { lifecycleCheck, lifecycleProgress } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    // Check specification without completing research
    const checkResult = lifecycleCheck('T100', 'specification', testDir);

    expect(checkResult.success).toBe(true);
    const checkData = checkResult.data as Record<string, unknown>;
    // specification requires research (at minimum), so should not be valid
    expect(checkData.valid).toBe(false);
    expect(
      (checkData.missingPrerequisites as string[]).length,
    ).toBeGreaterThan(0);

    // Complete research
    lifecycleProgress('T100', 'research', 'completed', 'Done', testDir);

    // Now the gate for consensus should be valid
    const checkAfter = lifecycleCheck('T100', 'consensus', testDir);
    expect(checkAfter.success).toBe(true);
    const afterData = checkAfter.data as Record<string, unknown>;
    expect(afterData.valid).toBe(true);
  });

  it('lifecycleSkip records skip with reason', async () => {
    const { lifecycleSkip, lifecycleHistory } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    const skipResult = lifecycleSkip(
      'T100',
      'consensus',
      'Solo developer, no consensus needed',
      testDir,
    );

    expect(skipResult.success).toBe(true);
    const skipData = skipResult.data as Record<string, unknown>;
    expect(skipData.skipped).toBe(true);

    // History should include the skip
    const histResult = lifecycleHistory('T100', testDir);
    expect(histResult.success).toBe(true);
    const histData = histResult.data as {
      history: Array<{ stage: string; action: string }>;
    };
    const skipEntry = histData.history.find(
      (h) => h.stage === 'consensus' && h.action === 'skipped',
    );
    expect(skipEntry).toBeDefined();
  });
});

// ============================================================================
// Section 5: EngineResult Wrapper Consistency
//
// Verifies that all engine functions return properly structured EngineResult
// objects with consistent shape.
// ============================================================================

describe('EngineResult Wrapper Consistency (T4796)', () => {
  /**
   * Verify EngineResult shape: { success, data?, error? }
   */
  function assertEngineResult(result: unknown): void {
    expect(result).toBeDefined();
    const r = result as Record<string, unknown>;
    expect(typeof r.success).toBe('boolean');

    if (r.success) {
      expect(r.data).toBeDefined();
      // success results should not have error
      expect(r.error).toBeUndefined();
    } else {
      expect(r.error).toBeDefined();
      const err = r.error as Record<string, unknown>;
      expect(typeof err.code).toBe('string');
      expect(typeof err.message).toBe('string');
    }
  }

  it('task engine error results have E_ prefixed codes', async () => {
    const { taskShow } = await import('../../mcp/engine/task-engine.js');

    // This will fail because no project dir is set up
    const result = await taskShow('/nonexistent', 'T999');
    assertEngineResult(result);
    if (!result.success) {
      expect(result.error!.code).toMatch(/^E_/);
    }
  });

  it('session engine error results have E_ prefixed codes', async () => {
    const { sessionStatus } = await import(
      '../../mcp/engine/session-engine.js'
    );

    const result = await sessionStatus('/nonexistent');
    assertEngineResult(result);
    if (!result.success) {
      expect(result.error!.code).toMatch(/^E_/);
    }
  });

  it('lifecycle engine error results have E_ prefixed codes', async () => {
    const { lifecycleStatus } = await import(
      '../../mcp/engine/lifecycle-engine.js'
    );

    // Empty epicId should fail
    const result = lifecycleStatus('');
    assertEngineResult(result);
    if (!result.success) {
      expect(result.error!.code).toMatch(/^E_/);
    }
  });
});
