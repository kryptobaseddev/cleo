/**
 * Tests for the task-to-agent classifier — T891.
 *
 * Verifies:
 *  - All 5 default personas resolve correctly from labels and title keywords.
 *  - Low-confidence tasks fall back to cleo-subagent with usedFallback=true.
 *  - Missing-persona tasks also fall back.
 *  - Confidence floor is respected.
 *
 * @task T891 CANT persona wiring
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFY_CONFIDENCE_FLOOR,
  CLASSIFY_FALLBACK_AGENT_ID,
  classifyTask,
} from '../classify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T9000',
    title: 'Default task',
    description: 'A test task.',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    createdAt: '2026-04-17T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persona resolution
// ---------------------------------------------------------------------------

describe('classifyTask — persona resolution', () => {
  it('routes to cleo-prime when labels contain "orchestrate"', () => {
    const task = makeTask({ labels: ['orchestrate', 'spawn'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-prime');
    expect(result.role).toBe('orchestrator');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_CONFIDENCE_FLOOR);
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-prime when title contains "orchestration"', () => {
    const task = makeTask({ title: 'Orchestration pipeline refactor' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-prime');
    expect(result.role).toBe('orchestrator');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-rust-lead when labels contain "rust"', () => {
    const task = makeTask({ labels: ['rust', 'crate'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-rust-lead');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-rust-lead when title mentions "cargo"', () => {
    const task = makeTask({ title: 'Fix cargo build for cant-core crate' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-rust-lead');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-db-lead when labels contain "schema"', () => {
    const task = makeTask({ labels: ['schema', 'migration'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-db-lead');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-db-lead when title mentions "drizzle"', () => {
    const task = makeTask({ title: 'Add drizzle migration for new table' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-db-lead');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-historian when labels contain "adr"', () => {
    const task = makeTask({ labels: ['adr', 'canon'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-historian');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-historian when title mentions "specification"', () => {
    const task = makeTask({ title: 'Write specification for the spawn protocol' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-historian');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-dev when labels contain "implementation"', () => {
    const task = makeTask({ labels: ['implementation', 'feature'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-dev');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to cleo-dev when title contains "implement"', () => {
    const task = makeTask({ title: 'Implement the new task filter UI' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('cleo-dev');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback cases
// ---------------------------------------------------------------------------

describe('classifyTask — fallback', () => {
  it('falls back to cleo-subagent when no signals match', () => {
    const task = makeTask({
      title: 'Zyx qrs wvu',
      description: undefined,
      labels: [],
    });
    const result = classifyTask(task);
    expect(result.agentId).toBe(CLASSIFY_FALLBACK_AGENT_ID);
    expect(result.usedFallback).toBe(true);
    expect(result.confidence).toBeLessThan(CLASSIFY_CONFIDENCE_FLOOR);
    expect(result.warning).toBeDefined();
    expect(result.role).toBe('worker');
  });

  it('includes a warning when falling back', () => {
    const task = makeTask({ title: 'xyzzy', labels: [] });
    const result = classifyTask(task);
    expect(result.warning).toContain('cleo-subagent');
    expect(result.warning).toContain('confidence');
  });

  it('does NOT set usedFallback=true for a clear persona match', () => {
    const task = makeTask({ labels: ['rust', 'cargo', 'crate'] });
    const result = classifyTask(task);
    expect(result.usedFallback).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Confidence floor
// ---------------------------------------------------------------------------

describe('classifyTask — confidence floor', () => {
  it('confidence is ≥ CLASSIFY_CONFIDENCE_FLOOR for all 5 default personas', () => {
    const scenarios: Array<[string, Partial<Task>]> = [
      ['cleo-prime', { labels: ['orchestrate'] }],
      ['cleo-rust-lead', { labels: ['rust'] }],
      ['cleo-db-lead', { labels: ['schema'] }],
      ['cleo-historian', { labels: ['adr'] }],
      ['cleo-dev', { labels: ['implementation'] }],
    ];
    for (const [expectedAgent, overrides] of scenarios) {
      const task = makeTask(overrides);
      const result = classifyTask(task);
      expect(result.agentId, `persona for ${expectedAgent}`).toBe(expectedAgent);
      expect(result.confidence, `confidence for ${expectedAgent}`).toBeGreaterThanOrEqual(
        CLASSIFY_CONFIDENCE_FLOOR,
      );
    }
  });

  it('result always has a non-empty reason', () => {
    const tasks = [makeTask({ labels: ['rust'] }), makeTask({ title: 'xyzzy' })];
    for (const task of tasks) {
      const result = classifyTask(task);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
