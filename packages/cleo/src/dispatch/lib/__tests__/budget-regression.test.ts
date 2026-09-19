/**
 * Budget chokepoint forward-only regression test (T11424).
 *
 * Asserts that the budget.ts module still imports the canonical symbols from
 * @cleocode/lafs and that the focus ≤ 1500 token enforcement wired in T11285/T11350
 * remains operational. Any refactor that moves these symbols or renames the imports
 * will fail this test — intentional; the budget chokepoint MUST stay green.
 *
 * @task T11424
 * @epic T11394 E7-LAFS-CANONICAL
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { describe, expect, it } from 'vitest';
import { createBudgetEnforcement } from '../../middleware/budget-enforcement.js';
import { BUDGET_EXCEEDED_CODE, enforceBudget, isWithinBudget } from '../budget.js';

// ─────────────────────────────────────────────────────────────────────────────
// Symbol-resolution regression: confirms the canonical LAFS imports are wired
// ─────────────────────────────────────────────────────────────────────────────

describe('budget chokepoint — import contract regression (T11424)', () => {
  it('resolves the production core leaf with Node package exports, without source aliases', () => {
    const source = readFileSync(new URL('../budget.ts', import.meta.url), 'utf8');
    const specifier = source.match(/from '(@cleocode\/core\/[^']+)'/)?.[1];
    if (!specifier) throw new Error('Budget bridge must import its core projection leaf');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'process.stdout.write(import.meta.resolve(process.argv[1]))',
        specifier,
      ],
      {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\/core\/dist\/dispatch\/mvi-projection\.js$/);
  });

  it('BUDGET_EXCEEDED_CODE is a non-empty string (resolves from @cleocode/lafs)', () => {
    expect(typeof BUDGET_EXCEEDED_CODE).toBe('string');
    expect(BUDGET_EXCEEDED_CODE.length).toBeGreaterThan(0);
  });

  it('enforceBudget is callable (applyBudgetEnforcement wired)', () => {
    const response = { success: true, data: { ok: true } };
    const result = enforceBudget(response, 10000);
    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('enforcement');
    expect(result).toHaveProperty('exceeded');
    expect(typeof result.exceeded).toBe('boolean');
  });

  it('isWithinBudget is callable (checkBudget wired)', () => {
    const response = { success: true, data: { ok: true } };
    expect(typeof isWithinBudget(response, 10000)).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Focus ≤ 1500 enforcement: simulates the dispatch chokepoint behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('budget chokepoint — focus ≤ 1500 token enforcement (T11285)', () => {
  it('small response is within a 1500-token budget', () => {
    const smallFocusResponse = {
      success: true,
      data: {
        identity: { id: 'T11394', title: 'E7 LAFS' },
        scope: { epicId: 'T11394' },
        blockers: [],
        readyWave: [],
      },
    };
    expect(isWithinBudget(smallFocusResponse, 1500)).toBe(true);
  });

  it('oversized response exceeds a 1-token budget (overflow detection works)', () => {
    const largeResponse = {
      success: true,
      data: {
        items: Array.from({ length: 200 }, (_, i) => ({
          id: `T${i}`,
          title: 'x'.repeat(200),
          description: 'y'.repeat(400),
        })),
      },
    };
    expect(isWithinBudget(largeResponse, 1)).toBe(false);
  });

  it('enforceBudget adds _budgetEnforcement meta to response', () => {
    const response = { success: true, data: { ok: true }, meta: { operation: 'focus.show' } };
    const { response: enforced } = enforceBudget(response, 1500);
    const meta = enforced['meta'] as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta['_budgetEnforcement']).toBeDefined();
    const be = meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(typeof be['estimatedTokens']).toBe('number');
    expect(be['budget']).toBe(1500);
  });
});

describe('knowledge truth survives the budget middleware T12199', () => {
  function request(budget: number): DispatchRequest {
    return {
      gateway: 'query',
      domain: 'focus',
      operation: 'show',
      source: 'cli',
      requestId: 'truth-budget',
      params: { _budget: budget },
    };
  }
  function response(): DispatchResponse {
    return {
      success: true,
      meta: {
        gateway: 'query',
        domain: 'focus',
        operation: 'show',
        source: 'cli',
        requestId: 'truth-budget',
        timestamp: '2026-09-19T00:00:00Z',
        duration_ms: 1,
      },
      data: {
        identity: { id: 'T136' },
        scope: { taskId: 'T136' },
        examples: 'é😀'.repeat(3000),
        coverage: {
          status: 'failed',
          projectId: 'axiom',
          assessedRevision: null,
          indexedRevision: null,
          assessedAt: '2026-09-19T00:00:00Z',
          reasons: ['Git unavailable'],
          evidence: [],
          limitations: ['Static callers cannot prove runtime completeness'],
        },
        knowledgeHealth: {
          findingCount: 2,
          findingStates: { pending: 2 },
          detailsCommand: 'cleo doctor knowledge',
        },
        sourceDiagnostics: {
          git: { status: 'failed', reasons: ['No included repository'], evidence: [] },
        },
      },
    };
  }
  it('removes examples before current coverage, failure counts and pending repair facts', async () => {
    const source = response();
    const output = await createBudgetEnforcement()(request(240), async () => source);
    expect(output.success).toBe(true);
    expect(output.data).toMatchObject({
      identity: { id: 'T136' },
      scope: { taskId: 'T136' },
      coverage: {
        status: 'failed',
        projectId: 'axiom',
        reasons: ['Git unavailable'],
        limitations: ['Static callers cannot prove runtime completeness'],
      },
      knowledgeHealth: {
        findingCount: 2,
        findingStates: { pending: 2 },
        detailsCommand: 'cleo doctor knowledge',
      },
      sourceDiagnostics: { git: { status: 'failed', reasons: ['No included repository'] } },
      _withheld: { examples: 18000 },
    });
    expect(output.data).not.toHaveProperty('examples');
  });
  it.each([0, 1])('rejects budget %s when mandatory truth cannot fit', async (budget) => {
    const output = await createBudgetEnforcement()(request(budget), async () => response());
    expect(output.success).toBe(false);
    expect(output.error).toMatchObject({
      code: BUDGET_EXCEEDED_CODE,
      exitCode: ExitCode.VALIDATION_ERROR,
    });
    expect(output.data).toBeNull();
  });
});

it('retains population and emitted rows together or rejects an insufficient budget (T12200)', async () => {
  const data = {
    results: [{ id: 'T1', title: 'one' }],
    population: {
      matched: 3,
      returned: 1,
      truncated: true,
      archive: 'excluded',
      limit: 1,
      offset: 0,
    },
    examples: 'example '.repeat(500),
  };
  const roomy = enforceBudget({ success: true, data }, 500);
  expect(roomy.response.success).toBe(true);
  expect(roomy.response.data).toMatchObject({ results: data.results, population: data.population });
  const tiny = enforceBudget({ success: true, data }, 1);
  expect(tiny.exceeded).toBe(true);
  const request: DispatchRequest = {
    gateway: 'query',
    domain: 'tasks',
    operation: 'find',
    source: 'cli',
    requestId: 'population-budget',
    params: { _budget: 1 },
  };
  const response = await createBudgetEnforcement()(request, async () => ({
    success: true,
    data,
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'find',
      source: 'cli',
      requestId: 'population-budget',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
    },
  }));
  expect(response.success).toBe(false);
});
