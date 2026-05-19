/**
 * Unit tests for agents public API (T9615 — CORE-first promotion).
 *
 * Tests cover the happy path for each exported function:
 * listAgents, getAgent, removeAgent.
 * registerAgent is tested via registry.test.ts (existing coverage).
 * rotateAgentKey requires a live SignalDock endpoint and is not unit-tested here.
 *
 * @task T9615
 * @epic T9592
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgent, listAgents, removeAgent } from '../public-api.js';
import { registerAgent } from '../registry.js';

describe('Agents public API', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-agents-pub-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      closeAllDatabases();
    } catch {
      // Ignore cleanup errors
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listAgents
  // -------------------------------------------------------------------------

  describe('listAgents', () => {
    it('returns empty list when no agents are registered', async () => {
      const result = await listAgents({ projectPath: tempDir });
      expect(result.agents).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('returns registered agents', async () => {
      await registerAgent({ agentType: 'worker' }, tempDir);
      const result = await listAgents({ projectPath: tempDir });
      expect(result.agents.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      await registerAgent({ agentType: 'worker' }, tempDir);
      const result = await listAgents({ status: 'starting', projectPath: tempDir });
      expect(result.agents.every((a) => a.status === 'starting')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getAgent
  // -------------------------------------------------------------------------

  describe('getAgent', () => {
    it('returns null for unknown agent id', async () => {
      const result = await getAgent('nonexistent-id', tempDir);
      expect(result).toBeNull();
    });

    it('returns agent row for known id', async () => {
      const registered = await registerAgent({ agentType: 'orchestrator' }, tempDir);
      const result = await getAgent(registered.id, tempDir);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(registered.id);
      expect(result?.agentType).toBe('orchestrator');
    });
  });

  // -------------------------------------------------------------------------
  // removeAgent
  // -------------------------------------------------------------------------

  describe('removeAgent', () => {
    it('returns null when agent does not exist', async () => {
      const result = await removeAgent('does-not-exist', tempDir);
      expect(result).toBeNull();
    });

    it('stops an active agent', async () => {
      const registered = await registerAgent({ agentType: 'worker' }, tempDir);
      const result = await removeAgent(registered.id, tempDir);
      expect(result?.status).toBe('stopped');
    });

    it('is idempotent — stopping an already-stopped agent returns existing row', async () => {
      const registered = await registerAgent({ agentType: 'worker' }, tempDir);
      await removeAgent(registered.id, tempDir);
      const result = await removeAgent(registered.id, tempDir);
      expect(result?.status).toBe('stopped');
    });
  });
});
