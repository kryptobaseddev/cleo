/**
 * Tests for the Agent dimension: registry CRUD, heartbeat protocol,
 * crash detection, error classification, and health reporting.
 *
 * @module agents/__tests__/registry.test
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkAgentHealth,
  classifyError,
  deregisterAgent,
  generateAgentId,
  getAgentErrorHistory,
  getAgentInstance,
  getHealthReport,
  heartbeat,
  incrementTasksCompleted,
  listAgentInstances,
  markCrashed,
  registerAgent,
  updateAgentStatus,
} from '../registry.js';

describe('Agent Registry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-test-'));
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
  // ID generation
  // ==========================================================================

  describe('generateAgentId', () => {
    it('generates IDs with agt_ prefix', () => {
      const id = generateAgentId();
      expect(id).toMatch(/^agt_\d{14}_[0-9a-f]{6}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateAgentId()));
      expect(ids.size).toBe(50);
    });
  });

  // ==========================================================================
  // Registration CRUD
  // ==========================================================================

  describe('registerAgent', () => {
    it('creates a new agent instance with default values', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);

      expect(agent.id).toMatch(/^agt_/);
      expect(agent.agentType).toBe('executor');
      expect(agent.status).toBe('starting');
      expect(agent.errorCount).toBe(0);
      expect(agent.totalTasksCompleted).toBe(0);
      expect(agent.capacity).toBe('1.0');
      expect(agent.sessionId).toBeNull();
      expect(agent.taskId).toBeNull();
      expect(agent.parentAgentId).toBeNull();
    });

    it('accepts optional session, task, and parent', async () => {
      const agent = await registerAgent(
        {
          agentType: 'researcher',
          sessionId: 'ses_test_123',
          taskId: 'T001',
          parentAgentId: 'agt_parent_abc123',
        },
        tempDir,
      );

      expect(agent.sessionId).toBe('ses_test_123');
      expect(agent.taskId).toBe('T001');
      expect(agent.parentAgentId).toBe('agt_parent_abc123');
    });

    it('stores metadata as JSON', async () => {
      const agent = await registerAgent(
        {
          agentType: 'orchestrator',
          metadata: { model: 'opus-4', region: 'us-east' },
        },
        tempDir,
      );

      const parsed = JSON.parse(agent.metadataJson ?? '{}');
      expect(parsed.model).toBe('opus-4');
      expect(parsed.region).toBe('us-east');
    });
  });

  describe('getAgentInstance', () => {
    it('returns null for non-existent agent', async () => {
      const result = await getAgentInstance('agt_nonexistent_abc123', tempDir);
      expect(result).toBeNull();
    });

    it('retrieves a registered agent by ID', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const retrieved = await getAgentInstance(agent.id, tempDir);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(agent.id);
      expect(retrieved!.agentType).toBe('executor');
    });
  });

  describe('deregisterAgent', () => {
    it('marks agent as stopped', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const stopped = await deregisterAgent(agent.id, tempDir);

      expect(stopped).not.toBeNull();
      expect(stopped!.status).toBe('stopped');
      expect(stopped!.stoppedAt).toBeTruthy();
    });

    it('returns null for non-existent agent', async () => {
      const result = await deregisterAgent('agt_nonexistent_abc123', tempDir);
      expect(result).toBeNull();
    });

    it('is idempotent for already-stopped agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await deregisterAgent(agent.id, tempDir);
      const second = await deregisterAgent(agent.id, tempDir);

      expect(second).not.toBeNull();
      expect(second!.status).toBe('stopped');
    });
  });

  describe('listAgentInstances', () => {
    it('returns all agents when no filters', async () => {
      await registerAgent({ agentType: 'executor' }, tempDir);
      await registerAgent({ agentType: 'researcher' }, tempDir);

      const all = await listAgentInstances(undefined, tempDir);
      expect(all.length).toBe(2);
    });

    it('filters by status', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await registerAgent({ agentType: 'researcher' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);

      const active = await listAgentInstances({ status: 'active' }, tempDir);
      expect(active.length).toBe(1);
      expect(active[0]!.id).toBe(a1.id);
    });

    it('filters by type', async () => {
      await registerAgent({ agentType: 'executor' }, tempDir);
      await registerAgent({ agentType: 'researcher' }, tempDir);
      await registerAgent({ agentType: 'executor' }, tempDir);

      const executors = await listAgentInstances({ agentType: 'executor' }, tempDir);
      expect(executors.length).toBe(2);
    });

    it('filters by multiple statuses', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      await registerAgent({ agentType: 'validator' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'idle' }, tempDir);

      const activeOrIdle = await listAgentInstances({ status: ['active', 'idle'] }, tempDir);
      expect(activeOrIdle.length).toBe(2);
    });
  });

  // ==========================================================================
  // Heartbeat
  // ==========================================================================

  describe('heartbeat', () => {
    it('updates last_heartbeat and returns current status', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const status = await heartbeat(agent.id, tempDir);
      expect(status).toBe('active');

      const updated = await getAgentInstance(agent.id, tempDir);
      expect(updated!.lastHeartbeat).toBeTruthy();
    });

    it('returns null for non-existent agent', async () => {
      const status = await heartbeat('agt_nonexistent_abc123', tempDir);
      expect(status).toBeNull();
    });

    it('does not update heartbeat for stopped agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await deregisterAgent(agent.id, tempDir);

      const status = await heartbeat(agent.id, tempDir);
      expect(status).toBe('stopped');
    });

    it('does not update heartbeat for crashed agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await markCrashed(agent.id, 'test crash', tempDir);

      const status = await heartbeat(agent.id, tempDir);
      expect(status).toBe('crashed');
    });
  });

  // ==========================================================================
  // Status management
  // ==========================================================================

  describe('updateAgentStatus', () => {
    it('updates status', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const updated = await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('active');
    });

    it('increments error count on error status', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'error', error: 'Connection timeout' }, tempDir);

      const updated = await getAgentInstance(agent.id, tempDir);
      expect(updated!.errorCount).toBe(1);
      expect(updated!.status).toBe('error');
    });

    it('logs error to agent_error_log', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(
        agent.id,
        { status: 'error', error: 'SQLITE_BUSY: database is locked' },
        tempDir,
      );

      const errors = await getAgentErrorHistory(agent.id, tempDir);
      expect(errors.length).toBe(1);
      expect(errors[0]!.errorType).toBe('retriable');
      expect(errors[0]!.message).toBe('SQLITE_BUSY: database is locked');
    });

    it('sets stoppedAt when status is stopped', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const updated = await updateAgentStatus(agent.id, { status: 'stopped' }, tempDir);

      expect(updated!.stoppedAt).toBeTruthy();
    });

    it('returns null for non-existent agent', async () => {
      const result = await updateAgentStatus(
        'agt_nonexistent_abc123',
        { status: 'active' },
        tempDir,
      );
      expect(result).toBeNull();
    });
  });

  describe('incrementTasksCompleted', () => {
    it('increments the task counter', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await incrementTasksCompleted(agent.id, tempDir);
      await incrementTasksCompleted(agent.id, tempDir);

      const updated = await getAgentInstance(agent.id, tempDir);
      expect(updated!.totalTasksCompleted).toBe(2);
    });
  });

  // ==========================================================================
  // Error classification
  // ==========================================================================

  describe('classifyError', () => {
    it('classifies timeout errors as retriable', () => {
      expect(classifyError(new Error('Connection timeout'))).toBe('retriable');
    });

    it('classifies network errors as retriable', () => {
      expect(classifyError(new Error('ECONNREFUSED'))).toBe('retriable');
      expect(classifyError(new Error('ECONNRESET'))).toBe('retriable');
      expect(classifyError(new Error('ETIMEDOUT'))).toBe('retriable');
      expect(classifyError(new Error('socket hang up'))).toBe('retriable');
    });

    it('classifies rate limit errors as retriable', () => {
      expect(classifyError(new Error('Rate limit exceeded'))).toBe('retriable');
      expect(classifyError(new Error('429 Too Many Requests'))).toBe('retriable');
      expect(classifyError(new Error('503 Service Unavailable'))).toBe('retriable');
    });

    it('classifies SQLite busy as retriable', () => {
      expect(classifyError(new Error('SQLITE_BUSY: database is locked'))).toBe('retriable');
    });

    it('classifies permission errors as permanent', () => {
      expect(classifyError(new Error('Permission denied'))).toBe('permanent');
      expect(classifyError(new Error('EACCES'))).toBe('permanent');
    });

    it('classifies auth errors as permanent', () => {
      expect(classifyError(new Error('401 Unauthorized'))).toBe('permanent');
      expect(classifyError(new Error('403 Forbidden'))).toBe('permanent');
      expect(classifyError(new Error('invalid token'))).toBe('permanent');
    });

    it('classifies constraint errors as permanent', () => {
      expect(classifyError(new Error('SQLITE_CONSTRAINT: UNIQUE violation'))).toBe('permanent');
    });

    it('classifies unknown errors as unknown', () => {
      expect(classifyError(new Error('Something weird happened'))).toBe('unknown');
    });

    it('handles non-Error values', () => {
      expect(classifyError('string error')).toBe('unknown');
      expect(classifyError(42)).toBe('unknown');
    });
  });

  // ==========================================================================
  // Health monitoring
  // ==========================================================================

  describe('checkAgentHealth', () => {
    it('detects agents with stale heartbeats', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      // Wait briefly so heartbeat is definitively in the past, then use
      // a threshold that guarantees staleness detection on slow CI runners
      await new Promise((r) => setTimeout(r, 50));
      const stale = await checkAgentHealth(10, tempDir);
      expect(stale.length).toBeGreaterThanOrEqual(1);
      expect(stale.some((a) => a.id === agent.id)).toBe(true);
    });

    it('does not flag stopped agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await deregisterAgent(agent.id, tempDir);

      const stale = await checkAgentHealth(0, tempDir);
      expect(stale.some((a) => a.id === agent.id)).toBe(false);
    });

    it('returns empty array when all agents are healthy', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await heartbeat(agent.id, tempDir);

      // Use a large threshold -- agent should be considered healthy
      const stale = await checkAgentHealth(60_000, tempDir);
      expect(stale.some((a) => a.id === agent.id)).toBe(false);
    });
  });

  describe('markCrashed', () => {
    it('marks agent as crashed with error details', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const crashed = await markCrashed(agent.id, 'Out of memory', tempDir);

      expect(crashed).not.toBeNull();
      expect(crashed!.status).toBe('crashed');
      expect(crashed!.errorCount).toBe(1);
    });

    it('provides default reason when none specified', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await markCrashed(agent.id, undefined, tempDir);

      const errors = await getAgentErrorHistory(agent.id, tempDir);
      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toContain('Heartbeat timeout');
    });
  });

  describe('getHealthReport', () => {
    it('produces summary of all agent states', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);
      const a3 = await registerAgent({ agentType: 'orchestrator' }, tempDir);

      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'idle' }, tempDir);
      await deregisterAgent(a3.id, tempDir);

      const report = await getHealthReport(60_000, tempDir);

      expect(report.total).toBe(3);
      expect(report.active).toBe(1);
      expect(report.idle).toBe(1);
      expect(report.stopped).toBe(1);
    });

    it('counts total errors across all agents', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'error', error: 'err1' }, tempDir);
      await updateAgentStatus(a1.id, { status: 'error', error: 'err2' }, tempDir);

      const report = await getHealthReport(60_000, tempDir);
      expect(report.totalErrors).toBe(2);
    });
  });

  // ==========================================================================
  // Error history
  // ==========================================================================

  describe('getAgentErrorHistory', () => {
    it('returns empty array for agent with no errors', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      const errors = await getAgentErrorHistory(agent.id, tempDir);
      expect(errors).toEqual([]);
    });

    it('returns all errors for an agent', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'error', error: 'timeout' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'error', error: 'ECONNREFUSED' }, tempDir);

      const errors = await getAgentErrorHistory(agent.id, tempDir);
      expect(errors.length).toBe(2);
      expect(errors[0]!.errorType).toBe('retriable');
      expect(errors[1]!.errorType).toBe('retriable');
    });
  });
});
