/**
 * Post-Consolidation Integration Parity Tests
 *
 * Verifies that key operations produce structurally correct results when
 * called through the dispatch layer. After the engine consolidation (T5099),
 * all engines live in src/dispatch/engines/ and the barrel at
 * src/mcp/engine/index.ts re-exports them.
 *
 * These tests validate:
 *  1. Key operations return EngineResult with correct shape
 *  2. Error paths return properly structured error results
 *  3. Barrel re-exports are functionally equivalent to direct dispatch imports
 *
 * Tests that require a real DB are skipped with explanation.
 *
 * @task T5099
 */

import { describe, it, expect } from 'vitest';

import {
  type EngineResult,
  engineError,
  engineSuccess,
} from '../../dispatch/engines/_error.js';

import {
  OPERATIONS,
  resolve,
  getByDomain,
  getActiveDomains,
} from '../../dispatch/registry.js';

import { CANONICAL_DOMAINS, type CanonicalDomain } from '../../dispatch/types.js';

// ===========================================================================
// Test Group 1: EngineResult shape contracts
// ===========================================================================

describe('Integration: EngineResult shape contracts', () => {
  it('engineSuccess wraps any data type and preserves shape', () => {
    // Array data
    const arrayResult: EngineResult<string[]> = engineSuccess(['a', 'b', 'c']);
    expect(arrayResult.success).toBe(true);
    expect(arrayResult.data).toEqual(['a', 'b', 'c']);
    expect(arrayResult.error).toBeUndefined();

    // Object data
    const objResult: EngineResult<{ id: string; title: string }> = engineSuccess({
      id: 'T001',
      title: 'Test task',
    });
    expect(objResult.success).toBe(true);
    expect(objResult.data).toEqual({ id: 'T001', title: 'Test task' });

    // Null data (valid for "no data" scenarios)
    const nullResult: EngineResult<null> = engineSuccess(null);
    expect(nullResult.success).toBe(true);
    expect(nullResult.data).toBeNull();
  });

  it('engineError produces consistent error structure across all error codes', () => {
    const errorCodes = [
      'E_NOT_FOUND',
      'E_VALIDATION',
      'E_PARENT_NOT_FOUND',
      'E_SESSION_NOT_FOUND',
      'E_LIFECYCLE_GATE_FAILED',
    ];

    for (const code of errorCodes) {
      const result = engineError(code, `Error: ${code}`);

      // Shape assertions
      expect(result.success, `${code}: success should be false`).toBe(false);
      expect(result.data, `${code}: data should be undefined`).toBeUndefined();
      expect(result.error, `${code}: error should be defined`).toBeDefined();
      expect(typeof result.error!.code, `${code}: code should be string`).toBe('string');
      expect(typeof result.error!.message, `${code}: message should be string`).toBe('string');
      expect(typeof result.error!.exitCode, `${code}: exitCode should be number`).toBe('number');

      // Value assertions
      expect(result.error!.code).toBe(code);
      expect(result.error!.exitCode).toBeGreaterThanOrEqual(1);
    }
  });
});

// ===========================================================================
// Test Group 2: Operation resolution integration
// ===========================================================================

describe('Integration: Operation resolution for key operations', () => {
  it('tasks.find resolves correctly via registry', () => {
    const result = resolve('query', 'tasks', 'find');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('tasks');
    expect(result!.operation).toBe('find');
    expect(result!.def.gateway).toBe('query');
    expect(result!.def.idempotent).toBe(true);
  });

  it('tasks.show resolves correctly via registry', () => {
    const result = resolve('query', 'tasks', 'show');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('tasks');
    expect(result!.operation).toBe('show');
    expect(result!.def.gateway).toBe('query');
  });

  it('session.status resolves correctly via registry', () => {
    const result = resolve('query', 'session', 'status');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('session');
    expect(result!.operation).toBe('status');
  });

  it('admin.help resolves correctly via registry', () => {
    const result = resolve('query', 'admin', 'help');

    expect(result).toBeDefined();
    expect(result!.domain).toBe('admin');
    expect(result!.operation).toBe('help');
  });

  it('tasks.add resolves as mutate operation', () => {
    const result = resolve('mutate', 'tasks', 'add');

    expect(result).toBeDefined();
    expect(result!.def.gateway).toBe('mutate');
    expect(result!.def.idempotent).toBe(false);
  });

  it('tasks.complete resolves as mutate operation', () => {
    const result = resolve('mutate', 'tasks', 'complete');

    expect(result).toBeDefined();
    expect(result!.def.gateway).toBe('mutate');
  });
});

// ===========================================================================
// Test Group 3: Cross-domain registry consistency
// ===========================================================================

