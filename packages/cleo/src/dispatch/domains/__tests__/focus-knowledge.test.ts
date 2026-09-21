/** Code placed in `packages/cleo/` per Package-Boundary Check — verified against AGENTS.md. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core', () => ({ getProjectRoot: () => '/fixture' }));
vi.mock('@cleocode/core/internal', () => ({
  taskShow: vi.fn(async () => ({
    success: true,
    data: { task: { id: 'T123', title: 'Fixture', type: 'task', status: 'pending' } },
  })),
  taskRelates: vi.fn(),
  orchestrateReady: vi.fn(),
  createAttachmentStore: vi.fn(() => ({
    listByOwner: async () => [],
    getExtras: async () => null,
  })),
  memoryFind: vi.fn(async () => ({ success: true, data: { results: [] } })),
  buildAttentionDigest: vi.fn(async () => null),
  sagas: { isSagaType: () => false },
}));
vi.mock('@cleocode/core/doctor/knowledge', () => ({ runKnowledgeDoctor: vi.fn() }));

import { runKnowledgeDoctor } from '@cleocode/core/doctor/knowledge';
import { memoryFind } from '@cleocode/core/internal';
import { createBudgetEnforcement } from '../../middleware/budget-enforcement.js';
import { FocusHandler } from '../focus.js';

beforeEach(() => {
  vi.mocked(runKnowledgeDoctor).mockResolvedValue({
    health: {
      coverage: {
        status: 'missing',
        projectId: 'fixture',
        assessedRevision: null,
        indexedRevision: null,
        assessedAt: '2026-09-18T00:00:00Z',
        reasons: ['No graph'],
        evidence: [],
        limitations: [],
      },
      structure: { status: 'clean', reasons: [], evidence: [] },
      semantics: { status: 'unavailable', reasons: [], evidence: [] },
      extraction: { status: 'unavailable', reasons: [], evidence: [] },
      findings: [],
    },
    stateHash: 'fixture',
    proposals: [],
    receipts: [],
    dryRun: false,
  });
});

describe('focus knowledge assessment', () => {
  it('keeps task identity and stale coverage in the default envelope with many stale reasons', async () => {
    const assessment = await runKnowledgeDoctor('/fixture');
    assessment.health.coverage.status = 'stale';
    assessment.health.coverage.reasons = Array.from(
      { length: 500 },
      (_, index) => `Changed src/file-${index}.ts`,
    );
    vi.mocked(runKnowledgeDoctor).mockResolvedValueOnce(assessment);
    const result = await createBudgetEnforcement()(
      {
        gateway: 'query',
        domain: 'focus',
        operation: 'show',
        params: { id: 'T123' },
        source: 'cli',
        requestId: 'focus-budget-regression',
      },
      () => new FocusHandler().query('show', { id: 'T123' }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      identity: { id: 'T123' },
      coverage: { status: 'stale', reasonCount: 500, detailsCommand: 'cleo doctor knowledge' },
      knowledgeHealth: { findingCount: 0, extraction: { status: 'unavailable' } },
    });
    expect(assessment.health.coverage.reasons).toHaveLength(500);
    expect(result.meta['_budgetEnforcement']).toMatchObject({
      withinBudget: true,
      truncated: false,
    });
  });
  it('retains missing coverage and calls bounded automatic maintenance', async () => {
    const result = await new FocusHandler().query('show', { id: 'T123' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      coverage: { status: 'missing' },
      knowledgeHealth: { coverage: { status: 'missing' } },
    });
    expect(runKnowledgeDoctor).toHaveBeenCalledWith('/fixture', { fix: true, budgetMs: 2000 });
  });

  it('surfaces a failed memory read independently of graph coverage', async () => {
    vi.mocked(memoryFind).mockRejectedValueOnce(new Error('fixture memory unavailable'));
    const result = await new FocusHandler().query('show', { id: 'T123' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sourceDiagnostics: { memory: { status: 'failed' } },
      coverage: { status: 'missing' },
    });
  });
});
