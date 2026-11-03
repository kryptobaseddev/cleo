/**
 * Per-criterion receipt (T14199): a decision binds to one criterion that
 * names no code path, covering only that criterion; a criterion naming code
 * is refused with its token; the task's gates are never touched.
 *
 * @task T14199
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeDecision } from '../../memory/decisions.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { computeAcCoverage } from '../ac-coverage-gate.js';
import { addTask } from '../add.js';
import { recordCriterionReceipt } from '../criterion-receipt.js';

describe('recordCriterionReceipt (T14199)', () => {
  let env: TestDbEnv;
  let taskId: string;
  let decisionId: string;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    const added = await addTask(
      {
        title: 'Receipt fixture',
        description: 'A code task with one criterion met by an owner decision',
        acceptance: [
          'the owner chose the rollout order',
          'packages/core/src/receipt-fixture.ts refuses a stale row',
          'the refusal names its reason',
        ],
        skipContainmentInvariant: true,
      },
      env.tempDir,
      env.accessor,
    );
    taskId = added.task.id;
    const decision = await storeDecision(env.tempDir, {
      type: 'technical',
      decision: 'Roll out to staging before production',
      rationale: 'Staging catches store migrations first.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    decisionId = decision.id;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  async function uncovered(): Promise<string[]> {
    const coverage = await computeAcCoverage(taskId, env.accessor);
    return coverage.ok ? [] : coverage.unsatisfied.map((ac) => ac.alias);
  }

  it('binds a decision to one non-code criterion, covering only that criterion', async () => {
    const before = JSON.stringify((await env.accessor.loadSingleTask(taskId))?.verification);
    const result = await recordCriterionReceipt(env.tempDir, {
      taskId,
      evidence: `decision:${decisionId};satisfies:${taskId}#AC1`,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.criterion).toBe('AC1');
    expect(result.data.evidenceAtomId).toBe(`receipt:decision:${decisionId}->${taskId}#AC1`);
    expect(await uncovered()).toEqual(['AC2', 'AC3']);

    // The gates still owe their code evidence: verification is byte-identical.
    const after = await env.accessor.loadSingleTask(taskId);
    expect(JSON.stringify(after?.verification)).toBe(before);
    expect(after?.verification?.gates.implemented ?? false).toBe(false);
    expect(after?.verification?.gates.testsPassed ?? false).toBe(false);
    expect(after?.verification?.gates.qaPassed ?? false).toBe(false);
  });

  it('refuses a criterion that names a code path, naming the token', async () => {
    const result = await recordCriterionReceipt(env.tempDir, {
      taskId,
      evidence: `decision:${decisionId};satisfies:${taskId}#AC2`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_CRITERION_NAMES_CODE');
    expect(result.error.message).toContain('packages/core/src/receipt-fixture.ts');
    expect(await uncovered()).toEqual(['AC1', 'AC2', 'AC3']);
  });

  it('refuses gate evidence, a code file, and a second criterion', async () => {
    for (const evidence of [
      `commit:abc1234;decision:${decisionId};satisfies:${taskId}#AC3`,
      `files:src/receipt-fixture.ts;satisfies:${taskId}#AC3`,
      `decision:${decisionId};satisfies:${taskId}#AC1;satisfies:${taskId}#AC3`,
      `satisfies:${taskId}#AC3`,
    ]) {
      const result = await recordCriterionReceipt(env.tempDir, { taskId, evidence });
      expect(result.success, evidence).toBe(false);
      if (result.success) continue;
      expect(result.error.code, evidence).toBe('E_EVIDENCE_INVALID');
    }
    expect(await uncovered()).toEqual(['AC1', 'AC2', 'AC3']);
  });
});
