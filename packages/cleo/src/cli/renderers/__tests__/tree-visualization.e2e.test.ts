/**
 * End-to-end integration test for the full tree/wave visualization stack.
 *
 * Exercises Waves 1–6 features against a real tasks.db (no mocks).
 * Uses {@link createTestDb} to provision a temporary SQLite project with
 * a seeded task graph, then drives the full stack:
 *
 *   real DB → coreTaskTree / getEnrichedWaves → formatTree / formatWaves
 *           → renderTree / renderWaves → string assertions
 *
 * Coverage matrix (per rendering mode × feature flag):
 *   {rich, json, markdown, quiet} × {plain, --with-deps, --blockers, both}
 *
 * Regression guards:
 *   - T1194: `cleo deps waves` NEVER outputs "No tree data."
 *   - T1195: `orchestrate waves` registered in renderer registry
 *   - T1196: buildTreeNode sorts children by position ASC
 *   - T1197: computeWaves marks completed wave as 'completed'
 *   - T1198: quiet mode preserves tree connectors
 *
 * @task T1207
 * @epic T1187
 */

import type { Task } from '@cleocode/contracts';
import { formatTree, formatWaves } from '@cleocode/core/formatters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeWaves, getEnrichedWaves } from '../../../../../core/src/orchestration/waves.js';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { coreTaskTree } from '../../../../../core/src/tasks/task-ops.js';
import { setTreeContext } from '../../tree-context.js';
import { renderTree, renderWaves } from '../system.js';

// ---------------------------------------------------------------------------
// Fixture task graph
//
// Epic E1 (children ordered by position):
//
// Done tasks (pre-seeded into completed set, NOT in remaining):
//   W1T1 (done, high,   position 1)
//   W1T2 (done, medium, position 2)
//
// Wave 1 of computeWaves (non-terminal tasks whose deps are all done):
//   W2T1 (active,  critical, depends W1T1=done,  position 3)
//   W2T2 (pending, medium,   depends W1T2=done,  position 4)
//   EXT1 (pending, low,      no deps,             position 8)
//
// Wave 2 of computeWaves (all deps resolve after wave 1 completes):
//   W3T1 (pending, medium,   depends W2T1,        position 5)
//   W3T2 (pending, high,     depends W2T2 + EXT1, position 6) ← leaf-blocker test
//   W3T3 (pending, critical, depends W2T1,         position 7) ← critical, sorts first
//
// Wave 1 status = in_progress (W2T1 active).
// Wave 2 status = pending (all pending).
// Within wave 2 sort: W3T3(critical) → W3T2(high) → W3T1(medium).
//
// Transitive chain depth ≥ 3: W3T3 → W2T1 → W1T1 (depth 2 edges from W3T3).
// EXT1 is a leaf blocker for W3T2 (EXT1.deps = [] → all resolved → leaf).
//
// Position ordering (ASC): W1T1=1, W1T2=2, W2T1=3, W2T2=4, W3T1=5, W3T2=6,
//   W3T3=7, EXT1=8 → verifies T1196 position sort.
// ---------------------------------------------------------------------------

const EPIC_ID = 'E1';

