/**
 * PSYCHE-MEMORY budget (T12519): noise exclusion, relevance ranking, token cap.
 *
 * Fixtures reproduce the entry shapes measured in the live stores on
 * 2026-09-27. The receipt texts and the dispatch-trace serialization are
 * copied verbatim from real rows.
 *
 * @task T12519
 */

import type { RetrievalBundle, Task, UserProfileTrait } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildTraceText } from '../../memory/dispatch-trace-format.js';
import { estimateTokens } from '../../metrics/token-estimation.js';
import {
  buildBudgetedPsycheMemoryBlock,
  isOperationReceiptText,
  PSYCHE_MEMORY_TOKEN_BUDGET,
  relevanceContextFromTask,
} from '../psyche-memory-budget.js';
import { buildSpawnPrompt } from '../spawn-prompt.js';

function trait(traitKey: string, traitValue: string, confidence = 0.95): UserProfileTrait {
  return {
    traitKey,
    traitValue,
    confidence,
    source: 'dialectic:ses_test',
    derivedFromMessageId: null,
    firstObservedAt: '2026-09-01T00:00:00Z',
    lastReinforcedAt: '2026-09-01T00:00:00Z',
    reinforcementCount: 1,
    supersededBy: null,
  };
}

function emptyBundle(): RetrievalBundle {
  return {
    cold: { userProfile: [], peerInstructions: '', sigilCard: null },
    warm: { peerLearnings: [], peerPatterns: [], decisions: [] },
    hot: { sessionNarrative: '', recentObservations: [], activeTasks: [] },
    tokenCounts: { cold: 0, warm: 0, hot: 0, total: 0 },
  };
}

const TASK: Task = {
  id: 'T9001',
  title: 'Budget the PSYCHE block',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  parentId: 'T9000',
  labels: ['token-economy'],
  files: ['packages/core/src/orchestration/spawn-prompt.ts'],
  createdAt: '2026-09-27T00:00:00Z',
} as Task;

const RECEIPTS = [
  'Cleo tasks update operation succeeded',
  "Operation succeeded in domain 'check'",
  'Operation succeeded for taskId T382.',
  "cleo successfully executed operation 'set' on the qaPassed gate for T410 taskId in domain 'check'",
  "Gate 'qaPassed' set to true for task T12240 with evidence pr:1470.",
  "Gate status set to 'implemented' for T1742",
  'cleo set implemented gate for T776',
  'Passed test gates for T388',
  'set taskId in gate successfully',
  "Cleo operation succeeded for task T248 in the 'check' domain.",
];

describe('isOperationReceiptText', () => {
  it('flags every measured receipt shape and serialized dispatch traces', () => {
    for (const text of RECEIPTS) expect(isOperationReceiptText(text), text).toBe(true);
    const trace = buildTraceText({
      taskId: '',
      predictedAgentId: 'project-code-worker',
      confidence: 0,
      reason: "resolved at tier 'project'",
      registryHit: true,
      fallbackUsed: false,
      resolvedAt: '2026-09-28T03:09:46.419Z',
    });
    expect(isOperationReceiptText(trace)).toBe(true);
  });

  it('keeps real knowledge, including text that merely mentions success or gates', () => {
    for (const text of [
      'User is concise and makes direct instructions.',
      'read file set once (in beforeAll) may not be enough',
      'Classify nexus index freshness on the MEDIAN indexed_at, not the MAX',
      'A successful merge does not prove the release shipped.',
      'Every gate must prove the remedy passes, not just that the violation fails.',
    ]) {
      expect(isOperationReceiptText(text), text).toBe(false);
    }
  });
});

