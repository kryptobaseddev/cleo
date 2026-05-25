/**
 * Tests for T10555 — agent operation contract doctrine.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_OPERATION_CONTRACT_DOCTRINE,
  type AgentMutationResult,
  type AgentOperationDryRun,
  type AgentOperationEmptyState,
  type AgentOperationSessionLineage,
} from '../agent-operation-contract.js';

interface SampleTaskMutation {
  readonly title: string;
}

interface SampleMutationData {
  readonly taskIds: string[];
}

const session: AgentOperationSessionLineage = {
  executionSessionId: 'ses_worker_1',
  originSessionId: 'ses_orchestrator_1',
};

describe('AgentMutationResult doctrine', () => {
  it('standardizes mutation result shape with status, ok, data, items, summary, issues, and session', () => {
    const result: AgentMutationResult<SampleMutationData, SampleTaskMutation> = {
      status: 'success',
      ok: true,
      data: { taskIds: ['T1'] },
      items: [
        {
          id: 'T1',
          effect: 'applied',
          item: { title: 'ship contract' },
          issues: [],
        },
      ],
      summary: {
        requested: 1,
        applied: 1,
        planned: 0,
        skipped: 0,
        failed: 0,
      },
      issues: [],
      session,
    };

    expect(result).toMatchObject({
      status: 'success',
      ok: true,
      data: { taskIds: ['T1'] },
      summary: { requested: 1, applied: 1, planned: 0, skipped: 0, failed: 0 },
      session,
    });
    expect(AGENT_OPERATION_CONTRACT_DOCTRINE.mutationStatuses).toEqual([
      'success',
      'partial_success',
      'empty',
      'dry_run',
      'failed',
    ]);
  });

  it('defines partial-success as durable writes plus skipped or failed items', () => {
    const result: AgentMutationResult<SampleMutationData, SampleTaskMutation> = {
      status: 'partial_success',
      ok: true,
      data: { taskIds: ['T1'] },
      items: [
        { id: 'T1', effect: 'applied', item: { title: 'applied' }, issues: [] },
        {
          id: 'T2',
          effect: 'failed',
          item: { title: 'rejected' },
          issues: [
            { code: 'E_TASK_LOCKED', severity: 'error', message: 'Task is locked', target: 'T2' },
          ],
        },
      ],
      summary: {
        requested: 2,
        applied: 1,
        planned: 0,
        skipped: 0,
        failed: 1,
      },
      issues: [
        { code: 'E_TASK_LOCKED', severity: 'error', message: 'Task is locked', target: 'T2' },
      ],
      session,
    };

    expect(result.status).toBe(AGENT_OPERATION_CONTRACT_DOCTRINE.partialSuccess.status);
    expect(result.summary.applied).toBeGreaterThanOrEqual(
      AGENT_OPERATION_CONTRACT_DOCTRINE.partialSuccess.requiresAppliedMinimum,
    );
    expect(result.summary.failed + result.summary.skipped).toBeGreaterThanOrEqual(
      AGENT_OPERATION_CONTRACT_DOCTRINE.partialSuccess.requiresRejectedOrSkippedMinimum,
    );
    expect(AGENT_OPERATION_CONTRACT_DOCTRINE.partialSuccess.inspect).toEqual(['items', 'issues']);
  });

  it('distinguishes executionSessionId from originSessionId for delegated operation lineage', () => {
    expect(session.executionSessionId).toBe('ses_worker_1');
    expect(session.originSessionId).toBe('ses_orchestrator_1');
    expect(AGENT_OPERATION_CONTRACT_DOCTRINE.sessionLineage.executionSessionId).toContain(
      'executed',
    );
    expect(AGENT_OPERATION_CONTRACT_DOCTRINE.sessionLineage.originSessionId).toContain(
      'originated',
    );
  });

  it('defines typed empty-state and dry-run semantics', () => {
    const emptyState: AgentOperationEmptyState = {
      code: 'EMPTY_NO_CANDIDATES',
      reason: 'No candidate tasks matched the mutation filter.',
      nextAction: 'Create or select a task before retrying.',
    };
    const dryRun: AgentOperationDryRun = {
      enabled: true,
      plannedWrites: 2,
      appliedWrites: 0,
    };

    const emptyResult: AgentMutationResult<SampleMutationData, SampleTaskMutation> = {
      status: 'empty',
      ok: true,
      data: { taskIds: [] },
      items: [],
      summary: { requested: 0, applied: 0, planned: 0, skipped: 0, failed: 0 },
      issues: [],
      session,
      emptyState,
    };
    const dryRunResult: AgentMutationResult<SampleMutationData, SampleTaskMutation> = {
      status: 'dry_run',
      ok: true,
      data: { taskIds: ['T1', 'T2'] },
      items: [
        { id: 'T1', effect: 'planned', item: { title: 'preview one' }, issues: [] },
        { id: 'T2', effect: 'planned', item: { title: 'preview two' }, issues: [] },
      ],
      summary: { requested: 2, applied: 0, planned: 2, skipped: 0, failed: 0 },
      issues: [],
      session,
      dryRun,
    };

    expect(emptyResult.emptyState).toEqual(emptyState);
    expect(dryRunResult.dryRun).toEqual(dryRun);
    expect(dryRunResult.items.every((item) => item.effect === 'planned')).toBe(true);
    expect(dryRunResult.summary.applied).toBe(
      AGENT_OPERATION_CONTRACT_DOCTRINE.dryRun.appliedWrites,
    );
  });
});
