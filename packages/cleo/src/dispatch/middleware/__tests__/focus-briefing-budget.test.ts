/**
 * Enforce `cleo focus` ≤ 1500 and `cleo briefing` token budgets through the
 * LIVE budget chokepoint (T11352).
 *
 * Before this epic the focus ≤1500 contract was only a TSDoc comment in
 * `focus.ts` with ZERO runtime enforcement, and the weak focus test merely
 * asserted `tokensEstimated > 0`. This test drives the REAL
 * `createBudgetEnforcement()` middleware (the same instance wired into
 * `createCliDispatcher`) for the `focus.show` and `session.briefing.show`
 * operations and asserts that an over-budget payload is TRUNCATED or raised as
 * `E_MVI_BUDGET_EXCEEDED` — NOT merely that an estimate is positive.
 *
 * The ceiling is read from the single named constant {@link FOCUS_TOKEN_CEILING}
 * (no magic-number duplication): the test asserts the enforced budget stamped
 * on the response equals that constant.
 *
 * @task T11352
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { KnowledgeDoctorResult, KnowledgeRepairReceipt } from '@cleocode/contracts';
import { listKnowledgeRepairReceipts, runKnowledgeDoctor } from '@cleocode/core/doctor/knowledge';
import { computeBriefing } from '@cleocode/core/sessions/briefing';
import { describe, expect, it, vi } from 'vitest';
import { BUDGET_EXCEEDED_CODE } from '../../lib/budget.js';
import { BRIEFING_TOKEN_CEILING, FOCUS_TOKEN_CEILING } from '../../lib/budget-ceilings.js';
import type { DispatchRequest, DispatchResponse, DispatchResponseMeta } from '../../types.js';
import { createBudgetEnforcement } from '../budget-enforcement.js';

vi.mock('@cleocode/core/doctor/knowledge', () => ({
  runKnowledgeDoctor: vi.fn(),
  listKnowledgeRepairReceipts: vi.fn(),
}));
vi.mock('@cleocode/core/store/data-accessor', () => ({
  getAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
  getTaskAccessor: async () => ({
    queryTasks: async () => ({
      tasks: [
        { id: 'T448', title: 'Verify current authority', status: 'pending', priority: 'high' },
      ],
      total: 1,
    }),
    getMetaValue: async () => null,
    resolveCurrentSession: async () => null,
    getActiveSession: async () => null,
  }),
}));
vi.mock('@cleocode/core/store/memory-accessor', () => ({
  getBrainAccessor: async () => ({
    findDecisions: async () => [
      {
        id: 'D004',
        confirmationState: 'accepted',
        decision: 'Use the corrected owner directive.',
        createdAt: '2026-09-18T00:00:00Z',
      },
    ],
  }),
}));
vi.mock('@cleocode/core/sessions/handoff', () => ({ getLastHandoff: async () => null }));

/** Build a bare dispatch request for a given domain/operation. */
function req(domain: string, operation: string): DispatchRequest {
  return {
    gateway: 'query',
    domain,
    operation,
    params: {},
    source: 'cli',
    requestId: '00000000-0000-0000-0000-000000000000',
  };
}

/** Build a minimal always-present response meta block. */
function meta(domain: string, operation: string): DispatchResponseMeta {
  return {
    gateway: 'query',
    domain,
    operation,
    timestamp: '2026-05-29T00:00:00.000Z',
    duration_ms: 0,
    source: 'cli',
    requestId: '00000000-0000-0000-0000-000000000000',
  };
}

/** A focus-shaped payload far larger than 1500 tokens. */
function overBudgetFocusData(): Record<string, unknown> {
  return {
    identity: { id: 'T9973', type: 'task' },
    scope: { taskId: 'T9973', epicId: 'T9964' },
    blockers: Array.from({ length: 50 }, (_, i) => ({
      id: `B${i}`,
      reason: 'x'.repeat(300),
    })),
    readyWave: Array.from({ length: 50 }, (_, i) => ({
      id: `T${i}`,
      title: 'y'.repeat(300),
    })),
    tokensEstimated: 0,
  };
}

