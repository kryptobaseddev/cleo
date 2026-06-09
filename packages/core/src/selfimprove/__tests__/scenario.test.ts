/**
 * Unit tests for self-improvement scenario + golden loading/validation (T11889-B).
 *
 * PURE — no DB. Exercises the bundled canned `dhq-replay-find` fixture plus the
 * Zod-validation and invariant-enforcement paths of {@link loadScenario}.
 *
 * @epic T11889
 * @task T11912
 */

import { describe, expect, it, vi } from 'vitest';
import { GoldenSchema, loadScenario, ScenarioLoadError, ScenarioSchema } from '../scenario.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('scenario schema validation', () => {
  it('accepts a well-formed query-only scenario', () => {
    const parsed = ScenarioSchema.safeParse({
      name: 'x',
      description: 'd',
      ops: [{ gateway: 'query', domain: 'tasks', operation: 'find' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty ops array', () => {
    const parsed = ScenarioSchema.safeParse({ name: 'x', description: 'd', ops: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown gateway', () => {
    const parsed = ScenarioSchema.safeParse({
      name: 'x',
      description: 'd',
      ops: [{ gateway: 'delete', domain: 'tasks', operation: 'find' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const parsed = ScenarioSchema.safeParse({
      name: 'x',
      description: 'd',
      ops: [{ gateway: 'query', domain: 'tasks', operation: 'find' }],
      extra: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('validates a golden envelope set', () => {
    const parsed = GoldenSchema.safeParse({
      name: 'x',
      envelopes: [{ success: true, data: {} }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('loadScenario — canned fixture', () => {
  it('loads and validates the dhq-replay-find scenario + golden', async () => {
    const { scenario, golden } = await loadScenario('dhq-replay-find');
    expect(scenario.name).toBe('dhq-replay-find');
    expect(scenario.ops.length).toBeGreaterThan(0);
    expect(golden.name).toBe('dhq-replay-find');
    // Invariant: one golden envelope per op.
    expect(golden.envelopes.length).toBe(scenario.ops.length);
    // The canned scenario is query-only (read-only replay guarantee).
    for (const op of scenario.ops) {
      expect(op.gateway).toBe('query');
    }
  });
});

describe('loadScenario — error paths', () => {
  it('rejects a path-traversal name before touching the filesystem', async () => {
    await expect(loadScenario('../../etc')).rejects.toBeInstanceOf(ScenarioLoadError);
  });

  it('rejects an unknown scenario name with a typed error', async () => {
    await expect(loadScenario('does-not-exist')).rejects.toMatchObject({
      code: 'E_SELFIMPROVE_SCENARIO_INVALID',
    });
  });
});
