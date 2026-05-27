/**
 * Contract tests for completion.* and projection.repair dispatch shapes.
 *
 * @task T10607
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../dispatch/operations-registry.js';
import {
  completionEvaluateParamsSchema,
  completionEvaluationSchema,
  completionExplainParamsSchema,
  completionExplanationSchema,
  completionListParamsSchema,
  completionListResultSchema,
  completionProjectionRepairErrorSchema,
  completionProjectionRepairParamsSchema,
  completionProjectionRepairResultSchema,
  unsatisfiedCompletionCriterionSchema,
} from '../tasks.js';

const requiredOperations = [
  'completion.list',
  'completion.evaluate',
  'completion.explain',
  'projection.repair',
] as const;

function operation(name: (typeof requiredOperations)[number]) {
  const def = OPERATIONS.find(
    (candidate) => candidate.domain === 'tasks' && candidate.operation === name,
  );
  if (def === undefined) throw new Error(`missing tasks.${name}`);
  return def;
}

const unsatisfiedCriterion = {
  acId: 'ac-1',
  alias: 'AC1',
  text: 'typed AC result schemas added',
  kind: 'evidence_bound',
  status: 'unsatisfied',
  reason: 'missing_evidence_binding',
  evidenceBindings: 0,
} as const;

const totals = { criteria: 1, satisfied: 0, unsatisfied: 1, waived: 0, replaced: 0 };

describe('Completion operation contract schemas', () => {
  it('validates typed AC result, unsatisfied criterion, evaluate, and explain shapes', () => {
    expect(unsatisfiedCompletionCriterionSchema.parse(unsatisfiedCriterion).reason).toBe(
      'missing_evidence_binding',
    );

    expect(
      completionEvaluationSchema.parse({
        taskId: 'T10607',
        taskStatus: 'pending',
        ready: false,
        stale: false,
        staleReasons: [],
        satisfied: [],
        unsatisfied: [unsatisfiedCriterion],
        waived: [],
        replaced: [],
        totals,
      }).unsatisfied,
    ).toHaveLength(1);

    expect(
      completionExplanationSchema.parse({
        taskId: 'T10607',
        ready: false,
        stale: true,
        summary: 'Task has one unsatisfied completion criterion.',
        blockers: [unsatisfiedCriterion],
      }).blockers[0]?.status,
    ).toBe('unsatisfied');
  });

  it('validates params/results for completion.list/evaluate/explain/projection.repair', () => {
    expect(completionListParamsSchema.parse({ taskId: 'T10607', status: 'unsatisfied' })).toEqual({
      taskId: 'T10607',
      status: 'unsatisfied',
    });
    expect(
      completionListResultSchema.parse({
        taskId: 'T10607',
        criteria: [unsatisfiedCriterion],
        totals,
      }).criteria[0]?.alias,
    ).toBe('AC1');

    expect(
      completionEvaluateParamsSchema.parse({
        taskId: 'T10607',
        includeContext: true,
        limit: 10,
        relationDepth: 1,
      }),
    ).toEqual({ taskId: 'T10607', includeContext: true, limit: 10, relationDepth: 1 });
    expect(completionExplainParamsSchema.parse({ taskId: 'T10607', since: '2026-05-26' })).toEqual({
      taskId: 'T10607',
      since: '2026-05-26',
    });

    expect(
      completionProjectionRepairErrorSchema.parse({
        code: 'criteria_missing',
        message: 'Projected AC row no longer exists.',
        taskId: 'T10607',
        acId: 'ac-1',
      }).code,
    ).toBe('criteria_missing');
    expect(
      completionProjectionRepairParamsSchema.parse({ taskId: 'T10607', dryRun: true }),
    ).toEqual({
      taskId: 'T10607',
      dryRun: true,
    });
    expect(
      completionProjectionRepairResultSchema.parse({
        taskId: 'T10607',
        repaired: false,
        dryRun: true,
        staleBefore: true,
        staleAfter: true,
        errors: [
          {
            code: 'repair_conflict',
            message: 'Concurrent projection change detected.',
            taskId: 'T10607',
          },
        ],
      }).errors[0]?.code,
    ).toBe('repair_conflict');
  });

  it('publishes operation metadata with taskId requirements and correct gateways', () => {
    for (const name of requiredOperations) {
      const def = operation(name);
      expect(def.domain).toBe('tasks');
      expect(def.idempotent).toBe(true);
      expect(def.requiredParams).toEqual(['taskId']);
      expect(def.params?.map((param) => param.name)).toContain('taskId');
    }

    expect(operation('completion.list').gateway).toBe('query');
    expect(operation('completion.evaluate').gateway).toBe('query');
    expect(operation('completion.explain').gateway).toBe('query');
    expect(operation('projection.repair').gateway).toBe('mutate');
  });
});
