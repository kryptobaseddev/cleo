/**
 * Tests for the task-to-agent classifier — T891 / T1258 E1 / T1326 / T1936.
 *
 * Verifies:
 *  - All 5 canonical role personas resolve correctly from labels and title keywords.
 *  - Low-confidence tasks fall back to cleo-subagent with usedFallback=true.
 *  - Missing-persona tasks also fall back.
 *  - Confidence floor is respected.
 *  - Registry validation: classifier throws E_CLASSIFIER_UNREGISTERED_AGENT when
 *    the resolved agent ID is absent from the allowed vocabulary (T1326).
 *  - getRegisteredAgentIds() returns the full built-in vocabulary (no DB).
 *  - getRegisteredAgentIds(db) queries the live registry (T1936).
 *  - validateClassifierRules() passes with full registry and throws on drift (T1936).
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
 * @task T1326 classifier↔registry contract
 * @task T1936 live-registry source for getRegisteredAgentIds + startup validation
 */

import { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { ClassifierUnregisteredAgentError } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  CLASSIFY_CONFIDENCE_FLOOR,
  CLASSIFY_FALLBACK_AGENT_ID,
  classifyTask,
  getRegisteredAgentIds,
  validateClassifierRules,
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

// ---------------------------------------------------------------------------
// Registry vocabulary — getRegisteredAgentIds()
// ---------------------------------------------------------------------------

describe('getRegisteredAgentIds', () => {
  it('returns an array of unique string IDs', () => {
    const ids = getRegisteredAgentIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    // All entries are non-empty strings
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes all 5 canonical personas and the fallback', () => {
    const ids = getRegisteredAgentIds();
    const expected = [
      'project-orchestrator',
      'project-security-worker',
      'project-docs-worker',
      'project-dev-lead',
      'project-code-worker',
      CLASSIFY_FALLBACK_AGENT_ID,
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('does NOT include unregistered IDs such as stale legacy names', () => {
    const ids = getRegisteredAgentIds();
    // These were the broken vocabulary entries that Council 2026-04-24 identified.
    // They must NOT appear in the built-in vocabulary because they are not in
    // CLASSIFIER_RULES (the source of truth for getRegisteredAgentIds).
    // Note: 'project-dev-lead' and 'project-docs-worker' ARE in the vocabulary
    // (they are canonical), so we test a truly non-existent ID instead.
    expect(ids).not.toContain('some-unknown-agent-not-in-rules');
  });
});

// ---------------------------------------------------------------------------
// Registry validation — E_CLASSIFIER_UNREGISTERED_AGENT (T1326)
// ---------------------------------------------------------------------------

describe('classifyTask — registry validation', () => {
  it('succeeds when the resolved agent is in the default built-in vocabulary', () => {
    // project-orchestrator is in CLASSIFIER_RULES → getRegisteredAgentIds()
    const task = makeTask({ labels: ['orchestrate'] });
    const result = classifyTask(task);
    expect(result.agentId).toBe('project-orchestrator');
    expect(result.usedFallback).toBe(false);
  });

  it('succeeds when opts.allowedAgentIds explicitly includes the resolved agent', () => {
    const task = makeTask({ labels: ['orchestrate'] });
    const result = classifyTask(task, {
      allowedAgentIds: ['project-orchestrator', 'cleo-subagent'],
    });
    expect(result.agentId).toBe('project-orchestrator');
  });

  it('throws ClassifierUnregisteredAgentError when resolved agent is absent from allowedAgentIds', () => {
    // A task that resolves to 'project-orchestrator' with a narrow allowed list
    // that does NOT include it — simulating a registry that only knows code workers.
    const task = makeTask({ labels: ['orchestrate'] });
    const restrictedIds = ['project-code-worker', 'cleo-subagent'];
    expect(() => classifyTask(task, { allowedAgentIds: restrictedIds })).toThrow(
      ClassifierUnregisteredAgentError,
    );
  });

  it('error code is E_CLASSIFIER_UNREGISTERED_AGENT', () => {
    const task = makeTask({ labels: ['orchestrate'] });
    const restrictedIds = ['project-code-worker', 'cleo-subagent'];
    let thrown: ClassifierUnregisteredAgentError | null = null;
    try {
      classifyTask(task, { allowedAgentIds: restrictedIds });
    } catch (err) {
      if (err instanceof ClassifierUnregisteredAgentError) {
        thrown = err;
      }
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('E_CLASSIFIER_UNREGISTERED_AGENT');
    expect(thrown!.emittedAgentId).toBe('project-orchestrator');
    expect(thrown!.registeredIds).toEqual(restrictedIds);
  });

  it('error message includes a fix-hint listing valid agent IDs', () => {
    const task = makeTask({ labels: ['orchestrate'] });
    const restrictedIds = ['project-code-worker', 'cleo-subagent'];
    let msg = '';
    try {
      classifyTask(task, { allowedAgentIds: restrictedIds });
    } catch (err) {
      if (err instanceof Error) msg = err.message;
    }
    expect(msg).toContain('project-orchestrator');
    expect(msg).toContain('project-code-worker');
    expect(msg).toContain('cleo-subagent');
    expect(msg).toContain('E_CLASSIFIER_UNREGISTERED_AGENT');
  });

  it('succeeds for fallback path when cleo-subagent is in allowedAgentIds', () => {
    // A low-signal task will fall back to cleo-subagent
    const task = makeTask({ title: 'xyzzy no keywords', labels: [] });
    const result = classifyTask(task, { allowedAgentIds: ['cleo-subagent'] });
    expect(result.agentId).toBe(CLASSIFY_FALLBACK_AGENT_ID);
    expect(result.usedFallback).toBe(true);
  });

  it('throws when fallback cleo-subagent is absent from allowedAgentIds', () => {
    // A low-signal task falls back, but cleo-subagent is not allowed
    const task = makeTask({ title: 'xyzzy no keywords', labels: [] });
    expect(() => classifyTask(task, { allowedAgentIds: ['project-orchestrator'] })).toThrow(
      ClassifierUnregisteredAgentError,
    );
  });

  it('all built-in vocabulary members dispatch cleanly (no throws) with default options', () => {
    // Use the label-exact form for each persona to guarantee routing
    const scenarios: Array<[string, Partial<Task>]> = [
      ['project-orchestrator', { labels: ['project-orchestrator'] }],
      ['project-security-worker', { labels: ['project-security-worker'] }],
      ['project-docs-worker', { labels: ['project-docs-worker'] }],
      ['project-dev-lead', { labels: ['project-dev-lead'] }],
      ['project-code-worker', { labels: ['project-code-worker'] }],
    ];
    for (const [expectedId, overrides] of scenarios) {
      const task = makeTask(overrides);
      // Must not throw
      const result = classifyTask(task);
      expect(result.agentId, `routing for ${expectedId}`).toBe(expectedId);
    }
  });
});

// ---------------------------------------------------------------------------
// getRegisteredAgentIds with live DB — T1936
// ---------------------------------------------------------------------------

/**
 * Build a minimal in-memory signaldock.db with only the `agents` table
 * and the `tier` column so getRegisteredAgentIds(db) can query it.
 *
 * Uses `:memory:` to avoid any filesystem side-effects.
 */
function makeInMemoryAgentsDb(agentRows: Array<{ agent_id: string; tier: string }>): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'fallback'
    )
  `);
  const insert = db.prepare('INSERT INTO agents (id, agent_id, tier) VALUES (?, ?, ?)');
  for (const row of agentRows) {
    insert.run(crypto.randomUUID(), row.agent_id, row.tier);
  }
  return db;
}

describe('getRegisteredAgentIds — live DB (T1936)', () => {
  it('returns IDs from the live agents table when DB has project-tier agents', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'project-dev-lead', tier: 'project' },
      { agent_id: 'project-code-worker', tier: 'project' },
      { agent_id: 'project-docs-worker', tier: 'project' },
      { agent_id: 'project-security-worker', tier: 'project' },
    ]);
    try {
      const ids = getRegisteredAgentIds(db);
      expect(ids).toContain('project-orchestrator');
      expect(ids).toContain('project-dev-lead');
      expect(ids).toContain('project-code-worker');
      expect(ids).toContain('project-docs-worker');
      expect(ids).toContain('project-security-worker');
      // Fallback is always appended
      expect(ids).toContain(CLASSIFY_FALLBACK_AGENT_ID);
    } finally {
      db.close();
    }
  });

  it('includes a custom extra agent registered in the DB alongside the 5 canonical ones', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'project-dev-lead', tier: 'project' },
      { agent_id: 'project-code-worker', tier: 'project' },
      { agent_id: 'project-docs-worker', tier: 'project' },
      { agent_id: 'project-security-worker', tier: 'project' },
      { agent_id: 'project-rust-lead', tier: 'global' },
    ]);
    try {
      const ids = getRegisteredAgentIds(db);
      expect(ids).toContain('project-rust-lead');
      // All canonical ones still present
      expect(ids).toContain('project-orchestrator');
      // No duplicates
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      db.close();
    }
  });

  it('excludes agents with tier=fallback from the DB query result', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'some-fallback-agent', tier: 'fallback' },
    ]);
    try {
      const ids = getRegisteredAgentIds(db);
      expect(ids).toContain('project-orchestrator');
      expect(ids).not.toContain('some-fallback-agent');
    } finally {
      db.close();
    }
  });

  it('falls back to the static 5-template list when DB has no rows in queried tiers', () => {
    // All rows have tier=fallback — query returns empty set
    const db = makeInMemoryAgentsDb([{ agent_id: 'some-fallback-only-agent', tier: 'fallback' }]);
    try {
      const ids = getRegisteredAgentIds(db);
      // Static fallback must kick in
      expect(ids).toContain('project-orchestrator');
      expect(ids).toContain('project-dev-lead');
      expect(ids).toContain(CLASSIFY_FALLBACK_AGENT_ID);
    } finally {
      db.close();
    }
  });

  it('falls back to the static list when no DB is provided', () => {
    const ids = getRegisteredAgentIds();
    expect(ids).toContain('project-orchestrator');
    expect(ids).toContain('project-dev-lead');
    expect(ids).toContain('project-code-worker');
    expect(ids).toContain('project-docs-worker');
    expect(ids).toContain('project-security-worker');
    expect(ids).toContain(CLASSIFY_FALLBACK_AGENT_ID);
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back gracefully when the agents table does not exist in the DB', () => {
    // DB with no tables at all — query will throw, fallback expected
    const db = new DatabaseSync(':memory:');
    try {
      const ids = getRegisteredAgentIds(db);
      // Must not throw — must return static fallback
      expect(ids).toContain('project-orchestrator');
      expect(ids).toContain(CLASSIFY_FALLBACK_AGENT_ID);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// validateClassifierRules — startup drift detection (T1936)
// ---------------------------------------------------------------------------

describe('validateClassifierRules (T1936)', () => {
  it('passes without throwing when all CLASSIFIER_RULES agentIds are in the registry (no DB)', () => {
    // The static fallback includes all 5 canonical personas — should never throw
    expect(() => validateClassifierRules()).not.toThrow();
  });

  it('passes without throwing when DB contains all CLASSIFIER_RULES agentIds', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'project-dev-lead', tier: 'project' },
      { agent_id: 'project-code-worker', tier: 'project' },
      { agent_id: 'project-docs-worker', tier: 'project' },
      { agent_id: 'project-security-worker', tier: 'project' },
    ]);
    try {
      expect(() => validateClassifierRules(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('throws ClassifierUnregisteredAgentError when DB is missing a rule agentId', () => {
    // DB is present but missing project-security-worker — drift scenario
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'project-dev-lead', tier: 'project' },
      { agent_id: 'project-code-worker', tier: 'project' },
      { agent_id: 'project-docs-worker', tier: 'project' },
      // project-security-worker intentionally omitted
    ]);
    try {
      expect(() => validateClassifierRules(db)).toThrow(ClassifierUnregisteredAgentError);
    } finally {
      db.close();
    }
  });

  it('error fields correctly identify the missing agentId', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      // project-dev-lead, project-code-worker, project-docs-worker, project-security-worker omitted
    ]);
    try {
      let thrown: ClassifierUnregisteredAgentError | null = null;
      try {
        validateClassifierRules(db);
      } catch (err) {
        if (err instanceof ClassifierUnregisteredAgentError) {
          thrown = err;
        }
      }
      expect(thrown).not.toBeNull();
      expect(thrown!.code).toBe('E_CLASSIFIER_UNREGISTERED_AGENT');
      // The missing ID should be one of the rules not present in the DB
      expect(thrown!.emittedAgentId).toMatch(/^project-/);
    } finally {
      db.close();
    }
  });

  it('end-to-end: classify a docs task and verify resolved agentId is in live registry', () => {
    const db = makeInMemoryAgentsDb([
      { agent_id: 'project-orchestrator', tier: 'project' },
      { agent_id: 'project-dev-lead', tier: 'project' },
      { agent_id: 'project-code-worker', tier: 'project' },
      { agent_id: 'project-docs-worker', tier: 'project' },
      { agent_id: 'project-security-worker', tier: 'project' },
    ]);
    try {
      const registeredIds = getRegisteredAgentIds(db);
      const task = makeTask({ title: 'Write specification for the new protocol' });
      const result = classifyTask(task, { allowedAgentIds: registeredIds });
      expect(result.agentId).toBe('project-docs-worker');
      expect(registeredIds).toContain(result.agentId);
      expect(result.usedFallback).toBe(false);
    } finally {
      db.close();
    }
  });
});