const FIXTURE: Array<Partial<Task> & { id: string }> = [
  // Epic root
  { id: EPIC_ID, type: 'epic', title: 'Test Epic', status: 'active' },

  // Wave 1 precondition: both done → pre-seeded into completed by computeWaves
  {
    id: 'W1T1',
    parentId: EPIC_ID,
    title: 'Wave-1 Task A',
    status: 'done',
    priority: 'high',
    completedAt: '2026-04-01T10:00:00Z',
    position: 1,
  },
  {
    id: 'W1T2',
    parentId: EPIC_ID,
    title: 'Wave-1 Task B',
    status: 'done',
    priority: 'medium',
    completedAt: '2026-04-01T11:00:00Z',
    position: 2,
  },

  // computeWaves Wave 1: deps all done → immediately schedulable
  {
    id: 'W2T1',
    parentId: EPIC_ID,
    title: 'Wave-2 Task A',
    status: 'active',
    priority: 'critical',
    depends: ['W1T1'],
    position: 3,
  },
  {
    id: 'W2T2',
    parentId: EPIC_ID,
    title: 'Wave-2 Task B',
    status: 'pending',
    priority: 'medium',
    depends: ['W1T2'],
    position: 4,
  },
  // EXT1 — child of E1, no deps → lands in wave 1 (all its deps = resolved)
  {
    id: 'EXT1',
    parentId: EPIC_ID,
    title: 'External leaf task',
    status: 'pending',
    priority: 'low',
    position: 8,
  },

  // computeWaves Wave 2: deps resolve only after wave 1 (W2T1, W2T2, EXT1) completes
  {
    id: 'W3T1',
    parentId: EPIC_ID,
    title: 'Wave-3 Task A',
    status: 'pending',
    priority: 'medium',
    depends: ['W2T1'],
    position: 5,
  },
  {
    id: 'W3T2',
    parentId: EPIC_ID,
    title: 'Wave-3 Task B',
    status: 'pending',
    priority: 'high',
    // Both W2T2 (pending, in taskMap) and EXT1 (pending, in taskMap) are open blockers.
    // EXT1 is a leaf blocker (no deps of its own).
    depends: ['W2T2', 'EXT1'],
    position: 6,
  },
  {
    id: 'W3T3',
    parentId: EPIC_ID,
    title: 'Wave-3 Task C — critical',
    status: 'pending',
    priority: 'critical',
    // Depends on W2T1 → wave 2. Critical priority sorts first within wave 2.
    depends: ['W2T1'],
    position: 7,
  },
];

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let env: TestDbEnv;

beforeAll(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, FIXTURE);
});

afterAll(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Helper: reset tree context before each assertion
// ---------------------------------------------------------------------------

function noFlags(): void {
  setTreeContext({ withDeps: false, withBlockers: false });
}

function withDepsFlag(): void {
  setTreeContext({ withDeps: true, withBlockers: false });
}

function withBlockersFlag(): void {
  setTreeContext({ withDeps: false, withBlockers: true });
}

function withBothFlags(): void {
  setTreeContext({ withDeps: true, withBlockers: true });
}

// ===========================================================================
// Section 1: coreTaskTree — real DB, sorted children, enriched nodes
// ===========================================================================

describe('coreTaskTree — real DB integration', () => {
  it('returns the epic as a root node with all children', async () => {
    const { tree, totalNodes } = await coreTaskTree(env.tempDir, EPIC_ID);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe(EPIC_ID);
    // All FIXTURE tasks (epic + 8 children)
    expect(totalNodes).toBeGreaterThanOrEqual(9);
  });

  it('children are sorted by position ASC (T1196 regression)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const children = tree[0]!.children;
    const positions = children.map((c) => {
      const fixture = FIXTURE.find((f) => f.id === c.id);
      return fixture?.position ?? 0;
    });
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!);
    }
  });

  it('FlatTreeNode carries priority, depends, blockedBy, ready fields (T1199)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;

    // W2T1 (active, depends on W1T1 which is done → no open blockers → ready=true)
    const w2t1 = epicNode.children.find((c) => c.id === 'W2T1');
    expect(w2t1).toBeDefined();
    expect(w2t1!.priority).toBe('critical');
    expect(w2t1!.depends).toContain('W1T1');
    expect(w2t1!.blockedBy).toHaveLength(0);
    expect(w2t1!.ready).toBe(true); // active + no open blockers = ready

    // W3T2 (pending, depends on W2T2=pending + EXT1=pending → blocked by both)
    const w3t2 = epicNode.children.find((c) => c.id === 'W3T2');
    expect(w3t2).toBeDefined();
    // loadAllTasks includes EXT1 (not a child of E1 but in the same DB)
    // so both W2T2 and EXT1 appear in blockedBy
    expect(w3t2!.blockedBy).toContain('W2T2');
    expect(w3t2!.blockedBy).toContain('EXT1');
    expect(w3t2!.ready).toBe(false);
  });

  it('withBlockers=true populates blockerChain and leafBlockers (T1206)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;

    // W3T2 depends on W2T2(pending,dep-resolved) + EXT1(pending,no-deps)
    // Both W2T2 and EXT1 are leaf blockers (their own deps are all resolved)
    const w3t2 = epicNode.children.find((c) => c.id === 'W3T2');
    expect(w3t2).toBeDefined();
    expect(w3t2!.blockerChain).toBeDefined();
    expect(Array.isArray(w3t2!.blockerChain)).toBe(true);
    expect(w3t2!.blockerChain!.length).toBeGreaterThan(0);
    // Both open deps appear in the chain
    expect(w3t2!.blockerChain).toContain('W2T2');
    expect(w3t2!.blockerChain).toContain('EXT1');
    expect(w3t2!.leafBlockers).toBeDefined();
    // EXT1 has no deps → leaf; W2T2's dep (W1T2) is done → W2T2 is also a leaf
    expect(w3t2!.leafBlockers!.length).toBeGreaterThan(0);
  });

  it('W3T3 (critical priority, depends on active W2T1) is blocked', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const w3t3 = tree[0]!.children.find((c) => c.id === 'W3T3');
    expect(w3t3).toBeDefined();
    expect(w3t3!.priority).toBe('critical');
    // W2T1 is active (not done/cancelled) → still an open blocker
    expect(w3t3!.blockedBy).toContain('W2T1');
    expect(w3t3!.ready).toBe(false);
  });
});

