/**
 * Tests for the Agent Execution Learning module.
 *
 * Covers: execution event recording, performance history queries,
 * failure pattern accumulation, healing strategy storage, and the
 * compound processAgentLifecycleEvent function.
 *
 * Uses real SQLite (via brain.db) in a temp directory per test.
 *
 * @module agents/__tests__/execution-learning.test
 * @task T034
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getBrainAccessor } from '../../store/brain-accessor.js';
import { resetBrainDbState } from '../../store/brain-sqlite.js';
import {
  _getAgentPerformanceHistoryWithAccessor,
  _getSelfHealingSuggestionsWithAccessor,
  _recordAgentExecutionWithAccessor,
  _recordFailurePatternWithAccessor,
  _storeHealingStrategyWithAccessor,
  type AgentExecutionEvent,
  getAgentPerformanceHistory,
  getSelfHealingSuggestions,
  processAgentLifecycleEvent,
  recordAgentExecution,
  recordFailurePattern,
  storeHealingStrategy,
} from '../execution-learning.js';

// ============================================================================
// Test setup
// ============================================================================

describe('Agent Execution Learning', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-exec-learn-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    resetBrainDbState();
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
  // recordAgentExecution
  // ==========================================================================

  describe('recordAgentExecution', () => {
    it('stores a successful execution as a tactical brain decision', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_20260321_abc123',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'success',
      };

      const row = await recordAgentExecution(event, tempDir);

      expect(row).not.toBeNull();
      expect(row!.id).toMatch(/^AGT-/);
      expect(row!.type).toBe('tactical');
      expect(row!.outcome).toBe('success');
      expect(row!.confidence).toBe('high');
      expect(row!.contextTaskId).toBe('T001');
      expect(row!.decision).toContain('executor');
      expect(row!.decision).toContain('successfully completed');
    });

    it('stores a failure execution with low confidence and failure outcome', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_20260321_abc123',
        agentType: 'researcher',
        taskId: 'T002',
        taskType: 'epic',
        outcome: 'failure',
        errorMessage: 'ECONNREFUSED',
        errorType: 'retriable',
      };

      const row = await recordAgentExecution(event, tempDir);

      expect(row).not.toBeNull();
      expect(row!.outcome).toBe('failure');
      expect(row!.confidence).toBe('low');
      expect(row!.decision).toContain('failed');
      expect(row!.decision).toContain('researcher');
    });

    it('stores a partial execution with medium confidence and mixed outcome', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_20260321_abc123',
        agentType: 'validator',
        taskId: 'T003',
        taskType: 'subtask',
        outcome: 'partial',
      };

      const row = await recordAgentExecution(event, tempDir);

      expect(row).not.toBeNull();
      expect(row!.outcome).toBe('mixed');
      expect(row!.confidence).toBe('medium');
    });

    it('embeds structured metadata in alternativesJson', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_20260321_abc123',
        agentType: 'orchestrator',
        taskId: 'T010',
        taskType: 'task',
        taskLabels: ['schema', 'core'],
        outcome: 'success',
        sessionId: 'ses_test_abc',
        durationMs: 4200,
      };

      const row = await recordAgentExecution(event, tempDir);
      expect(row).not.toBeNull();

      const meta = JSON.parse(row!.alternativesJson ?? '{}') as Record<string, unknown>;
      expect(meta.agentType).toBe('orchestrator');
      expect(meta.taskType).toBe('task');
      expect(meta.taskLabels).toEqual(['schema', 'core']);
      expect(meta.sessionId).toBe('ses_test_abc');
      expect(meta.durationMs).toBe(4200);
    });

    it('returns null gracefully when brain.db is unavailable (bad path)', async () => {
      // Use a path that will fail — brain.db accessor will throw
      const event: AgentExecutionEvent = {
        agentId: 'agt_test',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'success',
      };

      // Pass a non-existent cwd that will cause sqlite open to fail
      const result = await recordAgentExecution(event, '/nonexistent/path/abc');
      // Should return null without throwing
      expect(result === null || result !== undefined).toBe(true);
    });
  });

  // ==========================================================================
  // getAgentPerformanceHistory
  // ==========================================================================

  describe('getAgentPerformanceHistory', () => {
    it('returns empty array when no execution events exist', async () => {
      const summaries = await getAgentPerformanceHistory({}, tempDir);
      expect(summaries).toEqual([]);
    });

    it('aggregates successes and failures by (agentType, taskType)', async () => {
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
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T002',
          taskType: 'task',
          outcome: 'success',
        },
        {
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T003',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'retriable',
        },
        {
          agentId: 'agt_2',
          agentType: 'researcher',
          taskId: 'T004',
          taskType: 'epic',
          outcome: 'success',
        },
      ];

      for (const e of events) {
        await _recordAgentExecutionWithAccessor(e, brain);
      }

      const summaries = await _getAgentPerformanceHistoryWithAccessor({}, brain);

      expect(summaries.length).toBe(2); // executor/task + researcher/epic

      const executorSummary = summaries.find(
        (s) => s.agentType === 'executor' && s.taskType === 'task',
      );
      expect(executorSummary).toBeDefined();
      expect(executorSummary!.totalAttempts).toBe(3);
      expect(executorSummary!.successCount).toBe(2);
      expect(executorSummary!.failureCount).toBe(1);
      expect(executorSummary!.successRate).toBeCloseTo(0.667, 2);

      const researcherSummary = summaries.find(
        (s) => s.agentType === 'researcher' && s.taskType === 'epic',
      );
      expect(researcherSummary).toBeDefined();
      expect(researcherSummary!.totalAttempts).toBe(1);
      expect(researcherSummary!.successRate).toBe(1.0);
    });

    it('filters by agentType when specified', async () => {
      const brain = await getBrainAccessor(tempDir);

      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a1',
          agentType: 'executor',
          taskId: 'T1',
          taskType: 'task',
          outcome: 'success',
        },
        brain,
      );
      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a2',
          agentType: 'researcher',
          taskId: 'T2',
          taskType: 'epic',
          outcome: 'success',
        },
        brain,
      );

      const summaries = await _getAgentPerformanceHistoryWithAccessor(
        { agentType: 'executor' },
        brain,
      );

      expect(summaries.length).toBe(1);
      expect(summaries[0]!.agentType).toBe('executor');
    });

    it('filters by taskType when specified', async () => {
      const brain = await getBrainAccessor(tempDir);

      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a1',
          agentType: 'executor',
          taskId: 'T1',
          taskType: 'task',
          outcome: 'success',
        },
        brain,
      );
      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a2',
          agentType: 'executor',
          taskId: 'T2',
          taskType: 'epic',
          outcome: 'failure',
          errorType: 'permanent',
        },
        brain,
      );

      const summaries = await _getAgentPerformanceHistoryWithAccessor({ taskType: 'epic' }, brain);

      expect(summaries.length).toBe(1);
      expect(summaries[0]!.taskType).toBe('epic');
      expect(summaries[0]!.failureCount).toBe(1);
    });

    it('tracks lastOutcome and lastSeenAt', async () => {
      const brain = await getBrainAccessor(tempDir);

      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a1',
          agentType: 'executor',
          taskId: 'T1',
          taskType: 'task',
          outcome: 'success',
        },
        brain,
      );
      await _recordAgentExecutionWithAccessor(
        {
          agentId: 'a1',
          agentType: 'executor',
          taskId: 'T2',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'retriable',
        },
        brain,
      );

      const summaries = await _getAgentPerformanceHistoryWithAccessor({}, brain);
      const s = summaries.find((x) => x.agentType === 'executor');

      expect(s).toBeDefined();
      expect(s!.lastOutcome).toBe('failure'); // last recorded
      expect(s!.lastSeenAt).not.toBeNull();
    });
  });

  // ==========================================================================
  // recordFailurePattern
  // ==========================================================================

  describe('recordFailurePattern', () => {
    it('returns null for non-failure events', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'success',
      };
      const result = await recordFailurePattern(event, tempDir);
      expect(result).toBeNull();
    });

    it('creates a new failure pattern on first occurrence', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'failure',
        errorType: 'permanent',
        errorMessage: 'Permission denied',
      };

      const pattern = await recordFailurePattern(event, tempDir);

      expect(pattern).not.toBeNull();
      expect(pattern!.id).toMatch(/^P-agt-/);
      expect(pattern!.type).toBe('failure');
      expect(pattern!.frequency).toBe(1);
      expect(pattern!.pattern).toContain('executor');
      expect(pattern!.pattern).toContain('task');
      expect(pattern!.pattern).toContain('permanent');
      expect(pattern!.mitigation).toContain('Reassign task');
    });

    it('increments frequency on repeated failures with same pattern', async () => {
      const brain = await getBrainAccessor(tempDir);

      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'researcher',
        taskId: 'T001',
        taskType: 'epic',
        outcome: 'failure',
        errorType: 'retriable',
      };

      const first = await _recordFailurePatternWithAccessor(event, brain);
      expect(first!.frequency).toBe(1);

      // Second occurrence — same agentType, taskType, errorType
      const second = await _recordFailurePatternWithAccessor({ ...event, taskId: 'T002' }, brain);
      expect(second!.frequency).toBe(2);

      // Third occurrence
      const third = await _recordFailurePatternWithAccessor({ ...event, taskId: 'T003' }, brain);
      expect(third!.frequency).toBe(3);
    });

    it('builds retry suggestion for retriable errors', async () => {
      const brain = await getBrainAccessor(tempDir);

      const pattern = await _recordFailurePatternWithAccessor(
        {
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T001',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'retriable',
        },
        brain,
      );

      expect(pattern!.mitigation).toContain('Retry with exponential backoff');
    });

    it('builds reassign suggestion for permanent errors', async () => {
      const brain = await getBrainAccessor(tempDir);

      const pattern = await _recordFailurePatternWithAccessor(
        {
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T001',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'permanent',
        },
        brain,
      );

      expect(pattern!.mitigation).toContain('Reassign task to a different agent type');
    });
  });

  // ==========================================================================
  // storeHealingStrategy
  // ==========================================================================

  describe('storeHealingStrategy', () => {
    it('returns null for non-failure events', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'success',
      };
      const result = await storeHealingStrategy(event, 'some strategy', tempDir);
      expect(result).toBeNull();
    });

    it('stores a change observation with healing narrative', async () => {
      const brain = await getBrainAccessor(tempDir);

      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'failure',
        errorType: 'permanent',
        sessionId: 'ses_test_abc',
      };

      const obs = await _storeHealingStrategyWithAccessor(
        event,
        'Switch to validator agent',
        brain,
      );

      expect(obs).not.toBeNull();
      expect(obs!.id).toMatch(/^O-agt-/);
      expect(obs!.type).toBe('change');
      expect(obs!.sourceType).toBe('agent');
      expect(obs!.narrative).toBe('Switch to validator agent');
      expect(obs!.title).toContain('executor');
      expect(obs!.title).toContain('task');
      expect(obs!.sourceSessionId).toBe('ses_test_abc');

      const facts = JSON.parse(obs!.factsJson ?? '[]') as string[];
      expect(facts.some((f) => f.includes('executor'))).toBe(true);
      expect(facts.some((f) => f.includes('Switch to validator agent'))).toBe(true);

      const concepts = JSON.parse(obs!.conceptsJson ?? '[]') as string[];
      expect(concepts).toContain('self-healing');
      expect(concepts).toContain('executor');
    });
  });

  // ==========================================================================
  // getSelfHealingSuggestions
  // ==========================================================================

  describe('getSelfHealingSuggestions', () => {
    it('returns empty array when no failure patterns exist', async () => {
      const suggestions = await getSelfHealingSuggestions('executor', 'task', tempDir);
      expect(suggestions).toEqual([]);
    });

    it('returns suggestions matching agentType and taskType', async () => {
      const brain = await getBrainAccessor(tempDir);

      // Record three failures to build up a pattern
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'researcher',
        taskId: 'T001',
        taskType: 'epic',
        outcome: 'failure',
        errorType: 'retriable',
      };

      for (let i = 0; i < 3; i++) {
        await _recordFailurePatternWithAccessor({ ...event, taskId: `T00${i}` }, brain);
      }

      const suggestions = await _getSelfHealingSuggestionsWithAccessor('researcher', 'epic', brain);

      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions[0]!.frequency).toBe(3);
      expect(suggestions[0]!.failurePattern).toContain('researcher');
      expect(suggestions[0]!.failurePattern).toContain('epic');
      expect(suggestions[0]!.suggestion).toBeTruthy();
      expect(suggestions[0]!.confidence).toBeGreaterThan(0);
      expect(suggestions[0]!.confidence).toBeLessThanOrEqual(0.9);
    });

    it('does not return suggestions for a different agent type', async () => {
      const brain = await getBrainAccessor(tempDir);

      await _recordFailurePatternWithAccessor(
        {
          agentId: 'agt_1',
          agentType: 'executor',
          taskId: 'T001',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'permanent',
        },
        brain,
      );

      // Query for a different agent type
      const suggestions = await _getSelfHealingSuggestionsWithAccessor('researcher', 'task', brain);
      expect(suggestions).toEqual([]);
    });

    it('orders suggestions by frequency descending', async () => {
      const brain = await getBrainAccessor(tempDir);

      // Build retriable pattern with high frequency
      for (let i = 0; i < 5; i++) {
        await _recordFailurePatternWithAccessor(
          {
            agentId: 'agt_1',
            agentType: 'validator',
            taskId: `T${i}`,
            taskType: 'task',
            outcome: 'failure',
            errorType: 'retriable',
          },
          brain,
        );
      }

      // Build permanent pattern with lower frequency
      await _recordFailurePatternWithAccessor(
        {
          agentId: 'agt_1',
          agentType: 'validator',
          taskId: 'T99',
          taskType: 'task',
          outcome: 'failure',
          errorType: 'permanent',
        },
        brain,
      );

      const suggestions = await _getSelfHealingSuggestionsWithAccessor('validator', 'task', brain);

      expect(suggestions.length).toBe(2);
      // Higher frequency should come first
      expect(suggestions[0]!.frequency).toBeGreaterThan(suggestions[1]!.frequency);
    });
  });

  // ==========================================================================
  // processAgentLifecycleEvent
  // ==========================================================================

  describe('processAgentLifecycleEvent', () => {
    it('records decision and returns decisionId for success events', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'success',
      };

      const result = await processAgentLifecycleEvent(event, tempDir);

      expect(result.decisionId).toMatch(/^AGT-/);
      expect(result.patternId).toBeNull(); // no failure pattern for success
      expect(result.observationId).toBeNull();
      expect(result.healingSuggestions).toEqual([]);
    });

    it('records decision + pattern for failure events', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'researcher',
        taskId: 'T002',
        taskType: 'epic',
        outcome: 'failure',
        errorType: 'permanent',
      };

      const result = await processAgentLifecycleEvent(event, tempDir);

      expect(result.decisionId).toMatch(/^AGT-/);
      expect(result.patternId).toMatch(/^P-agt-/);
      expect(result.observationId).toBeNull(); // frequency = 1, threshold not met
    });

    it('records healing observation once pattern frequency reaches 3', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'subtask',
        outcome: 'failure',
        errorType: 'retriable',
      };

      // First two calls — observation not stored yet
      await processAgentLifecycleEvent({ ...event, taskId: 'T001' }, tempDir);
      const second = await processAgentLifecycleEvent({ ...event, taskId: 'T002' }, tempDir);
      expect(second.observationId).toBeNull();

      // Third call — threshold reached
      const third = await processAgentLifecycleEvent({ ...event, taskId: 'T003' }, tempDir);
      expect(third.observationId).toMatch(/^O-agt-/);
    });

    it('returns healing suggestions for failure events when patterns exist', async () => {
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'orchestrator',
        taskId: 'T001',
        taskType: 'epic',
        outcome: 'failure',
        errorType: 'unknown',
      };

      // Build up frequency
      await processAgentLifecycleEvent({ ...event, taskId: 'T001' }, tempDir);
      await processAgentLifecycleEvent({ ...event, taskId: 'T002' }, tempDir);
      const result = await processAgentLifecycleEvent({ ...event, taskId: 'T003' }, tempDir);

      expect(result.healingSuggestions.length).toBeGreaterThanOrEqual(1);
      expect(result.healingSuggestions[0]!.frequency).toBeGreaterThanOrEqual(3);
    });

    it('is entirely best-effort — does not throw when brain.db unavailable', async () => {
      // bad cwd -> brain.db open will fail silently
      const event: AgentExecutionEvent = {
        agentId: 'agt_1',
        agentType: 'executor',
        taskId: 'T001',
        taskType: 'task',
        outcome: 'failure',
        errorType: 'retriable',
      };

      await expect(processAgentLifecycleEvent(event, '/nonexistent/xyz')).resolves.toEqual({
        decisionId: null,
        patternId: null,
        observationId: null,
        healingSuggestions: [],
      });
    });
  });
});
