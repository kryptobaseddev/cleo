/** Code placed in `packages/cleo/` per Package-Boundary Check — verified against AGENTS.md. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/project-scope', () => ({ getProjectRoot: () => '/fixture' }));
vi.mock('@cleocode/core/tasks/show', () => ({
  taskShow: vi.fn(async () => ({
    success: true,
    data: { task: { id: 'T123', title: 'Fixture', type: 'task', status: 'pending' } },
  })),
}));
vi.mock('@cleocode/core/tasks/engine-wrap', () => ({ taskRelates: vi.fn() }));
vi.mock('@cleocode/core/orchestrate/query-ops', () => ({ orchestrateReady: vi.fn() }));
vi.mock('@cleocode/core/store/attachment-store', () => ({
  createAttachmentStore: vi.fn(() => ({
    listByOwner: async () => [],
    getExtras: async () => null,
  })),
}));
vi.mock('@cleocode/core/memory/engine-compat', () => ({
  memoryFind: vi.fn(async () => ({ success: true, data: { results: [] } })),
}));
vi.mock('@cleocode/core/memory/attention', () => ({
  buildAttentionDigest: vi.fn(async () => null),
}));
vi.mock('@cleocode/core/sagas/is-saga-type', () => ({ isSagaType: () => false }));
vi.mock('@cleocode/core/doctor/knowledge', () => ({ runKnowledgeDoctor: vi.fn() }));

import { runKnowledgeDoctor } from '@cleocode/core/doctor/knowledge';
import { memoryFind } from '@cleocode/core/memory/engine-compat';
import { orchestrateReady } from '@cleocode/core/orchestrate/query-ops';
import { taskShow } from '@cleocode/core/tasks/show';
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
      knowledgeHealth: { coverageRef: '/coverage' },
    });
    expect(runKnowledgeDoctor).toHaveBeenCalledWith('/fixture', { fix: true, budgetMs: 2000 });
  });

  it('emits the coverage object once and references it from knowledgeHealth (T12522)', async () => {
    const result = await new FocusHandler().query('show', { id: 'T123' });
    const data = result.data as Record<string, Record<string, unknown>>;
    // Coverage-disclosure rule: coverage is present in the envelope...
    expect(data['coverage']).toMatchObject({ status: 'missing', reasonCount: 1 });
    // ...exactly once: knowledgeHealth points at it instead of repeating it.
    expect(data['knowledgeHealth']).not.toHaveProperty('coverage');
    const ref = data['knowledgeHealth']?.['coverageRef'];
    expect(ref).toBe('/coverage');
    // A top-level pointer: its one segment names the envelope key holding coverage.
    expect(data[String(ref).slice(1)]).toBe(data['coverage']);
    expect(JSON.stringify(data).match(/"assessedAt"/g)).toHaveLength(1);
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
  it('names the underlying error of a failed memory read and ready wave (T12590)', async () => {
    const failure = {
      success: false as const,
      error: {
        code: 'E_BRAIN_SEARCH',
        message: 'BRAIN database unavailable while checking retrieval eligibility',
      },
    };
    vi.mocked(memoryFind).mockResolvedValueOnce(failure).mockResolvedValueOnce(failure);
    vi.mocked(taskShow).mockResolvedValueOnce({
      success: true,
      data: {
        task: { id: 'T123', title: 'Fixture', type: 'task', status: 'pending', parentId: 'T100' },
      },
    } as Awaited<ReturnType<typeof taskShow>>);
    vi.mocked(orchestrateReady).mockResolvedValueOnce({
      success: false,
      error: { code: 'E_GENERAL', message: 'database is not open', fix: 'retry' },
    });
    const result = await new FocusHandler().query('show', { id: 'T123' });
    expect(result.success).toBe(true);
    const diagnostics = (
      result.data as { sourceDiagnostics: Record<string, { reasons: string[] }> }
    ).sourceDiagnostics;
    expect(diagnostics['memory']?.reasons).toEqual([
      'One or more scoped memory retrievals failed.',
      'observations: E_BRAIN_SEARCH: BRAIN database unavailable while checking retrieval eligibility',
      'decisions: E_BRAIN_SEARCH: BRAIN database unavailable while checking retrieval eligibility',
    ]);
    expect(diagnostics['ready']?.reasons).toEqual([
      'Ready-wave assessment failed.',
      'E_GENERAL: database is not open (fix: retry)',
    ]);
  });

  it('renders the ready wave in orchestrate.ready order — THE comparator, not a re-sort (T12692)', async () => {
    vi.mocked(taskShow).mockResolvedValueOnce({
      success: true,
      data: {
        task: { id: 'T123', title: 'Fixture', type: 'task', status: 'pending', parentId: 'T100' },
      },
    } as Awaited<ReturnType<typeof taskShow>>);
    // orchestrate.ready already returns THE comparator's order (D11161); the
    // focus envelope renders it verbatim — ids deliberately not in id order.
    const ranked = ['T3', 'T1', 'T2'].map((id, index) => ({
      id,
      title: id,
      priority: ['critical', 'high', 'low'][index] ?? 'low',
      depends: [],
    }));
    vi.mocked(orchestrateReady).mockResolvedValueOnce({
      success: true,
      data: { readyTasks: ranked },
    });
    const result = await new FocusHandler().query('show', { id: 'T123' });
    expect(result.success).toBe(true);
    expect(
      (result.data as { readyWave?: Array<{ id: string }> }).readyWave?.map((t) => t.id),
    ).toEqual(['T3', 'T1', 'T2']);
  });
});