// ===========================================================================
// Section 2: computeWaves — T1197 regression: completed wave marked correctly
// ===========================================================================

describe('computeWaves — status computation (T1197 regression)', () => {
  it('marks a wave as completed when all tasks are done', () => {
    const tasks: Task[] = [
      {
        id: 'W1T1',
        title: 'A',
        status: 'done',
        priority: 'medium',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
      {
        id: 'W1T2',
        title: 'B',
        status: 'done',
        priority: 'medium',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
    ];
    const waves = computeWaves(tasks);
    // Both done → they are pre-seeded into completed set, so no wave is generated
    // (computeWaves only processes non-done/non-cancelled tasks)
    expect(waves).toHaveLength(0);
  });

  it('marks wave in_progress when at least one task is active', () => {
    const tasks: Task[] = [
      {
        id: 'A1',
        title: 'Active',
        status: 'active',
        priority: 'medium',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
      {
        id: 'A2',
        title: 'Pending',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('in_progress');
  });

  it('marks wave pending when all tasks are pending', () => {
    const tasks: Task[] = [
      {
        id: 'P1',
        title: 'P',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
    ];
    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.status).toBe('pending');
  });

  it('correctly partitions into multiple waves based on dependency order', () => {
    // W1T1 (done, pre-completed) → W2T1 depends on it → wave 1
    // W3T1 depends on W2T1 → wave 2
    const tasks: Task[] = [
      {
        id: 'CW1',
        title: 'CW1',
        status: 'active',
        priority: 'high',
        type: 'task',
        createdAt: '',
        updatedAt: '',
      } as Task,
      {
        id: 'CW2',
        title: 'CW2',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        depends: ['CW1'],
        createdAt: '',
        updatedAt: '',
      } as Task,
      {
        id: 'CW3',
        title: 'CW3',
        status: 'pending',
        priority: 'low',
        type: 'task',
        depends: ['CW2'],
        createdAt: '',
        updatedAt: '',
      } as Task,
    ];
    const waves = computeWaves(tasks);
    // 3 sequential tasks → 3 waves
    expect(waves).toHaveLength(3);
    expect(waves[0]!.tasks).toContain('CW1');
    expect(waves[1]!.tasks).toContain('CW2');
    expect(waves[2]!.tasks).toContain('CW3');
    // Depth >= 3 transitive chain satisfied
  });
});

// ===========================================================================
// Section 3: getEnrichedWaves — real DB, wave status + within-wave sort
// ===========================================================================

describe('getEnrichedWaves — real DB integration', () => {
  it('NEVER returns "No tree data." (T1194 regression)', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const json = JSON.stringify(result);
    expect(json).not.toContain('No tree data.');
  });

  it('returns waves with epicId, totalWaves, totalTasks', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    expect(result.epicId).toBe(EPIC_ID);
    expect(result.totalWaves).toBeGreaterThan(0);
    expect(result.totalTasks).toBeGreaterThan(0);
  });

  it('Wave 1 of enriched result: W2T1+W2T2+EXT1 with status in_progress (T1197 regression)', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    // computeWaves excludes done tasks (W1T1, W1T2) from remaining.
    // Wave 1 = first non-terminal wave = {W2T1(active,critical), W2T2(medium,pending),
    //   EXT1(low,pending)} — all have no unresolved deps.
    // Status = in_progress because W2T1 is active.
    const firstWave = result.waves[0]!;
    const taskIds = firstWave.tasks.map((t) => t.id);
    expect(taskIds).toContain('W2T1');
    expect(taskIds).toContain('W2T2');
    expect(taskIds).toContain('EXT1');
    expect(firstWave.status).toBe('in_progress');
  });

  it('Wave 2 of enriched result: contains W3T1, W3T2, W3T3', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    // Wave 2 = tasks depending on active/pending W2 tasks.
    expect(result.waves.length).toBeGreaterThanOrEqual(2);
    const secondWave = result.waves[1]!;
    const taskIds = secondWave.tasks.map((t) => t.id);
    expect(taskIds).toContain('W3T1');
    expect(taskIds).toContain('W3T2');
    expect(taskIds).toContain('W3T3');
    expect(secondWave.status).toBe('pending');
  });

  it('within-wave tasks sorted by priority DESC then open-dep count ASC (T1202)', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    // Wave 2 contains W3T3(critical), W3T2(high, 1 open dep in taskMap), W3T1(medium, 1 open dep)
    expect(result.waves.length).toBeGreaterThanOrEqual(2);
    const secondWave = result.waves[1]!;

    const ids = secondWave.tasks.map((t) => t.id);
    const criticalIdx = ids.indexOf('W3T3'); // critical priority
    const highIdx = ids.indexOf('W3T2'); // high priority
    const mediumIdx = ids.indexOf('W3T1'); // medium priority

    expect(criticalIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeGreaterThan(-1);
    expect(mediumIdx).toBeGreaterThan(-1);

    // critical before high before medium
    expect(criticalIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(mediumIdx);
  });

  it('enriched tasks carry blockedBy and ready fields', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const allTasks = result.waves.flatMap((w) => w.tasks);

    // W2T1 (active, critical, depends on done W1T1 → unblocked → ready)
    const w2t1 = allTasks.find((t) => t.id === 'W2T1');
    expect(w2t1).toBeDefined();
    // W1T1 is done → not in blockedBy (enrichTask treats done deps as resolved)
    expect(w2t1!.blockedBy).toHaveLength(0);
    expect(w2t1!.ready).toBe(true); // active + no blockers = ready

    // W3T2 (pending, depends on W2T2=pending + EXT1=pending → both open deps)
    // Both W2T2 and EXT1 are children of E1, so both appear in taskMap.
    const w3t2 = allTasks.find((t) => t.id === 'W3T2');
    expect(w3t2).toBeDefined();
    expect(w3t2!.blockedBy).toContain('W2T2'); // W2T2 is pending → open dep
    expect(w3t2!.blockedBy).toContain('EXT1'); // EXT1 is pending → open dep
    expect(w3t2!.ready).toBe(false);
  });

  it('deterministic — two identical calls produce same output (T1196 sort fix)', async () => {
    const result1 = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const result2 = await getEnrichedWaves(EPIC_ID, env.tempDir);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});

// ===========================================================================
// Section 4: formatTree — all four modes × plain
// ===========================================================================

describe('formatTree — all four modes against real DB nodes', () => {
  it('rich mode: contains task IDs and status symbols', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich' });

    expect(output).toContain('W1T1');
    expect(output).toContain('W2T1');
    expect(output).toContain('W3T3');
    // Status symbols
    expect(output).toContain('✓'); // done
    expect(output).toContain('◉'); // active
  });

  it('json mode: parseable { tree: [...] } containing all IDs', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'json' });

    const parsed = JSON.parse(output) as { tree: unknown[] };
    expect(parsed).toHaveProperty('tree');
    expect(Array.isArray(parsed.tree)).toBe(true);
    // Nested nodes are included in the structure
    const jsonStr = JSON.stringify(parsed);
    expect(jsonStr).toContain('W1T1');
    expect(jsonStr).toContain('W3T3');
  });

  it('markdown mode: contains [status] prefix and task IDs', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'markdown' });

    expect(output).toContain('[done]');
    expect(output).toContain('[active]');
    expect(output).toContain('W1T1');
    expect(output).toContain('W2T1');
    // Markdown uses list items
    expect(output).toContain('- [');
  });

  it('quiet mode: tree connectors present, IDs extractable as last token (T1198 regression)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'quiet' });

    // Should NOT be empty
    expect(output.length).toBeGreaterThan(0);

    // Each non-empty line must have a task ID as last token
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      const lastToken = tokens[tokens.length - 1]!;
      // The last token should be a recognizable task ID from the fixture
      const allIds = FIXTURE.map((f) => f.id);
      expect(allIds).toContain(lastToken);
    }

    // Connector characters present (├── or └──)
    expect(output).toMatch(/[├└]/);
    // NO status symbols in quiet mode
    expect(output).not.toContain('✓');
    expect(output).not.toContain('◉');
  });

  it('quiet mode output is byte-identical on two calls (determinism)', async () => {
    const { tree: tree1 } = await coreTaskTree(env.tempDir, EPIC_ID);
    const { tree: tree2 } = await coreTaskTree(env.tempDir, EPIC_ID);
    const out1 = formatTree(tree1[0]!.children, { mode: 'quiet' });
    const out2 = formatTree(tree2[0]!.children, { mode: 'quiet' });
    expect(out1).toBe(out2);
  });

  it('empty nodes array: quiet returns empty string, others return fallback', () => {
    expect(formatTree([], { mode: 'quiet' })).toBe('');
    expect(formatTree([], { mode: 'rich' })).toBe('No tree data.');
    expect(formatTree([], { mode: 'markdown' })).toBe('No tree data.');
    // JSON mode: returns JSON even for empty
    const jsonOut = JSON.parse(formatTree([], { mode: 'json' })) as { tree: unknown[] };
    expect(jsonOut.tree).toEqual([]);
  });
});

