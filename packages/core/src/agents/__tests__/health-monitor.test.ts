/**
 * Tests for agent health monitoring: recordHeartbeat, checkAgentHealth,
 * detectStaleAgents, detectCrashedAgents.
 *
 * @module agents/__tests__/health-monitor.test
 * @task T039
 * @epic T038
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkAgentHealth,
  detectCrashedAgents,
  detectStaleAgents,
  HEARTBEAT_INTERVAL_MS,
  recordHeartbeat,
  STALE_THRESHOLD_MS,
} from '../health-monitor.js';
import {
  deregisterAgent,
  getAgentInstance,
  markCrashed,
  registerAgent,
  updateAgentStatus,
} from '../registry.js';

describe('Agent Health Monitor (T039)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-health-test-'));
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
  // Constants
  // ==========================================================================

  describe('module constants', () => {
    it('exports HEARTBEAT_INTERVAL_MS as 30000', () => {
      expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it('exports STALE_THRESHOLD_MS as 180000 (3 minutes)', () => {
      expect(STALE_THRESHOLD_MS).toBe(180_000);
    });
  });

  // ==========================================================================
  // recordHeartbeat
  // ==========================================================================

  describe('recordHeartbeat', () => {
    it('updates last_heartbeat and returns current status', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const status = await recordHeartbeat(agent.id, tempDir);
      expect(status).toBe('active');

      const updated = await getAgentInstance(agent.id, tempDir);
      expect(updated!.lastHeartbeat).toBeTruthy();
    });

    it('returns null for non-existent agent', async () => {
      const result = await recordHeartbeat('agt_nonexistent_abc123', tempDir);
      expect(result).toBeNull();
    });

    it('does not update heartbeat for stopped agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await deregisterAgent(agent.id, tempDir);

      const beforeHeartbeat = (await getAgentInstance(agent.id, tempDir))!.lastHeartbeat;
      const status = await recordHeartbeat(agent.id, tempDir);

      expect(status).toBe('stopped');
      const afterHeartbeat = (await getAgentInstance(agent.id, tempDir))!.lastHeartbeat;
      // Heartbeat should NOT have been updated for terminal agent
      expect(afterHeartbeat).toBe(beforeHeartbeat);
    });

    it('does not update heartbeat for crashed agents', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await markCrashed(agent.id, 'test', tempDir);

      const status = await recordHeartbeat(agent.id, tempDir);
      expect(status).toBe('crashed');
    });

    it('works for idle agents', async () => {
      const agent = await registerAgent({ agentType: 'orchestrator' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'idle' }, tempDir);

      const status = await recordHeartbeat(agent.id, tempDir);
      expect(status).toBe('idle');
    });
  });

  // ==========================================================================
  // checkAgentHealth
  // ==========================================================================

  describe('checkAgentHealth', () => {
    it('returns null for a non-existent agent', async () => {
      const result = await checkAgentHealth('agt_nonexistent_abc123', STALE_THRESHOLD_MS, tempDir);
      expect(result).toBeNull();
    });

    it('returns a health status with correct fields', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const health = await checkAgentHealth(agent.id, STALE_THRESHOLD_MS, tempDir);
      expect(health).not.toBeNull();
      expect(health!.agentId).toBe(agent.id);
      expect(health!.status).toBe('active');
      expect(health!.lastHeartbeat).toBeTruthy();
      expect(typeof health!.heartbeatAgeMs).toBe('number');
      expect(health!.thresholdMs).toBe(STALE_THRESHOLD_MS);
    });

    it('reports healthy when heartbeat is recent', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await recordHeartbeat(agent.id, tempDir);

      const health = await checkAgentHealth(agent.id, 60_000, tempDir);
      expect(health!.healthy).toBe(true);
      expect(health!.stale).toBe(false);
    });

    it('reports stale when heartbeat exceeds threshold', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      // Use a 0ms threshold — any heartbeat is immediately stale
      await new Promise((r) => setTimeout(r, 10));
      const health = await checkAgentHealth(agent.id, 0, tempDir);
      expect(health!.stale).toBe(true);
      expect(health!.healthy).toBe(false);
    });

    it('stopped agents are not healthy or stale', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await deregisterAgent(agent.id, tempDir);

      const health = await checkAgentHealth(agent.id, 0, tempDir);
      expect(health!.healthy).toBe(false);
      expect(health!.stale).toBe(false);
    });

    it('defaults threshold to STALE_THRESHOLD_MS when not provided', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      const health = await checkAgentHealth(agent.id, undefined, tempDir);
      expect(health!.thresholdMs).toBe(STALE_THRESHOLD_MS);
    });
  });

  // ==========================================================================
  // detectStaleAgents
  // ==========================================================================

  describe('detectStaleAgents', () => {
    it('returns empty array when all agents are healthy', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await recordHeartbeat(agent.id, tempDir);

      const stale = await detectStaleAgents(60_000, tempDir);
      expect(stale.some((s) => s.agentId === agent.id)).toBe(false);
    });

    it('detects active agents with old heartbeats', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      // 0ms threshold — all are immediately stale
      await new Promise((r) => setTimeout(r, 10));
      const stale = await detectStaleAgents(0, tempDir);
      expect(stale.some((s) => s.agentId === agent.id)).toBe(true);
    });

    it('detects idle agents with old heartbeats', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'idle' }, tempDir);

      await new Promise((r) => setTimeout(r, 10));
      const stale = await detectStaleAgents(0, tempDir);
      expect(stale.some((s) => s.agentId === agent.id)).toBe(true);
    });

    it('does not include stopped or crashed agents', async () => {
      const stopped = await registerAgent({ agentType: 'executor' }, tempDir);
      const crashed = await registerAgent({ agentType: 'researcher' }, tempDir);
      await deregisterAgent(stopped.id, tempDir);
      await markCrashed(crashed.id, 'test', tempDir);

      const stale = await detectStaleAgents(0, tempDir);
      expect(stale.some((s) => s.agentId === stopped.id)).toBe(false);
      expect(stale.some((s) => s.agentId === crashed.id)).toBe(false);
    });

    it('returns results sorted by heartbeat age descending (most stale first)', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await new Promise((r) => setTimeout(r, 20));
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);

      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'active' }, tempDir);

      const stale = await detectStaleAgents(0, tempDir);
      if (stale.length >= 2) {
        // Most stale (older heartbeat) should be first
        expect(stale[0]!.heartbeatAgeMs).toBeGreaterThanOrEqual(stale[1]!.heartbeatAgeMs);
      }
    });

    it('uses STALE_THRESHOLD_MS as default', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await recordHeartbeat(agent.id, tempDir);

      // With default 3min threshold, freshly heartbeated agent should NOT be stale
      const stale = await detectStaleAgents(undefined, tempDir);
      expect(stale.some((s) => s.agentId === agent.id)).toBe(false);
    });
  });

  // ==========================================================================
  // detectCrashedAgents
  // ==========================================================================

  describe('detectCrashedAgents', () => {
    it('returns empty array when no agents have stale heartbeats', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await recordHeartbeat(agent.id, tempDir);

      const crashed = await detectCrashedAgents(60_000, tempDir);
      expect(crashed.some((a) => a.id === agent.id)).toBe(false);
    });

    it('marks active agents with stale heartbeats as crashed', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      await new Promise((r) => setTimeout(r, 10));
      const crashed = await detectCrashedAgents(0, tempDir);
      expect(crashed.some((a) => a.id === agent.id)).toBe(true);

      // Verify DB is updated
      const dbRecord = await getAgentInstance(agent.id, tempDir);
      expect(dbRecord!.status).toBe('crashed');
      expect(dbRecord!.errorCount).toBe(1);
    });

    it('only targets active agents, not idle or starting', async () => {
      const idle = await registerAgent({ agentType: 'executor' }, tempDir);
      const starting = await registerAgent({ agentType: 'researcher' }, tempDir);
      await updateAgentStatus(idle.id, { status: 'idle' }, tempDir);
      // starting status is already the default

      await new Promise((r) => setTimeout(r, 10));
      const crashed = await detectCrashedAgents(0, tempDir);
      expect(crashed.some((a) => a.id === idle.id)).toBe(false);
      expect(crashed.some((a) => a.id === starting.id)).toBe(false);
    });

    it('returns results sorted by heartbeat age ascending (oldest first)', async () => {
      const a1 = await registerAgent({ agentType: 'executor' }, tempDir);
      await new Promise((r) => setTimeout(r, 20));
      const a2 = await registerAgent({ agentType: 'researcher' }, tempDir);

      await updateAgentStatus(a1.id, { status: 'active' }, tempDir);
      await updateAgentStatus(a2.id, { status: 'active' }, tempDir);

      const crashed = await detectCrashedAgents(0, tempDir);
      if (crashed.length >= 2) {
        // Oldest heartbeat first (ascending by lastHeartbeat string)
        const idx1 = crashed.findIndex((a) => a.id === a1.id);
        const idx2 = crashed.findIndex((a) => a.id === a2.id);
        if (idx1 !== -1 && idx2 !== -1) {
          expect(idx1).toBeLessThan(idx2);
        }
      }
    });

    it('is idempotent — already-crashed agents are not re-processed', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);

      await new Promise((r) => setTimeout(r, 10));
      const first = await detectCrashedAgents(0, tempDir);
      expect(first.some((a) => a.id === agent.id)).toBe(true);

      // Second call should NOT include the already-crashed agent
      const second = await detectCrashedAgents(0, tempDir);
      expect(second.some((a) => a.id === agent.id)).toBe(false);
    });

    it('defaults threshold to STALE_THRESHOLD_MS', async () => {
      const agent = await registerAgent({ agentType: 'executor' }, tempDir);
      await updateAgentStatus(agent.id, { status: 'active' }, tempDir);
      await recordHeartbeat(agent.id, tempDir);

      // With default 3min threshold, freshly heartbeated agent should NOT be detected
      const crashed = await detectCrashedAgents(undefined, tempDir);
      expect(crashed.some((a) => a.id === agent.id)).toBe(false);
    });
  });
});