describe('buildBudgetedPsycheMemoryBlock', () => {
  it('excludes noise entries from every section', () => {
    const bundle = emptyBundle();
    bundle.cold.userProfile = RECEIPTS.map((r, i) => trait(`receipt-${i}`, r));
    bundle.cold.userProfile.push(trait('clear-and-assertive', 'User is concise.'));
    bundle.warm.peerPatterns = [
      {
        id: 'P-trace',
        pattern: buildTraceText({
          taskId: 'T1',
          predictedAgentId: 'cleo-subagent',
          confidence: 0,
          reason: 'fallback',
          registryHit: false,
          fallbackUsed: true,
          resolvedAt: '2026-09-27T00:00:00Z',
        }),
        extractedAt: '2026-09-27T00:00:00Z',
      },
    ];
    bundle.hot.recentObservations = [
      {
        id: 'O-1',
        title: 'Cleo tasks update operation succeeded',
        narrative: '',
        createdAt: '2026-09-27T00:00:00Z',
      },
    ];

    const result = buildBudgetedPsycheMemoryBlock({
      bundle,
      relevance: relevanceContextFromTask(TASK),
    });

    expect(result.excludedNoise).toBe(RECEIPTS.length + 2);
    expect(result.block).toContain('clear-and-assertive');
    for (const r of RECEIPTS) expect(result.block).not.toContain(r);
    expect(result.block).not.toContain('Dispatch trace');
    expect(result.block).not.toContain('### Patterns');
    expect(result.block).not.toContain('### Recent Observations');
  });

  it('enforces the token budget with whole entries and a find pointer', () => {
    const bundle = emptyBundle();
    // ~400 genuine traits — the measured cold-pass size — each ~30 tokens.
    bundle.cold.userProfile = Array.from({ length: 400 }, (_, i) =>
      trait(`trait-${i}`, `durable preference number ${i} `.repeat(4).trim()),
    );
    bundle.warm.decisions = Array.from({ length: 10 }, (_, i) => ({
      id: `D${i}`,
      decision: `Decision ${i}: ${'x'.repeat(300)}`,
      createdAt: '2026-09-27T00:00:00Z',
    }));

    const result = buildBudgetedPsycheMemoryBlock({
      bundle,
      relevance: relevanceContextFromTask(TASK),
    });

    expect(estimateTokens(result.block)).toBeLessThanOrEqual(PSYCHE_MEMORY_TOKEN_BUDGET);
    expect(result.tokens).toBeLessThanOrEqual(PSYCHE_MEMORY_TOKEN_BUDGET);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.shown + result.omitted).toBe(410);
    expect(result.block).toContain(`> ${result.omitted} more via \`cleo memory find "T9001"\``);
    // Whole entries only: every rendered trait line is complete.
    for (const line of result.block.split('\n').filter((l) => l.startsWith('- **trait-'))) {
      expect(line).toMatch(/^- \*\*trait-\d+\*\*: (durable preference number \d+ ?){4}$/);
    }

    // A smaller explicit budget is honoured too.
    const small = buildBudgetedPsycheMemoryBlock({
      bundle,
      relevance: relevanceContextFromTask(TASK),
      tokenBudget: 200,
    });
    expect(small.tokens).toBeLessThanOrEqual(200);
  });

  it('keeps task-relevant entries first, then orders by quality and citations', () => {
    const bundle = emptyBundle();
    bundle.warm.decisions = [
      { id: 'D-hiq', decision: 'Unrelated high quality', createdAt: 'x', qualityScore: 0.99 },
      { id: 'D-epic', decision: 'Scoped to the epic', createdAt: 'x', contextEpicId: 'T9000' },
      { id: 'D-task', decision: 'Linked by column', createdAt: 'x', contextTaskId: 'T9001' },
      { id: 'D-low', decision: 'Unrelated low quality', createdAt: 'x', qualityScore: 0.1 },
    ];
    bundle.warm.peerLearnings = [
      {
        id: 'L-cited',
        insight: 'Unrelated but cited',
        createdAt: 'x',
        qualityScore: 0.5,
        citationCount: 9,
      },
      {
        id: 'L-file',
        insight: 'spawn-prompt.ts assembles sections in a fixed order',
        createdAt: 'x',
      },
      { id: 'L-label', insight: 'token-economy work must measure first', createdAt: 'x' },
      { id: 'L-T90011', insight: 'Mentions T90011 which is NOT the task', createdAt: 'x' },
      { id: 'L-plain', insight: 'Unrelated plain', createdAt: 'x', qualityScore: 0.5 },
    ];

    const { block } = buildBudgetedPsycheMemoryBlock({
      bundle,
      relevance: relevanceContextFromTask(TASK),
    });
    const pos = (id: string): number => block.indexOf(`[${id}]`);

    expect(pos('D-task')).toBeLessThan(pos('D-epic'));
    expect(pos('D-epic')).toBeLessThan(pos('D-hiq'));
    expect(pos('D-hiq')).toBeLessThan(pos('D-low'));
    expect(pos('L-file')).toBeLessThan(pos('L-label'));
    expect(pos('L-label')).toBeLessThan(pos('L-cited'));
    expect(pos('L-cited')).toBeLessThan(pos('L-plain'));
    // Id matching is whole-token: T90011 is not an overlap with T9001, so it
    // keeps its bundle position (ahead of L-plain) instead of jumping the queue.
    expect(pos('L-T90011')).toBeGreaterThan(pos('L-cited'));
    expect(pos('L-T90011')).toBeLessThan(pos('L-plain'));

    // Under a tight budget, the relevant entries survive and the rest are omitted.
    const tight = buildBudgetedPsycheMemoryBlock({
      bundle,
      relevance: relevanceContextFromTask(TASK),
      tokenBudget: 90,
    });
    expect(tight.block).toContain('[D-task]');
    expect(tight.block).not.toContain('[D-low]');
    expect(tight.omitted).toBeGreaterThan(0);
  });

  it('is what buildSpawnPrompt renders for a tier-1 prompt', () => {
    const bundle = emptyBundle();
    bundle.cold.userProfile = [
      ...RECEIPTS.map((r, i) => trait(`receipt-${i}`, r)),
      ...Array.from({ length: 300 }, (_, i) => trait(`t-${i}`, `value ${i} `.repeat(10))),
    ];
    const result = buildSpawnPrompt({
      task: TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: process.cwd(),
      retrievalBundle: bundle,
    });
    const start = result.prompt.indexOf('## PSYCHE-MEMORY');
    const end = result.prompt.indexOf('\n## ', start + 1);
    const block = result.prompt.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(estimateTokens(block)).toBeLessThanOrEqual(PSYCHE_MEMORY_TOKEN_BUDGET);
    expect(block).not.toContain('operation succeeded');
    expect(block).toContain('more via `cleo memory find "T9001"`');
  });
});
