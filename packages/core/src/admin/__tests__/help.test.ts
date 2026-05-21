/**
 * Unit tests for admin/help.ts — progressive-disclosure help computation.
 *
 * Covers:
 *   (a) TIER_0_QUICKSTART includes tasks.add-batch leverage callout
 *   (b) tasks.add-batch at tier=0 appears under tasks.mutate in grouped output
 *   (c) Regression: existing Tier 0 ops (current, next, find, start, complete) still listed
 *   (d) Tier 1 / Tier 2 ops are excluded from Tier 0 output
 *   (e) Verbose mode includes tasks.add-batch with correct gateway/domain
 *
 * @task T9817
 * @epic T9813
 */

import { describe, expect, it } from 'vitest';
import {
  buildVerboseOperations,
  computeHelp,
  getCostHint,
  groupOperationsByDomain,
  type HelpOperationDef,
} from '../help.js';

// ---------------------------------------------------------------------------
// Shared fixture — a representative operation registry including add-batch
// ---------------------------------------------------------------------------

const FIXTURE_OPERATIONS: HelpOperationDef[] = [
  // Tier 0 — tasks query
  { gateway: 'query', domain: 'tasks', operation: 'current', description: 'Current task', tier: 0 },
  { gateway: 'query', domain: 'tasks', operation: 'next', description: 'Next task', tier: 0 },
  { gateway: 'query', domain: 'tasks', operation: 'find', description: 'Find tasks', tier: 0 },
  // Tier 0 — tasks mutate (includes add-batch)
  { gateway: 'mutate', domain: 'tasks', operation: 'add', description: 'Add task', tier: 0 },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'add-batch',
    description:
      'tasks.add-batch (mutate) — bulk-create N tasks atomically in a single transaction (epic decomposition: 1 call instead of N)',
    tier: 0,
  },
  { gateway: 'mutate', domain: 'tasks', operation: 'start', description: 'Start task', tier: 0 },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'complete',
    description: 'Complete task',
    tier: 0,
  },
  // Tier 0 — admin
  { gateway: 'query', domain: 'admin', operation: 'help', description: 'Help', tier: 0 },
  // Tier 1 — memory
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'find',
    description: 'Search memory',
    tier: 1,
  },
  // Tier 2 — orchestrate
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'status',
    description: 'Orch status',
    tier: 2,
  },
];

// ---------------------------------------------------------------------------
// (a) TIER_0_QUICKSTART — add-batch leverage callout is present
// ---------------------------------------------------------------------------

describe('computeHelp — Tier 0 quickStart', () => {
  it('(a) includes tasks.add-batch with epic-decomposition callout', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);

    expect(result.quickStart).toBeDefined();
    const qs = result.quickStart as string[];

    const addBatchEntry = qs.find((s) => s.includes('tasks.add-batch'));
    expect(addBatchEntry).toBeDefined();
    expect(addBatchEntry).toContain('epic decomposition: 1 call instead of N');
  });

  it('(c) regression — existing Tier 0 ops are still listed in quickStart', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);
    const qs = result.quickStart as string[];

    expect(qs.some((s) => s.includes('tasks.current'))).toBe(true);
    expect(qs.some((s) => s.includes('tasks.next'))).toBe(true);
    expect(qs.some((s) => s.includes('tasks.find'))).toBe(true);
    expect(qs.some((s) => s.includes('tasks.start'))).toBe(true);
    expect(qs.some((s) => s.includes('tasks.complete'))).toBe(true);
  });

  it('add-batch entry appears AFTER tasks.find and BEFORE tasks.start in quickStart', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);
    const qs = result.quickStart as string[];

    const idxFind = qs.findIndex((s) => s.includes('tasks.find'));
    const idxAddBatch = qs.findIndex((s) => s.includes('tasks.add-batch'));
    const idxStart = qs.findIndex((s) => s.includes('tasks.start'));

    expect(idxFind).toBeGreaterThanOrEqual(0);
    expect(idxAddBatch).toBeGreaterThan(idxFind);
    expect(idxStart).toBeGreaterThan(idxAddBatch);
  });

  it('quickStart is undefined at Tier 1', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 1, false);
    expect(result.quickStart).toBeUndefined();
  });

  it('quickStart is undefined at Tier 2', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 2, false);
    expect(result.quickStart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) tasks.add-batch at tier=0 appears under tasks.mutate in grouped output
// ---------------------------------------------------------------------------