describe('focus ≤1500 + briefing budgets enforced via live chokepoint (T11352)', () => {
  it('keeps sourced current guidance, corrections, and tasks in a default briefing with hundreds of stale files', async () => {
    const report: KnowledgeDoctorResult = {
      health: {
        coverage: {
          status: 'stale',
          projectId: 'fixture',
          assessedRevision: null,
          indexedRevision: null,
          assessedAt: '2026-09-18T00:00:00Z',
          evidence: [],
          limitations: ['Static analysis cannot prove all runtime callers.'],
          reasons: Array.from(
            { length: 500 },
            (_, index) => `Source changed after indexing: src/long-path/file-${index}.ts`,
          ),
        },
        structure: { status: 'clean', reasons: [], evidence: [] },
        semantics: {
          status: 'findings',
          reasons: ['Historical conflict corrected.'],
          evidence: [],
        },
        extraction: { status: 'unavailable', reasons: ['No model configured.'], evidence: [] },
        findings: [
          {
            id: 'stale-links',
            projectId: 'fixture',
            affectedRecordIds: Array.from({ length: 500 }, (_, index) => `source-${index}`),
            description: 'Rebuild derived references.',
            evidence: [],
            repairClass: 'automatic',
            state: 'pending',
            proposedAction: null,
            verification: ['References match sources.'],
            recovery: null,
          },
        ],
      },
      stateHash: 'fixture',
      proposals: [],
      receipts: [],
      dryRun: false,
    };
    const receipt: KnowledgeRepairReceipt = {
      id: 'receipt-1',
      proposalId: 'proposal-1',
      findingId: 'authority-1',
      projectId: 'fixture',
      state: 'repaired',
      attempt: 1,
      startedAt: '2026-09-18T00:00:00Z',
      completedAt: '2026-09-18T00:00:01Z',
      recovery: {
        snapshotId: 'snapshot-1',
        restoreAction: { operation: 'knowledge.rollback', arguments: {}, prerequisites: [] },
      },
      action: {
        operation: 'knowledge.supersede-decision',
        arguments: { previousId: 'D001', successorId: 'D004' },
        prerequisites: [],
      },
      verificationEvidence: [
        {
          id: 'docs/owner-directive.md',
          projectId: 'fixture',
          source: 'file',
          revision: 'revision-1',
          precision: 'record',
          excerpt: 'long source excerpt '.repeat(2000),
        },
      ],
      reasons: [],
    };
    vi.mocked(runKnowledgeDoctor).mockResolvedValueOnce(report);
    vi.mocked(listKnowledgeRepairReceipts).mockResolvedValueOnce([receipt]);
    const briefing = await computeBriefing('/fixture', { scope: 'global' });
    const response: DispatchResponse = {
      success: true,
      data: briefing,
      meta: meta('session', 'briefing.show'),
    };
    const result = await createBudgetEnforcement()(
      req('session', 'briefing.show'),
      async () => response,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      knowledgeCoverage: {
        status: 'stale',
        reasonCount: 500,
        detailsCommand: 'cleo doctor knowledge',
      },
      currentGuidance: [{ id: 'D004', title: 'Use the corrected owner directive.' }],
      corrections: [
        { previousId: 'D001', successorId: 'D004', evidence: [{ id: 'docs/owner-directive.md' }] },
      ],
      nextTasks: [expect.objectContaining({ id: 'T448' })],
      knowledgeHealth: {
        findingCount: 1,
        findingStates: { pending: 1 },
        extraction: { status: 'unavailable' },
      },
    });
    expect(report.health.coverage.reasons).toHaveLength(500);
    expect(receipt.verificationEvidence[0]?.excerpt).toHaveLength(40000);
    expect(result.meta['_budgetEnforcement']).toMatchObject({
      withinBudget: true,
      truncated: false,
    });
  });
  it('focus.show routes through the chokepoint with the FOCUS_TOKEN_CEILING constant', async () => {
    const mw = createBudgetEnforcement();
    // Small payload → within budget, but enforcement meta still stamped.
    const small: DispatchResponse = {
      meta: meta('focus', 'show'),
      success: true,
      data: { identity: { id: 'T1', type: 'task' }, blockers: [], tokensEstimated: 0 },
    };
    const out = await mw(req('focus', 'show'), async () => small);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be).toBeDefined();
    // Ceiling comes from the single named constant — no magic number.
    expect(be['budget']).toBe(FOCUS_TOKEN_CEILING);
    expect(be['budget']).toBe(1500);
    expect(be['withinBudget']).toBe(true);
    expect(be['truncated']).toBe(false);
  });

  it('an OVER-budget focus payload is TRUNCATED (not a weak tokensEstimated>0 pass)', async () => {
    const mw = createBudgetEnforcement();
    const big: DispatchResponse = {
      meta: meta('focus', 'show'),
      success: true,
      data: overBudgetFocusData(),
    };
    const out = await mw(req('focus', 'show'), async () => big);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(FOCUS_TOKEN_CEILING);
    // The enforced outcome is a real reduction, not a no-op: either truncated
    // (preferred — focus uses 'truncate' mode) or, in the pathological case,
    // an E_MVI_BUDGET_EXCEEDED error. Both prove enforcement actually fired.
    if (out.success) {
      expect(be['truncated']).toBe(true);
      expect(be['withinBudget']).toBe(true);
      // After truncation the post-enforcement estimate fits under the ceiling
      // — proving the payload was genuinely reduced (NOT a weak no-op pass).
      expect(be['estimatedTokens'] as number).toBeLessThanOrEqual(FOCUS_TOKEN_CEILING);
      // The truncation indicator is present on the reduced data payload.
      expect(JSON.stringify(out.data)).toContain('_truncated');
    } else {
      expect(out.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    }
  });

  it('briefing.show routes through the chokepoint with the BRIEFING_TOKEN_CEILING constant', async () => {
    const mw = createBudgetEnforcement();
    const small: DispatchResponse = {
      meta: meta('session', 'briefing.show'),
      success: true,
      data: { handoff: null, nextTasks: [] },
    };
    const out = await mw(req('session', 'briefing.show'), async () => small);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(BRIEFING_TOKEN_CEILING);
    expect(be['withinBudget']).toBe(true);
  });

  it('an OVER-budget briefing payload is TRUNCATED through the same path', async () => {
    const mw = createBudgetEnforcement();
    const big: DispatchResponse = {
      meta: meta('session', 'briefing.show'),
      success: true,
      data: {
        handoff: { note: 'n'.repeat(500) },
        nextTasks: Array.from({ length: 200 }, (_, i) => ({
          id: `T${i}`,
          title: 'z'.repeat(200),
        })),
      },
    };
    const out = await mw(req('session', 'briefing.show'), async () => big);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(BRIEFING_TOKEN_CEILING);
    if (out.success) {
      expect(be['truncated']).toBe(true);
      // Post-enforcement the payload fits the briefing ceiling.
      expect(be['estimatedTokens'] as number).toBeLessThanOrEqual(BRIEFING_TOKEN_CEILING);
    } else {
      expect(out.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    }
  });

  it('unpoliced ops are NOT budget-enforced (no enforcement meta)', async () => {
    const mw = createBudgetEnforcement();
    const resp: DispatchResponse = {
      meta: meta('tasks', 'show'),
      success: true,
      data: { id: 'T1', title: 'x'.repeat(50_000) },
    };
    const out = await mw(req('tasks', 'show'), async () => resp);
    expect(out.meta['_budgetEnforcement']).toBeUndefined();
    expect(out.success).toBe(true);
  });
});