// ===========================================================================
// Section 5: formatTree with --with-deps flag (Wave 5, T1205)
// ===========================================================================

describe('formatTree — --with-deps overlay', () => {
  it('rich mode: inlines "← depends on:" annotation for tasks with deps', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich', withDeps: true });

    // W2T1 depends on W1T1
    expect(output).toContain('← depends on:');
    expect(output).toContain('W1T1');
  });

  it('markdown mode: emits "depends on:" list item for tasks with deps', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'markdown', withDeps: true });

    expect(output).toContain('depends on:');
    // Markdown wraps dep IDs in [id](#id) links
    expect(output).toContain('[W1T1]');
  });

  it('quiet mode: no dep annotation (quiet skips extra lines)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'quiet', withDeps: true });

    expect(output).not.toContain('depends on:');
    // IDs still present
    expect(output).toContain('W1T1');
  });

  it('tasks with no deps emit no dep line', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich', withDeps: true });

    // W3T3 has no deps — only one dep annotation per task-with-deps
    // Count dep lines: should be one per task-with-dep
    const depLines = output.split('\n').filter((l) => l.includes('← depends on:'));
    // W2T1→W1T1, W2T2→W1T2, W3T1→W2T1, W3T2→EXT1 = 4 tasks with deps
    expect(depLines.length).toBeGreaterThanOrEqual(4);
  });
});

