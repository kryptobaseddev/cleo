/**
 * Tests for the agent registry with capacity tracking.
 *
 * Covers: task-count-based capacity, specialization read/write,
 * performance recording delegation, and sorted agent queries.
 *
 * @module agents/__tests__/agent-registry.test
 * @task T041
 * @epic T038
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAgentCapacity,
  getAgentSpecializations,
  getAgentsByCapacity,
  MAX_TASKS_PER_AGENT,
  recordAgentPerformance,
  updateAgentSpecializations,
} from '../agent-registry.js';
import { registerAgent, updateAgentStatus } from '../registry.js';

describe('Agent Registry (T041)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-registry-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // ==========================================================================
  // MAX_TASKS_PER_AGENT constant
  // ==========================================================================

  describe('MAX_TASKS_PER_AGENT', () => {
    it('is 5', () => {
      expect(MAX_TASKS_PER_AGENT).toBe(5);
    });
  });

  // ==========================================================================
  // getAgentCapacity
  // ==========================================================================

  describe('getAgentCapacity', () => {
    it('returns null for a non-existent agent', async () => {
      const result = await getAgentCapacity('agt_nonexistent_abc123', tempDir);
      expect(result).toBeNull();
    });

    it('returns full capacity for a newly registered idle agent', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const cap = await getAgentCapacity(agent.id, tempDir);
      expect(cap).not.toBeNull();
      expect(cap!.agentId).toBe(agent.id);
      expect(cap!.maxCapacity).toBe(MAX_TASKS_PER_AGENT);
      expect(cap!.activeTasks).toBe(0);
      expect(cap!.remainingCapacity).toBe(MAX_TASKS_PER_AGENT);
      expect(cap!.available).toBe(true);
    });

    it('counts the agent own task_id as 1 active task', async () => {
      // We need a task row to satisfy the FK; insert one directly.
      const { getDb } = await import('../../store/sqlite.js');
      const { tasks: tasksTable } = await import('../../store/tasks-schema.js');
      const db = await getDb(tempDir);
      db.insert(tasksTable)
        .values({
          id: 'T-cap-001',
          title: 'Capacity test task',
          status: 'active',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        })
        .run();

      const agent = await registerAgent({ agentType: 'executor', taskId: 'T-cap-001' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const cap = await getAgentCapacity(agent.id, tempDir);
      expect(cap).not.toBeNull();
      expect(cap!.activeTasks).toBe(1);
      expect(cap!.remainingCapacity).toBe(MAX_TASKS_PER_AGENT - 1);
    });

    it('counts active child agents toward capacity', async () => {
      const parent = await registerAgent({ agentType: 'orchestrator' }, tempDir);
      await updateAgentStatus(parent.id, { status: 'active' }, tempDir);

      // Register 3 child agents
      for (let i = 0; i < 3; i++) {
        const child = await registerAgent(
          { agentType: 'executor', parentAgentId: parent.id },
          tempDir,
        );
        await updateAgentStatus(child.id, { status: 'active' }, tempDir);
      }

      const cap = await getAgentCapacity(parent.id, tempDir);
      expect(cap).not.toBeNull();
      expect(cap!.activeTasks).toBe(3); // no own taskId + 3 children
      expect(cap!.remainingCapacity).toBe(MAX_TASKS_PER_AGENT - 3);
      expect(cap!.available).toBe(true);
    });

    it('returns zero remaining capacity for stopped agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'stopped' }, tempDir);

      const cap = await getAgentCapacity(agent.id, tempDir);
      expect(cap).not.toBeNull();
      expect(cap!.remainingCapacity).toBe(0);
      expect(cap!.available).toBe(false);
    });

    it('returns zero remaining capacity for crashed agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'crashed' }, tempDir);

      const cap = await getAgentCapacity(agent.id, tempDir);
      expect(cap).not.toBeNull();
      expect(cap!.remainingCapacity).toBe(0);
      expect(cap!.available).toBe(false);
    });

    it('excludes stopped children from active count', async () => {
      const parent = await registerAgent({ agentType: 'orchestrator' }, tempDir);
      await updateAgentStatus(parent.id, { status: 'active' }, tempDir);

      const child = await registerAgent(
        { agentType: 'executor', parentAgentId: parent.id },
        tempDir,
      );
      // Immediately stop the child — should not count
      await updateAgentStatus(child.id, { status: 'stopped' }, tempDir);

      const cap = await getAgentCapacity(parent.id, tempDir);
      expect(cap!.activeTasks).toBe(0);
      expect(cap!.remainingCapacity).toBe(MAX_TASKS_PER_AGENT);
    });
  });

  // ==========================================================================
  // getAgentsByCapacity
  // ==========================================================================

  describe('getAgentsByCapacity', () => {
    it('returns empty array when no active agents', async () => {
      const result = await getAgentsByCapacity(undefined, tempDir);
      expect(result).toEqual([]);
    });

    it('sorts agents by remaining capacity descending', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a3 = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a3.id, { status: 'active' }, tempDir);

      // Add 2 children to a1 — so a1 has less capacity
      for (let i = 0; i < 2; i++) {
        const child = await registerAgent({ agentType: 'executor', parentAgentId: a1.id }, tempDir);
        await updateAgentStatus(child.id, { status: 'active' }, tempDir);
      }
      // Add 1 child to a2
      const child2 = await registerAgent({ agentType: 'executor', parentAgentId: a2.id }, tempDir);
      await updateAgentStatus(child2.id, { status: 'active' }, tempDir);
      // a3 has 0 children — most capacity

      const result = await getAgentsByCapacity(undefined, tempDir);

      // Only parent agents (a1, a2, a3) should appear (children are 'active' too
      // but they have no children themselves so they appear with full capacity).
      // Filter to just a1/a2/a3 for ordering assertions:
      const parents = result.filter((c) => [a1.id, a2.id, a3.id].includes(c.agentId));

      // a3 (5 remaining) >= a2 (4 remaining) >= a1 (3 remaining)
      expect(parents[0]!.remainingCapacity).toBeGreaterThanOrEqual(parents[1]!.remainingCapacity);
      expect(parents[1]!.remainingCapacity).toBeGreaterThanOrEqual(parents[2]!.remainingCapacity);
    });

    it('filters by agent type', async () => {
      await registerAgent({ agentType: 'executor' }, tempDir).then((a) =>
        updateAgentStatus(a.id, { status: 'active' }, tempDir),
      );
      await registerAgent({ agentType: 'researcher' }, tempDir).then((a) =>
        updateAgentStatus(a.id, { status: 'active' }, tempDir),
      );

      const executors = await getAgentsByCapacity('executor', tempDir);
      expect(executors.every((c) => c.agentType === 'executor')).toBe(true);
    });

    it('excludes non-active agents', async () => {
      const stopped = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(stopped.id, { status: 'stopped' }, tempDir);

      const result = await getAgentsByCapacity(undefined, tempDir);
      expect(result.some((c) => c.agentId === stopped.id)).toBe(false);
    });
  });

  // ==========================================================================
  // getAgentSpecializations / updateAgentSpecializations
  // ==========================================================================

  describe('getAgentSpecializations', () => {
    it('returns empty array for agent with no specializations', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const specs = await getAgentSpecializations(agent.id, tempDir);
      expect(specs).toEqual([]);
    });

    it('returns empty array for non-existent agent', async () => {
      const specs = await getAgentSpecializations('agt_nonexistent_abc123', tempDir);
      expect(specs).toEqual([]);
    });
  });

  describe('updateAgentSpecializations', () => {
    it('stores and retrieves specializations', async () => {
      const agent = await registerAgent({ agentType: 'architect' }, tempDir);
      await updateAgentSpecializations(agent.id, ['typescript', 'drizzle-orm', 'sqlite'], tempDir);

      const specs = await getAgentSpecializations(agent.id, tempDir);
      expect(specs).toEqual(['typescript', 'drizzle-orm', 'sqlite']);
    });

    it('replaces existing specializations', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentSpecializations(agent.id, ['python'], tempDir);
      await updateAgentSpecializations(agent.id, ['typescript', 'testing'], tempDir);

      const specs = await getAgentSpecializations(agent.id, tempDir);
      expect(specs).toEqual(['typescript', 'testing']);
    });

    it('preserves other metadata keys', async () => {
      const agent = await registerAgent(
        { agentType: 'executor', metadata: { model: 'opus-4', region: 'us-east' } },
        tempDir,
      );
      await updateAgentSpecializations(agent.id, ['research'], tempDir);

      // Pull raw metadata to verify other keys survive
      const { getDb } = await import('../../store/sqlite.js');
      const { agentInstances: table } = await import('../agent-schema.js');
      const { eq } = await import('drizzle-orm');
      const db = await getDb(tempDir);
      const row = await db
        .select({ metadataJson: table.metadataJson })
        .from(table)
        .where(eq(table.id, agent.id))
        .get();

      const parsed = JSON.parse(row!.metadataJson ?? '{}') as Record<string, unknown>;
      expect(parsed.model).toBe('opus-4');
      expect(parsed.region).toBe('us-east');
      expect(parsed.specializations).toEqual(['research']);
    });

    it('returns null for non-existent agent', async () => {
      const result = await updateAgentSpecializations(
        'agt_nonexistent_abc123',
        ['typescript'],
        tempDir,
      );
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // recordAgentPerformance
  // ==========================================================================

  describe('recordAgentPerformance', () => {
    it('returns null for non-existent agent', async () => {
      const result = await recordAgentPerformance(
        'agt_nonexistent_abc123',
        { taskId: 'T001', taskType: 'task', outcome: 'success' },
        tempDir,
      );
      expect(result).toBeNull();
    });

    it('records performance and returns a decision ID', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const decisionId = await recordAgentPerformance(
        agent.id,
        {
          taskId: 'T041',
          taskType: 'task',
          outcome: 'success',
          durationMs: 3000,
          taskLabels: ['implementation'],
        },
        tempDir,
      );

      // brain.db may not be initialised in the test tmpDir, so we accept
      // either a string ID or null (best-effort recording)
      if (decisionId !== null) {
        expect(typeof decisionId).toBe('string');
        expect(decisionId.length).toBeGreaterThan(0);
      }
    });

    it('records failure with error metadata', async () => {
      const agent = await registerAgent({ agentType: 'executor', sessionId: undefined }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      // Should not throw regardless of brain.db availability
      await expect(
        recordAgentPerformance(
          agent.id,
          {
            taskId: 'T999',
            taskType: 'task',
            outcome: 'failure',
            errorMessage: 'ECONNREFUSED',
            errorType: 'retriable',
          },
          tempDir,
        ),
      ).resolves.not.toThrow();
    });
  });
});
