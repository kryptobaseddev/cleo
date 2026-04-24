/**
 * Tests for the task-to-agent classifier — T891 / T1258 E1.
 *
 * Verifies:
 *  - All 5 canonical role personas resolve correctly from labels and title keywords.
 *  - Low-confidence tasks fall back to cleo-subagent with usedFallback=true.
 *  - Missing-persona tasks also fall back.
 *  - Confidence floor is respected.
 *
 * Canonical persona IDs (ADR-055 D032 / T1258 E1):
 *  - project-orchestrator (orchestrator role)
 *  - project-dev-lead     (lead role)
 *  - project-code-worker  (worker role)
 *  - project-docs-worker  (worker role)
 *  - project-security-worker (worker role)
 *
 * @task T891 CANT persona wiring
 * @task T1258 E1 canonical naming refactor
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
  it('routes to project-orchestrator when labels contain "orchestrate"', () => {
    const task = makeTask({ labels: ['orchestrate', 'spawn'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-orchestrator');
    expect(result.role).toBe('orchestrator');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFY_CONFIDENCE_FLOOR);
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-orchestrator when title contains "orchestration"', () => {
    const task = makeTask({ title: 'Orchestration pipeline refactor' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-orchestrator');
    expect(result.role).toBe('orchestrator');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-security-worker when labels contain "security"', () => {
    const task = makeTask({ labels: ['security', 'audit'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-security-worker');
    expect(result.role).toBe('worker');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-security-worker when title mentions "vulnerability"', () => {
    const task = makeTask({ title: 'Fix vulnerability in auth endpoint' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-security-worker');
    expect(result.role).toBe('worker');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-docs-worker when labels contain "adr"', () => {
    const task = makeTask({ labels: ['adr', 'canon'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-docs-worker');
    expect(result.role).toBe('worker');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-docs-worker when title mentions "specification"', () => {
    const task = makeTask({ title: 'Write specification for the spawn protocol' });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-docs-worker');
    expect(result.role).toBe('worker');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-dev-lead when labels contain "implementation"', () => {
    const task = makeTask({ labels: ['implementation', 'feature'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-dev-lead');
    expect(result.role).toBe('lead');
    expect(result.usedFallback).toBe(false);
  });

  it('routes to project-dev-lead when labels contain "refactor"', () => {
    const task = makeTask({ labels: ['refactor', 'feature'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-dev-lead');
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
    const task = makeTask({ labels: ['security', 'audit', 'vulnerability'] });
    const result = classifyTask(task);
    expect(result.usedFallback).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Confidence floor
// ---------------------------------------------------------------------------

describe('classifyTask — confidence floor', () => {
  it('confidence is >= CLASSIFY_CONFIDENCE_FLOOR for all 5 canonical personas', () => {
    const scenarios: Array<[string, Partial<Task>]> = [
      ['project-orchestrator', { labels: ['orchestrate'] }],
      ['project-security-worker', { labels: ['security'] }],
      ['project-docs-worker', { labels: ['adr'] }],
      // dev-lead: use explicit label match (avoids size=small code-worker boost tie)
      ['project-dev-lead', { labels: ['project-dev-lead'] }],
      ['project-code-worker', { labels: ['project-code-worker'] }],
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
    const tasks = [makeTask({ labels: ['security'] }), makeTask({ title: 'xyzzy' })];
    for (const task of tasks) {
      const result = classifyTask(task);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