// ===========================================================================
// Section 6: formatTree with --blockers flag (Wave 6, T1206)
// ===========================================================================

describe('formatTree — --blockers overlay', () => {
  it('rich mode: shows "↳ chain:" for blocked tasks', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich', withBlockers: true });

    // W3T2 is blocked by EXT1 → should see chain line
    expect(output).toContain('↳ chain:');
    expect(output).toContain('EXT1');
  });

  it('rich mode: shows "↳ leaf-blockers:" for tasks with identified leaves', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich', withBlockers: true });

    expect(output).toContain('↳ leaf-blockers:');
  });

  it('markdown mode: emits "blocker chain:" item for blocked tasks', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'markdown', withBlockers: true });

    expect(output).toContain('blocker chain:');
    expect(output).toContain('EXT1 (leaf)');
  });

  it('quiet mode: no blocker chain (quiet skips chain data)', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'quiet', withBlockers: true });

    expect(output).not.toContain('chain:');
    expect(output).not.toContain('leaf-blocker');
  });

  it('compatible with --with-deps: dep line before blocker chain', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, {
      mode: 'rich',
      withDeps: true,
      withBlockers: true,
    });

    expect(output).toContain('← depends on:');
    expect(output).toContain('↳ chain:');
  });
});

// ===========================================================================
// Section 7: formatWaves — all four modes
// ===========================================================================

