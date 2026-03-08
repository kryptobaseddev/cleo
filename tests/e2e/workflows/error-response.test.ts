/**
 * E2E Error Response Format Tests (MCP Spec Section 3.2)
 *
 * Rewritten for the dispatch layer pattern.
 * Tests error response format including fix and alternatives fields (LAFS compliance).
 *
 * @task T5201
 * @epic T3125
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock engine imports for Test 1
vi.mock('../../../src/dispatch/lib/engine.js', () => ({
  taskShow: vi.fn(),
}));

// Import the mocked function for configuration
import { taskShow } from '../../../src/dispatch/lib/engine.js';

describe('Error Response Format (Section 3.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  // =========================================================================
  // Helper: validate response envelope per Section 3
  // =========================================================================

  function assertResponseEnvelope(
    response: any,
    expectedGateway: string,
    expectedDomain: string,
    expectedOperation: string,
  ) {
    expect(response._meta).toBeDefined();
    expect(response._meta.gateway).toBe(expectedGateway);
    expect(response._meta.domain).toBe(expectedDomain);
    expect(response._meta.operation).toBe(expectedOperation);
    expect(response._meta.timestamp).toBeDefined();
    expect(typeof response._meta.duration_ms).toBe('number');
    expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof response.success).toBe('boolean');
  }

  function assertErrorResponse(response: any, expectedCode?: string) {
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBeDefined();
    expect(response.error.message).toBeDefined();
    if (expectedCode) {
      expect(response.error.code).toBe(expectedCode);
    }
  }

  // =========================================================================
  // Test 1: Error Response with Fix and Alternatives
  // =========================================================================

  it('should include fix and alternatives in error responses', async () => {
    // Mock error response with fix and alternatives
    // Note: The dispatch layer currently strips fix/alternatives in wrapEngineResult.
    // This test documents the expected behavior once the implementation is fixed.
    (taskShow as any).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        exitCode: 4,
        message: 'Task T9999 not found',
        fix: 'Verify resource exists: T9999',
        alternatives: [
          { action: 'List available resources', command: 'cleo list' },
          { action: 'Search for resource', command: 'cleo find "T9999"' },
        ],
      },
      exitCode: 4,
      stdout: '',
      stderr: 'Task T9999 not found',
      duration: 50,
    });

    const result = await dispatchRaw('query', 'tasks', 'show', {
      taskId: 'T9999',
    });

    assertResponseEnvelope(result, 'query', 'tasks', 'show');
    assertErrorResponse(result, 'E_NOT_FOUND');
    expect(result.error!.message).toContain('not found');
    // Verify LAFS error fields are preserved
    expect(result.error!.fix).toBeDefined();
    expect(result.error!.fix).toBe('Verify resource exists: T9999');
    expect(result.error!.alternatives).toBeDefined();
    expect(result.error!.alternatives).toHaveLength(2);
    expect(result.error!.alternatives![0].action).toBe('List available resources');
    expect(result.error!.alternatives![0].command).toBe('cleo list');
  });

  // =========================================================================
  // Test 2: Invalid Domain Routing
  // =========================================================================

  it('should handle invalid domain routing', async () => {
    const result = await dispatchRaw('query', 'nonexistent', 'show', {});

    // The dispatch layer returns E_INVALID_OPERATION for unknown domain/operation combos
    // because the resolve() function only checks if an operation exists in the registry
    assertErrorResponse(result, 'E_INVALID_OPERATION');
    expect(result.error!.message).toContain('nonexistent');
  });

  // =========================================================================
  // Test 3: Invalid Operation for Domain
  // =========================================================================

  it('should handle invalid operation for domain', async () => {
    const result = await dispatchRaw('query', 'tasks', 'nonexistent_op', {});

    assertErrorResponse(result, 'E_INVALID_OPERATION');
  });

  // =========================================================================
  // Test 4: Wrong Gateway for Operation
  // =========================================================================

  it('should handle wrong gateway for operation', async () => {
    // Trying to use cleo_query for a mutate-only operation
    const result = await dispatchRaw('query', 'tasks', 'add', {
      title: 'Test',
    });

    assertErrorResponse(result, 'E_INVALID_OPERATION');
  });
});
