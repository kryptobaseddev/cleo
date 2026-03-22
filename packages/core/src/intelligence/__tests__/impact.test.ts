/**
 * Tests for impact analysis module.
 *
 * Covers:
 *   - Simple dependency chains (A->B->C)
 *   - Complex graphs (diamond dependencies)
 *   - Each change type (cancel, block, complete, reprioritize)
 *   - Blast radius calculation
 *   - Critical path detection
 *   - Edge cases (orphan tasks, circular refs, no deps)
 *   - predictImpact: free-text change description matching (T043)
 *
 * @module intelligence
 */

import type { DataAccessor, Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  analyzeChangeImpact,
  analyzeTaskImpact,
  calculateBlastRadius,
  predictImpact,
} from '../impact.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: `Description for ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

/**
 * Create a mock DataAccessor that returns the given tasks.
 */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async () => ({ tasks, total: tasks.length }),
    loadSingleTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
    taskExists: async (id: string) => tasks.some((t) => t.id === id),
    upsertSingleTask: async () => {},
    deleteSingleTask: async () => true,
    close: async () => {},
  } as unknown as DataAccessor;
}

// ============================================================================
// analyzeTaskImpact
// ============================================================================

describe('analyzeTaskImpact', () => {
  it('returns empty assessment for non-existent task', async () => {
    const acc = mockAccessor([]);
    const result = await analyzeTaskImpact('T999', acc);

    expect(result.taskId).toBe('T999');
    expect(result.directDependents).toEqual([]);
    expect(result.transitiveDependents).toEqual([]);
    expect(result.blockedWorkCount).toBe(0);
    expect(result.isOnCriticalPath).toBe(false);
    expect(result.blastRadius.severity).toBe('isolated');
  });

  it('analyzes simple linear chain A->B->C', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.taskId).toBe('T001');
    expect(result.directDependents).toEqual(['T002']);
    expect(result.transitiveDependents.sort()).toEqual(['T002', 'T003']);
    expect(result.blockedWorkCount).toBe(2);
  });

  it('analyzes diamond dependency graph', async () => {
    // T001 -> T002 -> T004
    // T001 -> T003 -> T004
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T001'] }),
      makeTask({ id: 'T004', depends: ['T002', 'T003'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.directDependents.sort()).toEqual(['T002', 'T003']);
    expect(result.transitiveDependents.sort()).toEqual(['T002', 'T003', 'T004']);
    expect(result.blockedWorkCount).toBe(3);
  });

  it('excludes completed tasks from blocked work count', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'], status: 'done' }),
      makeTask({ id: 'T003', depends: ['T001'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.directDependents.sort()).toEqual(['T002', 'T003']);
    expect(result.blockedWorkCount).toBe(1); // T002 is done, only T003 counts
  });

  it('detects task on critical path', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004' }), // isolated, not on critical path
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.isOnCriticalPath).toBe(true);
  });

  it('detects task NOT on critical path', async () => {
    // T001 -> T002 -> T003 (critical path, length 3)
    // T004 (independent, shorter)
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004' }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T004', acc);

    expect(result.isOnCriticalPath).toBe(false);
  });

  it('finds affected pipelines via parent chain', async () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001', type: 'task' }),
      makeTask({ id: 'T003', parentId: 'T001', type: 'task', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T002', acc);

    expect(result.affectedPipelines).toContain('T001');
  });

  it('handles orphan task with no dependents', async () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const acc = mockAccessor(tasks);
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.directDependents).toEqual([]);
    expect(result.transitiveDependents).toEqual([]);
    expect(result.blockedWorkCount).toBe(0);
    expect(result.blastRadius.severity).toBe('isolated');
  });

  it('handles circular dependency gracefully', async () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const acc = mockAccessor(tasks);
    // Should not throw, BFS handles cycles via visited set
    const result = await analyzeTaskImpact('T001', acc);

    expect(result.directDependents).toContain('T002');
    expect(result.transitiveDependents).toContain('T002');
  });
});