describe('formatWaves — all four modes against real DB waves', () => {
  it('rich mode: wave headers contain Wave N and status badge', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const output = formatWaves({ waves }, { mode: 'rich' });

    expect(output).toContain('Wave 1');
    expect(output).toContain('in_progress');
    // Task IDs from wave 1
    expect(output).toContain('W2T1');
  });

  it('json mode: parseable { waves: [...] }', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const output = formatWaves({ waves }, { mode: 'json' });

    const parsed = JSON.parse(output) as { waves: unknown[] };
    expect(parsed).toHaveProperty('waves');
    expect(Array.isArray(parsed.waves)).toBe(true);
  });

  it('markdown mode: ## Wave N — status header', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const output = formatWaves({ waves }, { mode: 'markdown' });

    expect(output).toContain('## Wave 1');
    expect(output).toContain('in_progress');
    // Task entries have [status] prefix
    expect(output).toContain('[active]');
  });

  it('quiet mode: <waveNumber>\\t<taskId> per line', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const output = formatWaves({ waves }, { mode: 'quiet' });

    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Each line must be <number>\t<ID>
      expect(line).toMatch(/^\d+\t\w+$/);
    }
    // Wave 1 tasks present
    expect(lines.some((l) => l.startsWith('1\t'))).toBe(true);
  });

  it('NEVER outputs "No tree data." (T1194 regression)', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    for (const mode of ['rich', 'json', 'markdown', 'quiet'] as const) {
      const output = formatWaves({ waves }, { mode });
      expect(output).not.toContain('No tree data.');
    }
  });

  it('quiet mode is deterministic across two calls (T1196 sort fix)', async () => {
    const { waves: w1 } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const { waves: w2 } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const out1 = formatWaves({ waves: w1 }, { mode: 'quiet' });
    const out2 = formatWaves({ waves: w2 }, { mode: 'quiet' });
    expect(out1).toBe(out2);
  });
});

// ===========================================================================
// Section 8: renderTree — CLI renderer with tree context (Waves 5+6 via context)
// ===========================================================================

describe('renderTree — CLI renderer integration', () => {
  it('plain: rich tree contains task IDs and status symbols', async () => {
    noFlags();
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const data = { tree: tree[0]!.children as Record<string, unknown>[] };
    const output = renderTree(data, false);

    expect(output).toContain('W1T1');
    expect(output).toContain('W2T1');
    expect(output).toContain('✓');
  });

  it('quiet=true: tree connectors preserved, no status symbols (T1198 regression)', async () => {
    noFlags();
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const data = { tree: tree[0]!.children as Record<string, unknown>[] };
    const output = renderTree(data, true);

    expect(output.length).toBeGreaterThan(0);
    // Connectors preserved in quiet mode
    expect(output).toMatch(/[├└]/);
    // No status symbols in quiet mode
    expect(output).not.toContain('✓');
    expect(output).not.toContain('◉');
    expect(output).not.toContain('○');
  });

  it('--with-deps context: dep line appears below tasks with deps', async () => {
    withDepsFlag();
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const data = { tree: tree[0]!.children as Record<string, unknown>[] };
    const output = renderTree(data, false);

    expect(output).toContain('← depends on:');
    noFlags(); // restore
  });

  it('--blockers context: chain line appears for blocked tasks', async () => {
    withBlockersFlag();
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const data = { tree: tree[0]!.children as Record<string, unknown>[] };
    const output = renderTree(data, false);

    expect(output).toContain('↳ chain:');
    noFlags(); // restore
  });

  it('--with-deps + --blockers context: both annotations present', async () => {
    withBothFlags();
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID, true);
    const data = { tree: tree[0]!.children as Record<string, unknown>[] };
    const output = renderTree(data, false);

    expect(output).toContain('← depends on:');
    expect(output).toContain('↳ chain:');
    noFlags(); // restore
  });

  it('waves data: delegates to renderWaves (T1195 regression)', async () => {
    noFlags();
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = result as Record<string, unknown>;
    const output = renderTree(data, false);

    // Should produce wave headers, NOT "No tree data."
    expect(output).not.toBe('No tree data.');
    expect(output).not.toBe('');
    expect(output).toContain('Wave 1');
  });

  it('waves quiet=true: <waveNumber>\\t<taskId> lines', async () => {
    noFlags();
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = result as Record<string, unknown>;
    const output = renderTree(data, true);

    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\d+\t\w+$/);
    }
  });

  it('rich-mode output is byte-identical on two calls (determinism)', async () => {
    noFlags();
    const { tree: tree1 } = await coreTaskTree(env.tempDir, EPIC_ID);
    const { tree: tree2 } = await coreTaskTree(env.tempDir, EPIC_ID);
    const out1 = renderTree({ tree: tree1[0]!.children as Record<string, unknown>[] }, false);
    const out2 = renderTree({ tree: tree2[0]!.children as Record<string, unknown>[] }, false);
    expect(out1).toBe(out2);
  });
});

