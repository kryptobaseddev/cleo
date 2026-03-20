/**
 * Tests for capacity tracking and load balancing.
 *
 * @module agents/__tests__/capacity.test
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findLeastLoadedAgent,
  getAvailableCapacity,
  getCapacitySummary,
  isOverloaded,
  updateCapacity,
} from '../capacity.js';
import { registerAgent, updateAgentStatus } from '../registry.js';

describe('Capacity Tracking', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-capacity-test-'));
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
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(
        () => {},
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // ==========================================================================
  // updateCapacity
  // ==========================================================================

  describe('updateCapacity', () => {
    it('updates capacity value', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const updated = await updateCapacity(agent.id, 0.5, tempDir);

      expect(updated).not.toBeNull();
      expect(parseFloat(updated!.capacity)).toBeCloseTo(0.5, 4);
    });

    it('returns null for non-existent agent', async () => {
      const result = await updateCapacity('agt_nonexistent_abc123', 0.5, tempDir);
      expect(result).toBeNull();
    });

    it('rejects capacity below 0', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await expect(updateCapacity(agent.id, -0.1, tempDir)).rejects.toThrow(
        'Capacity must be between 0.0 and 1.0',
      );
    });

    it('rejects capacity above 1', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await expect(updateCapacity(agent.id, 1.5, tempDir)).rejects.toThrow(
        'Capacity must be between 0.0 and 1.0',
      );
    });

    it('accepts boundary values', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);

      const zero = await updateCapacity(agent.id, 0, tempDir);
      expect(parseFloat(zero!.capacity)).toBeCloseTo(0, 4);

      const one = await updateCapacity(agent.id, 1, tempDir);
      expect(parseFloat(one!.capacity)).toBeCloseTo(1, 4);
    });
  });

  // ==========================================================================
  // getAvailableCapacity
  // ==========================================================================

  describe('getAvailableCapacity', () => {
    it('sums capacity of active and idle agents', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'idle' }, tempDir);
      await updateCapacity(a1.id, 0.7, tempDir);
      await updateCapacity(a2.id, 0.3, tempDir);

      const capacity = await getAvailableCapacity(tempDir);
      expect(capacity).toBeCloseTo(1.0, 1);
    });

    it('excludes stopped and crashed agents', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      const a3 = await registerAgent({ agentType: 'validator' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'stopped' }, tempDir);
      await updateAgentStatus(a3.id, { status: 'crashed' }, tempDir);

      const capacity = await getAvailableCapacity(tempDir);
      // Only a1 contributes (1.0 default)
      expect(capacity).toBeCloseTo(1.0, 1);
    });

    it('returns 0 when no active agents', async () => {
      const capacity = await getAvailableCapacity(tempDir);
      expect(capacity).toBe(0);
    });
  });

  // ==========================================================================
  // findLeastLoadedAgent
  // ==========================================================================

  describe('findLeastLoadedAgent', () => {
    it('finds agent with highest capacity', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a3 = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a3.id, { status: 'active' }, tempDir);
      await updateCapacity(a1.id, 0.2, tempDir);
      await updateCapacity(a2.id, 0.8, tempDir);
      await updateCapacity(a3.id, 0.5, tempDir);

      const least = await findLeastLoadedAgent(undefined, tempDir);
      expect(least).not.toBeNull();
      expect(least!.id).toBe(a2.id);
    });

    it('filters by agent type', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'active' }, tempDir);
      await updateCapacity(a1.id, 0.3, tempDir);
      await updateCapacity(a2.id, 0.9, tempDir);

      const least = await findLeastLoadedAgent('executor', tempDir);
      expect(least).not.toBeNull();
      expect(least!.id).toBe(a1.id);
      expect(least!.agentType).toBe('executor');
    });

    it('returns null when no matching agents', async () => {
      const result = await findLeastLoadedAgent('orchestrator', tempDir);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // isOverloaded
  // ==========================================================================

  describe('isOverloaded', () => {
    it('returns true when capacity below threshold', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateCapacity(a1.id, 0.05, tempDir);

      expect(await isOverloaded(0.1, tempDir)).toBe(true);
    });

    it('returns false when capacity above threshold', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateCapacity(a1.id, 0.5, tempDir);

      expect(await isOverloaded(0.1, tempDir)).toBe(false);
    });

    it('returns true when no active agents (0 capacity)', async () => {
      expect(await isOverloaded(0.1, tempDir)).toBe(true);
    });
  });

  // ==========================================================================
  // getCapacitySummary
  // ==========================================================================

  describe('getCapacitySummary', () => {
    it('produces correct summary', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'idle' }, tempDir);
      await updateCapacity(a1.id, 0.6, tempDir);
      await updateCapacity(a2.id, 0.4, tempDir);

      const summary = await getCapacitySummary(0.1, tempDir);

      expect(summary.totalCapacity).toBeCloseTo(1.0, 1);
      expect(summary.activeAgentCount).toBe(2);
      expect(summary.averageCapacity).toBeCloseTo(0.5, 1);
      expect(summary.overloaded).toBe(false);
      expect(summary.threshold).toBe(0.1);
    });

    it('reports overloaded when below threshold', async () => {
      const summary = await getCapacitySummary(0.5, tempDir);

      expect(summary.totalCapacity).toBe(0);
      expect(summary.activeAgentCount).toBe(0);
      expect(summary.overloaded).toBe(true);
    });
  });
});