// ============================================================================
// analyzeChangeImpact
// ============================================================================

describe('analyzeChangeImpact', () => {
  it('returns empty for non-existent task', async () => {
    const acc = mockAccessor([]);
    const result = await analyzeChangeImpact('T999', 'cancel', acc);

    expect(result.affectedTasks).toEqual([]);
    expect(result.cascadeDepth).toBe(0);
    expect(result.recommendation).toContain('not found');
  });

  describe('cancel', () => {
    it('identifies orphaned dependents when sole dependency cancelled', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T002', depends: ['T001'], status: 'blocked' }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'cancel', acc);

      expect(result.affectedTasks).toHaveLength(1);
      expect(result.affectedTasks[0].id).toBe('T002');
      expect(result.affectedTasks[0].newStatus).toBe('pending');
      expect(result.affectedTasks[0].reason).toContain('orphaned');
    });

    it('identifies tasks with remaining dependencies', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T003' }),
        makeTask({ id: 'T002', depends: ['T001', 'T003'] }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'cancel', acc);

      expect(result.affectedTasks).toHaveLength(1);
      expect(result.affectedTasks[0].reason).toContain('other dependencies remain');
    });

    it('skips already-completed dependents', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T002', depends: ['T001'], status: 'done' }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'cancel', acc);

      expect(result.affectedTasks).toEqual([]);
    });
  });

  describe('block', () => {
    it('cascade-blocks all downstream tasks', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T002', depends: ['T001'] }),
        makeTask({ id: 'T003', depends: ['T002'] }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'block', acc);

      expect(result.affectedTasks).toHaveLength(2);
      expect(result.affectedTasks.every((t) => t.newStatus === 'blocked')).toBe(true);
    });

    it('includes direct dependency reason', async () => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002', depends: ['T001'] })];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'block', acc);

      expect(result.affectedTasks[0].reason).toContain('Direct dependency blocked');
    });
  });

  describe('complete', () => {
    it('unblocks tasks whose last dependency is completed', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T002', depends: ['T001'], status: 'blocked' }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'complete', acc);

      expect(result.affectedTasks).toHaveLength(1);
      expect(result.affectedTasks[0].id).toBe('T002');
      expect(result.affectedTasks[0].newStatus).toBe('pending');
      expect(result.affectedTasks[0].reason).toContain('unblocked');
    });

    it('reports partially unblocked tasks with remaining deps', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T003' }),
        makeTask({ id: 'T002', depends: ['T001', 'T003'], status: 'blocked' }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'complete', acc);

      expect(result.affectedTasks).toHaveLength(1);
      expect(result.affectedTasks[0].reason).toContain('1 other dependency');
    });
  });

  describe('reprioritize', () => {
    it('flags downstream tasks for reordering', async () => {
      const tasks = [
        makeTask({ id: 'T001' }),
        makeTask({ id: 'T002', depends: ['T001'] }),
        makeTask({ id: 'T003', depends: ['T002'] }),
      ];
      const acc = mockAccessor(tasks);
      const result = await analyzeChangeImpact('T001', 'reprioritize', acc);

      expect(result.affectedTasks).toHaveLength(2);
      expect(result.affectedTasks.every((t) => t.reason.includes('reprioritized'))).toBe(true);
    });
  });

  it('computes cascade depth correctly', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004', depends: ['T003'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await analyzeChangeImpact('T001', 'block', acc);

    expect(result.cascadeDepth).toBe(3);
  });

  it('generates recommendation text', async () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002', depends: ['T001'] })];
    const acc = mockAccessor(tasks);
    const result = await analyzeChangeImpact('T001', 'block', acc);

    expect(result.recommendation).toContain('blocking');
    expect(result.recommendation).toContain('T001');
  });
});

// ============================================================================
// calculateBlastRadius
// ============================================================================

