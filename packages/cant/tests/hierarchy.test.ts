/**
 * Unit tests for the 3-tier hierarchy enforcement module.
 *
 * @remarks
 * These tests exercise the spawn-time validation and tool filtering
 * logic per ULTRAPLAN section 10: orchestrator dispatches to leads,
 * leads dispatch to own-group workers, workers cannot dispatch.
 *
 * Vitest with describe/it blocks per project conventions.
 */

import { describe, expect, it } from 'vitest';
import {
  type Role,
  type SpawnValidation,
  type TeamDefinition,
  LEAD_FORBIDDEN_TOOLS,
  ORCHESTRATOR_FORBIDDEN_TOOLS,
  filterToolsForRole,
  validateSpawnRequest,
} from '../src/hierarchy';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Create a standard team definition for testing.
 *
 * Team structure:
 *   - Orchestrator: cleo-prime
 *   - Group "backend": lead = backend-lead, workers = [api-dev, db-dev]
 *   - Group "frontend": lead = frontend-lead, workers = [ui-dev, ux-dev]
 */
function createTestTeam(overrides: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    name: 'test-team',
    orchestrator: 'cleo-prime',
    leads: {
      backend: 'backend-lead',
      frontend: 'frontend-lead',
    },
    workers: {
      backend: ['api-dev', 'db-dev'],
      frontend: ['ui-dev', 'ux-dev'],
    },
    routing: {
      hitlTarget: 'operator',
      orchestratorCanCall: 'leads',
      leadCanCall: 'own_group_workers',
      workerCanCall: [],
      workerCanQuery: 'peers',
    },
    enforcement: 'strict',
    ...overrides,
  };
}

/** Standard tool list for testing. */
const ALL_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

// ---------------------------------------------------------------------------
// validateSpawnRequest
// ---------------------------------------------------------------------------

describe('validateSpawnRequest', () => {
  it('orchestrator to lead allowed', () => {
    const team = createTestTeam();
    const result: SpawnValidation = validateSpawnRequest(
      'cleo-prime',
      'orchestrator',
      'backend-lead',
      'lead',
      team,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('Orchestrator dispatching to lead');
  });

  it('orchestrator to worker rejected', () => {
    const team = createTestTeam();
    const result = validateSpawnRequest(
      'cleo-prime',
      'orchestrator',
      'api-dev',
      'worker',
      team,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('can only dispatch to leads');
    expect(result.reason).toContain('api-dev');
  });

  it('lead to own-group worker allowed', () => {
    const team = createTestTeam();
    const result = validateSpawnRequest(
      'backend-lead',
      'lead',
      'api-dev',
      'worker',
      team,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('own-group worker');
    expect(result.reason).toContain('backend');
  });

  it('lead to other-group worker rejected', () => {
    const team = createTestTeam();
    const result = validateSpawnRequest(
      'backend-lead',
      'lead',
      'ui-dev',
      'worker',
      team,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot dispatch to ui-dev');
    expect(result.reason).toContain('backend');
  });

  it('worker to anyone rejected', () => {
    const team = createTestTeam();
    const result = validateSpawnRequest(
      'api-dev',
      'worker',
      'db-dev',
      'worker',
      team,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot dispatch agents');
    expect(result.reason).toContain('query peers');
  });

  it('with unknown caller group returns false', () => {
    const team = createTestTeam();
    // A lead that is not listed in any group
    const result = validateSpawnRequest(
      'phantom-lead',
      'lead',
      'api-dev',
      'worker',
      team,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found in any team group');
  });

  it('orchestrator to non-existent lead rejected', () => {
    const team = createTestTeam();
    const result = validateSpawnRequest(
      'cleo-prime',
      'orchestrator',
      'nonexistent-lead',
      'lead',
      team,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('can only dispatch to leads');
    expect(result.reason).toContain('nonexistent-lead');
  });
});

// ---------------------------------------------------------------------------
// filterToolsForRole
// ---------------------------------------------------------------------------

describe('filterToolsForRole', () => {
  it('worker keeps all tools', () => {
    const filtered = filterToolsForRole(ALL_TOOLS, 'worker');
    expect(filtered).toEqual(ALL_TOOLS);
  });

  it('lead strips Edit Write Bash', () => {
    const filtered = filterToolsForRole(ALL_TOOLS, 'lead');
    expect(filtered).not.toContain('Edit');
    expect(filtered).not.toContain('Write');
    expect(filtered).not.toContain('Bash');
    expect(filtered).toContain('Read');
    expect(filtered).toContain('Glob');
    expect(filtered).toContain('Grep');
  });

  it('orchestrator strips Edit Write Bash', () => {
    const filtered = filterToolsForRole(ALL_TOOLS, 'orchestrator');
    expect(filtered).not.toContain('Edit');
    expect(filtered).not.toContain('Write');
    expect(filtered).not.toContain('Bash');
  });

  it('lead keeps Read Glob Grep', () => {
    const filtered = filterToolsForRole(ALL_TOOLS, 'lead');
    expect(filtered).toEqual(['Read', 'Glob', 'Grep']);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('LEAD_FORBIDDEN_TOOLS', () => {
  it('contains exactly Edit Write Bash', () => {
    expect(LEAD_FORBIDDEN_TOOLS).toEqual(['Edit', 'Write', 'Bash']);
    expect(LEAD_FORBIDDEN_TOOLS).toHaveLength(3);
  });
});

describe('ORCHESTRATOR_FORBIDDEN_TOOLS', () => {
  it('contains exactly Edit Write Bash', () => {
    expect(ORCHESTRATOR_FORBIDDEN_TOOLS).toEqual(['Edit', 'Write', 'Bash']);
    expect(ORCHESTRATOR_FORBIDDEN_TOOLS).toHaveLength(3);
  });
});