describe('computeHelp — Tier 0 grouped operations', () => {
  it('(b) tasks.add-batch appears under tasks.mutate at Tier 0', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);

    const ops = result.operations as Record<string, { query: string[]; mutate: string[] }>;
    expect(Array.isArray(ops)).toBe(false);
    expect(ops['tasks']).toBeDefined();
    expect(ops['tasks']!.mutate).toContain('add-batch');
  });

  it('tasks.add-batch is NOT present when only tier >= 1 ops are passed', () => {
    // Only include tier 1+ ops — add-batch (tier=0) should NOT appear if not passed
    const tier1Only = FIXTURE_OPERATIONS.filter((op) => op.tier >= 1);
    const result = computeHelp(tier1Only, 1, false);

    const ops = result.operations as Record<string, { query: string[]; mutate: string[] }>;
    // tasks domain may not appear at all, or if it does, mutate should be empty/missing add-batch
    const tasksMutate = ops['tasks']?.mutate ?? [];
    expect(tasksMutate).not.toContain('add-batch');
  });

  it('(d) Tier 1 op (memory.find) is excluded from Tier 0 output', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);
    const ops = result.operations as Record<string, { query: string[]; mutate: string[] }>;

    expect(ops['memory']).toBeUndefined();
  });

  it('(d) Tier 2 op (orchestrate.status) is excluded from Tier 0 output', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, false);
    const ops = result.operations as Record<string, { query: string[]; mutate: string[] }>;

    expect(ops['orchestrate']).toBeUndefined();
  });

  it('(d) Tier 1 and Tier 2 ops appear when requesting tier >= 1', () => {
    const result1 = computeHelp(FIXTURE_OPERATIONS, 1, false);
    const ops1 = result1.operations as Record<string, { query: string[]; mutate: string[] }>;
    expect(ops1['memory']?.query).toContain('find');
    expect(ops1['orchestrate']).toBeUndefined(); // tier 2 excluded from tier 1

    const result2 = computeHelp(FIXTURE_OPERATIONS, 2, false);
    const ops2 = result2.operations as Record<string, { query: string[]; mutate: string[] }>;
    expect(ops2['orchestrate']?.query).toContain('status');
  });
});

// ---------------------------------------------------------------------------
// (e) Verbose mode — tasks.add-batch has correct gateway/domain/description
// ---------------------------------------------------------------------------

describe('computeHelp — verbose mode', () => {
  it('(e) verbose Tier 0 includes tasks.add-batch with gateway=mutate and domain=tasks', () => {
    const result = computeHelp(FIXTURE_OPERATIONS, 0, true);

    const ops = result.operations as Array<{
      gateway: string;
      domain: string;
      operation: string;
      description: string;
      costHint: string;
    }>;
    expect(Array.isArray(ops)).toBe(true);

    const addBatch = ops.find((o) => o.domain === 'tasks' && o.operation === 'add-batch');
    expect(addBatch).toBeDefined();
    expect(addBatch!.gateway).toBe('mutate');
    expect(addBatch!.description).toContain('epic decomposition: 1 call instead of N');
  });
});

// ---------------------------------------------------------------------------
// groupOperationsByDomain — unit coverage
// ---------------------------------------------------------------------------

describe('groupOperationsByDomain', () => {
  it('groups add-batch under tasks.mutate', () => {
    const ops = FIXTURE_OPERATIONS.filter((o) => o.tier === 0);
    const grouped = groupOperationsByDomain(ops);

    expect(grouped['tasks']!.mutate).toContain('add-batch');
    expect(grouped['tasks']!.mutate).toContain('add');
    expect(grouped['tasks']!.query).toContain('find');
  });
});

// ---------------------------------------------------------------------------
// buildVerboseOperations — unit coverage
// ---------------------------------------------------------------------------

describe('buildVerboseOperations', () => {
  it('includes add-batch with a costHint', () => {
    const ops = FIXTURE_OPERATIONS.filter((o) => o.tier === 0);
    const verbose = buildVerboseOperations(ops);

    const entry = verbose.find((o) => o.operation === 'add-batch');
    expect(entry).toBeDefined();
    expect(['minimal', 'moderate', 'heavy']).toContain(entry!.costHint);
  });
});

// ---------------------------------------------------------------------------
// getCostHint — spot checks
// ---------------------------------------------------------------------------

describe('getCostHint', () => {
  it('returns minimal for tasks.add-batch (not in HEAVY or MODERATE sets)', () => {
    expect(getCostHint('tasks', 'add-batch')).toBe('minimal');
  });

  it('returns heavy for tasks.list', () => {
    expect(getCostHint('tasks', 'list')).toBe('heavy');
  });

  it('returns moderate for tasks.show', () => {
    expect(getCostHint('tasks', 'show')).toBe('moderate');
  });
});