describe('calculateBlastRadius', () => {
  it('returns isolated for non-existent task', async () => {
    const acc = mockAccessor([]);
    const result = await calculateBlastRadius('T999', acc);

    expect(result.directCount).toBe(0);
    expect(result.transitiveCount).toBe(0);
    expect(result.severity).toBe('isolated');
  });

  it('computes correct counts for linear chain', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.directCount).toBe(1);
    expect(result.transitiveCount).toBe(2);
  });

  it('computes correct counts for diamond dependency', async () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T001'] }),
      makeTask({ id: 'T004', depends: ['T002', 'T003'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.directCount).toBe(2);
    expect(result.transitiveCount).toBe(3);
  });

  it('counts affected epics', async () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001', type: 'task' }),
      makeTask({ id: 'T003', parentId: 'T001', type: 'task', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T002', acc);

    expect(result.epicCount).toBeGreaterThanOrEqual(1);
  });

  it('calculates project percentage', async () => {
    // 3 out of 10 tasks affected = 30%
    const tasks: Task[] = [];
    for (let i = 1; i <= 10; i++) {
      tasks.push(
        makeTask({
          id: `T${String(i).padStart(3, '0')}`,
          depends: i > 1 && i <= 4 ? [`T${String(i - 1).padStart(3, '0')}`] : undefined,
        }),
      );
    }
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    // T001 -> T002 -> T003 -> T004 (transitive: T002, T003, T004 = 3 tasks)
    expect(result.transitiveCount).toBe(3);
    expect(result.projectPercentage).toBe(30);
  });

  it('classifies severity as isolated for 0%', async () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.severity).toBe('isolated');
  });

  it('classifies severity as moderate for 2-10%', async () => {
    // 1 out of 20 = 5%
    const tasks: Task[] = [];
    for (let i = 1; i <= 20; i++) {
      tasks.push(makeTask({ id: `T${String(i).padStart(3, '0')}` }));
    }
    // Make T002 depend on T001
    tasks[1] = makeTask({ id: 'T002', depends: ['T001'] });
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.severity).toBe('moderate');
  });

  it('classifies severity as critical for >30%', async () => {
    // Chain of 4 out of 5 tasks = 60%
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004', depends: ['T003'] }),
      makeTask({ id: 'T005' }),
    ];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.severity).toBe('critical');
  });

  it('handles orphan task with no dependents', async () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
    const acc = mockAccessor(tasks);
    const result = await calculateBlastRadius('T001', acc);

    expect(result.directCount).toBe(0);
    expect(result.transitiveCount).toBe(0);
    expect(result.severity).toBe('isolated');
  });

  it('handles circular dependency without infinite loop', async () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const acc = mockAccessor(tasks);
    // Should complete without hanging.
    // In a cycle, both tasks appear in the transitive closure
    // because BFS from T001 finds T002 (direct dep), then from T002
    // finds T001 (since T001 depends on T002), yielding 2.
    const result = await calculateBlastRadius('T001', acc);

    expect(result.directCount).toBe(1);
    expect(result.transitiveCount).toBe(2);
  });
});

// ============================================================================
// predictImpact (T043)
// ============================================================================

