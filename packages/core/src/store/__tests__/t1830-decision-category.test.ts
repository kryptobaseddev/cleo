/**
 * T1830: decision_category column — schema presence + decision-find filter tests.
 *
 * Verifies:
 * 1. `decision_category` column exists on `brain_decisions` with correct default.
 * 2. `recordAgentExecution` tags AGT-* rows as `agent_dispatch`.
 * 3. `findDecisions` excludes `agent_dispatch` rows by default (filter test).
 * 4. `findDecisions` includes `agent_dispatch` rows when `includeAgentDispatch: true`.
 * 5. The `idx_brain_decisions_decision_category` index is present.
 *
 * Uses real SQLite via brain.db in a temp directory per test.
 *
 * @task T1830
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentExecutionEvent } from '../../agents/execution-learning.js';
import { _recordAgentExecutionWithAccessor } from '../../agents/execution-learning.js';
import { getBrainAccessor } from '../memory-accessor.js';
import { resetBrainDbState } from '../memory-sqlite.js';

// ============================================================================
// Test setup
// ============================================================================

describe('T1830 decision_category schema + filter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t1830-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    resetBrainDbState();
    try {
      const { closeAllDatabases } = await import('../sqlite.js');
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
  // Schema: column presence
  // ==========================================================================

  describe('schema: decision_category column', () => {
    it('decision_category column exists with NOT NULL DEFAULT architectural', async () => {
      const { getBrainNativeDb, getBrainDb } = await import('../memory-sqlite.js');
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      expect(nativeDb).toBeTruthy();

      // Query PRAGMA table_info to inspect column metadata
      const columns = nativeDb!.prepare('PRAGMA table_info(brain_decisions)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      const col = columns.find((c) => c.name === 'decision_category');
      expect(col).toBeDefined();
      expect(col!.type.toUpperCase()).toBe('TEXT');
      expect(col!.notnull).toBe(1); // NOT NULL
      expect(col!.dflt_value).toBe("'architectural'");
    });

    it('idx_brain_decisions_decision_category index exists', async () => {
      const { getBrainNativeDb, getBrainDb } = await import('../memory-sqlite.js');
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      expect(nativeDb).toBeTruthy();

      const indexes = nativeDb!
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_brain_decisions_decision_category');
    });

    it('new non-AGT decisions default to architectural category', async () => {
      const brain = await getBrainAccessor(tempDir);

      await brain.addDecision({
        id: 'D-arch-test-001',
        type: 'architecture',
        decision: 'Use SQLite for brain storage',
        rationale: 'Embedded, zero-network, simple',
        confidence: 'high',
      });

      const row = await brain.getDecision('D-arch-test-001');
      expect(row).not.toBeNull();
      expect(row!.decisionCategory).toBe('architectural');
    });
  });

  // ==========================================================================
  // recordAgentExecution: tags rows as agent_dispatch
  // ==========================================================================

  describe('recordAgentExecution: decisionCategory = agent_dispatch', () => {
    it('tags AGT-prefixed rows as agent_dispatch', async () => {
      const brain = await getBrainAccessor(tempDir);

      const event: AgentExecutionEvent = {
        agentId: 'agt_t1830_abc',
        agentType: 'executor',
        taskId: 'T999',
        taskType: 'task',
        outcome: 'success',
      };

      const row = await _recordAgentExecutionWithAccessor(event, brain);

      expect(row).not.toBeNull();
      expect(row!.id).toMatch(/^AGT-/);
      expect(row!.decisionCategory).toBe('agent_dispatch');
    });

    it('records multiple execution events all as agent_dispatch', async () => {
      const brain = await getBrainAccessor(tempDir);

      const events: AgentExecutionEvent[] = [
        {
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T001',
          taskType: 'task',
          outcome: 'success',
        },
        {
          agentId: 'agt_2',
          agentType: 'researcher',
          taskId: 'T002',
          taskType: 'epic',
          outcome: 'failure',
          errorType: 'retriable',
        },
        {
          agentId: 'agt_3',
          agentType: 'validator',
          taskId: 'T003',
          taskType: 'subtask',
          outcome: 'partial',
        },
      ];

      for (const e of events) {
        const row = await _recordAgentExecutionWithAccessor(e, brain);
        expect(row!.decisionCategory).toBe('agent_dispatch');
      }
    });
  });

  // ==========================================================================
  // findDecisions: default filter excludes agent_dispatch
  // ==========================================================================

  describe('findDecisions: default filter excludes agent_dispatch', () => {
    it('excludes agent_dispatch rows by default (no includeAgentDispatch flag)', async () => {
      const brain = await getBrainAccessor(tempDir);

      // Write an architectural decision
      await brain.addDecision({
        id: 'D-arch-001',
        type: 'architecture',
        decision: 'Use SQLite for persistence',
        rationale: 'Embedded DB is simpler',
        confidence: 'high',
      });

      // Write an AGT dispatch row (via recordAgentExecution)
      const event: AgentExecutionEvent = {
        agentId: 'agt_t1830_xyz',
        agentType: 'executor',
        taskId: 'T100',
        taskType: 'task',
        outcome: 'success',
      };
      const agtRow = await _recordAgentExecutionWithAccessor(event, brain);
      expect(agtRow!.decisionCategory).toBe('agent_dispatch');

      // Default findDecisions — should only see architectural
      const results = await brain.findDecisions({ limit: 50 });
      const ids = results.map((r) => r.id);

      expect(ids).toContain('D-arch-001');
      expect(ids).not.toContain(agtRow!.id);
    });

    it('excludes agent_dispatch even when filtering by type:tactical', async () => {
      const brain = await getBrainAccessor(tempDir);

      // Write a tactical architectural decision (not from execution-learning)
      await brain.addDecision({
        id: 'D-tact-001',
        type: 'tactical',
        decision: 'Use polling interval of 5s',
        rationale: 'Balance freshness vs load',
        confidence: 'medium',
        decisionCategory: 'architectural',
      });

      // Write a tactical AGT dispatch row
      const event: AgentExecutionEvent = {
        agentId: 'agt_t1830_tactical',
        agentType: 'executor',
        taskId: 'T200',
        taskType: 'task',
        outcome: 'success',
      };
      const agtRow = await _recordAgentExecutionWithAccessor(event, brain);

      // Filter by type:tactical — should exclude the dispatch row
      const results = await brain.findDecisions({ type: 'tactical', limit: 50 });
      const ids = results.map((r) => r.id);

      expect(ids).toContain('D-tact-001');
      expect(ids).not.toContain(agtRow!.id);
    });
  });

  // ==========================================================================
  // findDecisions: includeAgentDispatch opt-in
  // ==========================================================================

  describe('findDecisions: includeAgentDispatch opt-in', () => {
    it('returns agent_dispatch rows when includeAgentDispatch is true', async () => {
      const brain = await getBrainAccessor(tempDir);

      const event: AgentExecutionEvent = {
        agentId: 'agt_t1830_opt',
        agentType: 'researcher',
        taskId: 'T300',
        taskType: 'epic',
        outcome: 'failure',
        errorType: 'permanent',
      };
      const agtRow = await _recordAgentExecutionWithAccessor(event, brain);

      // With opt-in, the dispatch row should be present
      const results = await brain.findDecisions({ includeAgentDispatch: true, limit: 50 });
      const ids = results.map((r) => r.id);
      expect(ids).toContain(agtRow!.id);
    });

    it('returns both architectural and agent_dispatch rows with opt-in', async () => {
      const brain = await getBrainAccessor(tempDir);

      await brain.addDecision({
        id: 'D-arch-opt-001',
        type: 'architecture',
        decision: 'Adopt monorepo layout',
        rationale: 'Code sharing simplified',
        confidence: 'high',
      });

      const event: AgentExecutionEvent = {
        agentId: 'agt_t1830_both',
        agentType: 'executor',
        taskId: 'T400',
        taskType: 'task',
        outcome: 'success',
      };
      const agtRow = await _recordAgentExecutionWithAccessor(event, brain);

      const results = await brain.findDecisions({ includeAgentDispatch: true, limit: 50 });
      const ids = results.map((r) => r.id);

      expect(ids).toContain('D-arch-opt-001');
      expect(ids).toContain(agtRow!.id);
    });
  });
});
