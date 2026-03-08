/**
 * E2E Duration Tracking Tests (MCP Spec Section 11.4)
 *
 * Rewritten for the dispatch layer pattern.
 * Tests that duration_ms is tracked for each workflow step.
 *
 * @task T5202
 * @epic T3125
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock engine imports
vi.mock('../../../src/dispatch/lib/engine.js', () => ({
  taskFind: vi.fn(),
}));

// Import the mocked functions for configuration
import { taskFind } from '../../../src/dispatch/lib/engine.js';

describe('11.4 Duration Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  // =========================================================================
  // Test: Duration tracking for workflow steps
  // =========================================================================

  it('should track duration_ms for each step in a workflow', async () => {
    // Mock taskFind response
    (taskFind as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'T2405', title: 'Authentication module', status: 'active' }],
    });

    const result = await dispatchRaw('query', 'tasks', 'find', { query: 'task' });

    // Verify the response has the expected envelope structure
    expect(result._meta).toBeDefined();
    expect(typeof result._meta.duration_ms).toBe('number');
    expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result._meta.duration_ms).toBeLessThan(10000);

    // Verify other envelope fields are present
    expect(result._meta.gateway).toBe('query');
    expect(result._meta.domain).toBe('tasks');
    expect(result._meta.operation).toBe('find');
    expect(result._meta.timestamp).toBeDefined();

    // Verify the actual data was returned
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
  });
});