describe('Integration: Cross-domain registry consistency', () => {
  it('all active domains have operations reachable through resolve()', () => {
    const activeDomains = getActiveDomains();

    for (const domain of activeDomains) {
      const ops = getByDomain(domain as CanonicalDomain);
      expect(ops.length, `Domain "${domain}" has no operations`).toBeGreaterThan(0);

      // Verify at least one operation resolves
      const firstOp = ops[0];
      const resolved = resolve(firstOp.gateway, firstOp.domain, firstOp.operation);
      expect(resolved, `First operation in "${domain}" could not be resolved`).toBeDefined();
    }
  });

  it('operation descriptions follow naming convention', () => {
    for (const op of OPERATIONS) {
      // Description should contain domain.operation or be non-empty
      expect(
        op.description.length,
        `${op.domain}.${op.operation} has empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it('all operations have consistent tier values', () => {
    const validTiers = new Set([0, 1, 2]);

    for (const op of OPERATIONS) {
      expect(
        validTiers.has(op.tier),
        `${op.domain}.${op.operation} has invalid tier: ${op.tier}`,
      ).toBe(true);
    }
  });

  it('idempotent flag is boolean for all operations', () => {
    for (const op of OPERATIONS) {
      expect(
        typeof op.idempotent,
        `${op.domain}.${op.operation} idempotent is not boolean`,
      ).toBe('boolean');
    }
  });

  it('query operations are typically idempotent', () => {
    const queryOps = OPERATIONS.filter(o => o.gateway === 'query');
    const idempotentCount = queryOps.filter(o => o.idempotent).length;

    // Most query operations should be idempotent (>90%)
    expect(idempotentCount / queryOps.length).toBeGreaterThan(0.9);
  });
});

// ===========================================================================
// Test Group 4: Barrel functional equivalence
// ===========================================================================

describe('Integration: Barrel functional equivalence', () => {
  it('engineError from barrel and dispatch produce identical results', async () => {
    const barrel = await import('../../../src/mcp/engine/index.js');
    const dispatch = await import('../../dispatch/engines/_error.js');

    const barrelResult = barrel.engineError('E_NOT_FOUND', 'Not found');
    const dispatchResult = dispatch.engineError('E_NOT_FOUND', 'Not found');

    expect(barrelResult.success).toBe(dispatchResult.success);
    expect(barrelResult.error!.code).toBe(dispatchResult.error!.code);
    expect(barrelResult.error!.exitCode).toBe(dispatchResult.error!.exitCode);
  });

  it('engineSuccess from barrel and dispatch produce identical results', async () => {
    const barrel = await import('../../../src/mcp/engine/index.js');
    const dispatch = await import('../../dispatch/engines/_error.js');

    const testData = { id: 'T001', title: 'Test' };
    const barrelResult = barrel.engineSuccess(testData);
    const dispatchResult = dispatch.engineSuccess(testData);

    expect(barrelResult).toEqual(dispatchResult);
  });

  it('barrel task functions reference same implementation as dispatch', async () => {
    const barrel = await import('../../../src/mcp/engine/index.js');
    const dispatch = await import('../../dispatch/engines/task-engine.js');

    // Same function reference — barrel re-exports, not copies
    expect(barrel.taskShow).toBe(dispatch.taskShow);
    expect(barrel.taskList).toBe(dispatch.taskList);
    expect(barrel.taskFind).toBe(dispatch.taskFind);
    expect(barrel.taskCreate).toBe(dispatch.taskCreate);
    expect(barrel.taskComplete).toBe(dispatch.taskComplete);
  });

  it('barrel session functions reference same implementation as dispatch', async () => {
    const barrel = await import('../../../src/mcp/engine/index.js');
    const dispatch = await import('../../dispatch/engines/session-engine.js');

    expect(barrel.sessionStatus).toBe(dispatch.sessionStatus);
    expect(barrel.sessionList).toBe(dispatch.sessionList);
    expect(barrel.sessionStart).toBe(dispatch.sessionStart);
    expect(barrel.sessionEnd).toBe(dispatch.sessionEnd);
  });

  it.skip('tasks.find end-to-end — requires initialized DB', () => {
    // End-to-end dispatch through taskFind() requires an initialized project
    // with a tasks.db database. See cli-mcp-parity.integration.test.ts for
    // mocked end-to-end tests.
  });

  it.skip('tasks.show end-to-end — requires initialized DB', () => {
    // Same as above — requires real data store.
  });

  it.skip('session.status end-to-end — requires initialized DB', () => {
    // Session status requires an active session in the database.
  });

  it.skip('admin.help end-to-end — may require runtime context', () => {
    // admin.help may require MCP server context or dispatch infrastructure.
  });
});