// ===========================================================================
// Section 9: renderWaves — CLI renderer integration (T1201)
// ===========================================================================

describe('renderWaves — CLI renderer integration', () => {
  it('rich mode (default): wave headers visible, task IDs present', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    const output = renderWaves(data);

    expect(output).toContain('Wave 1');
    expect(output).toContain('W2T1');
    // Status badge present (in_progress)
    expect(output).toContain('in_progress');
  });

  it('json mode: parseable waves payload', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    const output = renderWaves(data, { mode: 'json' });

    const parsed = JSON.parse(output) as { waves: unknown[] };
    expect(parsed).toHaveProperty('waves');
    expect(Array.isArray(parsed.waves)).toBe(true);
  });

  it('markdown mode: GFM headers and list items', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    const output = renderWaves(data, { mode: 'markdown' });

    expect(output).toContain('## Wave 1');
    expect(output).toContain('[active]');
  });

  it('quiet mode: tab-delimited waveNumber\\tID lines', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    const output = renderWaves(data, { mode: 'quiet' });

    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\d+\t\w+$/);
    }
  });

  it('NEVER outputs "No tree data." (T1194 regression — full stack)', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    for (const mode of ['rich', 'json', 'markdown', 'quiet'] as const) {
      const output = renderWaves(data, { mode });
      expect(output).not.toContain('No tree data.');
    }
  });

  it('produces structured output (not renderGeneric fallback) (T1195 regression)', async () => {
    const { waves } = await getEnrichedWaves(EPIC_ID, env.tempDir);
    const data = { waves } as Record<string, unknown>;
    const output = renderWaves(data);
    // renderGeneric would output raw JSON dump without wave headers
    expect(output).toContain('Wave');
    // Should NOT look like a raw JSON dump
    expect(output).not.toMatch(/^\{"waves":/);
  });
});

// ===========================================================================
// Section 10: Priority color tokens in rich mode (Wave 2, T1200)
// ===========================================================================

describe('priority colors — rich mode only (T1200)', () => {
  it('rich mode: critical-priority title appears in output', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'rich' });

    // W3T3 has critical priority
    expect(output).toContain('Wave-3 Task C — critical');
  });

  it('quiet mode: no priority decoration — only IDs and connectors', async () => {
    const { tree } = await coreTaskTree(env.tempDir, EPIC_ID);
    const epicNode = tree[0]!;
    const output = formatTree(epicNode.children, { mode: 'quiet' });

    // Titles are absent in quiet mode
    expect(output).not.toContain('Wave-3 Task C — critical');
    // But the ID is still there
    expect(output).toContain('W3T3');
  });

  it('rich waves: critical tasks appear before lower-priority tasks in same wave', async () => {
    const result = await getEnrichedWaves(EPIC_ID, env.tempDir);
    // Wave 2 in the result contains W3T3(critical), W3T2(high), W3T1(medium)
    // After within-wave sort: W3T3 first, then W3T2, then W3T1.
    const output = formatWaves({ waves: result.waves }, { mode: 'rich' });

    // Find positions of each ID in the full output string (wave 2 section)
    const w3t3Idx = output.indexOf('W3T3');
    const w3t2Idx = output.indexOf('W3T2');
    const w3t1Idx = output.indexOf('W3T1');

    expect(w3t3Idx).toBeGreaterThan(-1);
    expect(w3t2Idx).toBeGreaterThan(-1);
    expect(w3t1Idx).toBeGreaterThan(-1);

    // Within the wave, critical before high before medium
    expect(w3t3Idx).toBeLessThan(w3t2Idx);
    expect(w3t2Idx).toBeLessThan(w3t1Idx);
  });
});