describe('predictImpact', () => {
  it('returns empty report when no tasks match the change description', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Set up CI pipeline', description: 'Configure CI runner' }),
      makeTask({ id: 'T002', title: 'Write unit tests', description: 'Add test coverage' }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('authentication login oauth', undefined, acc);

    expect(result.change).toBe('authentication login oauth');
    expect(result.matchedTasks).toHaveLength(0);
    expect(result.affectedTasks).toHaveLength(0);
    expect(result.totalAffected).toBe(0);
    expect(result.summary).toContain('No tasks matched');
  });

  it('returns direct match when task title contains change keywords', async () => {
    const tasks = [
      makeTask({
        id: 'T001',
        title: 'Implement authentication module',
        description: 'Add JWT auth',
      }),
      makeTask({ id: 'T002', title: 'Set up database schema', description: 'Create tables' }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('authentication module', undefined, acc);

    expect(result.matchedTasks).toHaveLength(1);
    expect(result.matchedTasks[0]?.id).toBe('T001');
    expect(result.matchedTasks[0]?.exposure).toBe('direct');
    expect(result.totalAffected).toBe(1);
  });

  it('traces downstream dependents from matched seed tasks', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'authentication service implementation', description: '' }),
      makeTask({
        id: 'T002',
        title: 'User login form',
        description: 'Depends on auth service',
        depends: ['T001'],
      }),
      makeTask({
        id: 'T003',
        title: 'Dashboard access control',
        description: 'Requires user login',
        depends: ['T002'],
      }),
      makeTask({
        id: 'T004',
        title: 'Unrelated database migration',
        description: 'Schema changes',
      }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('authentication service', undefined, acc);

    // T001 is the direct match (seed)
    expect(result.matchedTasks.map((t) => t.id)).toContain('T001');

    // T002 and T003 should be in affectedTasks as dependents/transitive
    const ids = result.affectedTasks.map((t) => t.id);
    expect(ids).toContain('T001');
    expect(ids).toContain('T002');
    expect(ids).toContain('T003');
    // T004 is unrelated and should not appear
    expect(ids).not.toContain('T004');
  });

  it('classifies exposure correctly: direct, dependent, transitive', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'auth login service', description: '' }),
      makeTask({ id: 'T002', title: 'Session management', description: '', depends: ['T001'] }),
      makeTask({ id: 'T003', title: 'Profile page', description: '', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('auth login', undefined, acc);

    const t1 = result.affectedTasks.find((t) => t.id === 'T001');
    const t2 = result.affectedTasks.find((t) => t.id === 'T002');
    const t3 = result.affectedTasks.find((t) => t.id === 'T003');

    expect(t1?.exposure).toBe('direct');
    expect(t2?.exposure).toBe('dependent');
    expect(t3?.exposure).toBe('transitive');
  });

  it('sorts affectedTasks: direct first, then dependent, then transitive', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'auth service core', description: '' }),
      makeTask({ id: 'T002', title: 'Login controller', description: '', depends: ['T001'] }),
      makeTask({ id: 'T003', title: 'Session store', description: '', depends: ['T002'] }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('auth service', undefined, acc);

    const exposures = result.affectedTasks.map((t) => t.exposure);
    // direct must come before dependent which must come before transitive
    const directIdx = exposures.indexOf('direct');
    const dependentIdx = exposures.indexOf('dependent');
    const transitiveIdx = exposures.indexOf('transitive');

    if (directIdx !== -1 && dependentIdx !== -1) {
      expect(directIdx).toBeLessThan(dependentIdx);
    }
    if (dependentIdx !== -1 && transitiveIdx !== -1) {
      expect(dependentIdx).toBeLessThan(transitiveIdx);
    }
  });

  it('respects matchLimit parameter', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'auth module setup', description: '' }),
      makeTask({ id: 'T002', title: 'auth token generation', description: '' }),
      makeTask({ id: 'T003', title: 'auth session management', description: '' }),
    ];
    const acc = mockAccessor(tasks);

    // Limit to 1 seed
    const result = await predictImpact('auth', undefined, acc, 1);

    // Only 1 direct match seeded
    expect(result.matchedTasks).toHaveLength(1);
  });

  it('produces a meaningful summary string', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'auth service', description: '' }),
      makeTask({ id: 'T002', title: 'Login page', description: '', depends: ['T001'] }),
    ];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('auth service', undefined, acc);

    expect(result.summary).toContain('auth service');
    expect(result.summary).toMatch(/\d+ task/);
  });

  it('downstreamCount is 0 for leaf tasks with no dependents', async () => {
    const tasks = [makeTask({ id: 'T001', title: 'auth service core', description: '' })];
    const acc = mockAccessor(tasks);

    const result = await predictImpact('auth service', undefined, acc);

    expect(result.affectedTasks[0]?.downstreamCount).toBe(0);
  });
});
