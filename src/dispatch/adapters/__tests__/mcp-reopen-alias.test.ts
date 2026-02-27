/**
 * Tests that reopen is NOT aliased to restore in the MCP adapter.
 *
 * The MCP adapter's resolveOperationAlias maps legacy verbs to canonical ones,
 * but 'reopen' is a distinct operation from 'restore' and must remain separate.
 *
 * @task T4820
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleMcpToolCall, resetMcpDispatcher } from '../mcp.js';

describe('MCP reopen alias — reopen is NOT aliased to restore', () => {
  beforeEach(() => {
    resetMcpDispatcher();
  });

  it('tasks.reopen dispatches as reopen, not restore', async () => {
    // Dispatch reopen through the MCP adapter
    const reopenRes = await handleMcpToolCall(
      'cleo_mutate', 'tasks', 'reopen', { taskId: 'T001' },
    );

    // The operation in _meta should be 'reopen', NOT 'restore'
    expect(reopenRes._meta.operation).toBe('reopen');
  });

  it('tasks.restore dispatches as restore, not reopen', async () => {
    const restoreRes = await handleMcpToolCall(
      'cleo_mutate', 'tasks', 'restore', { taskId: 'T001' },
    );

    expect(restoreRes._meta.operation).toBe('restore');
  });

  it('reopen and restore produce different operations in dispatch metadata', async () => {
    const reopenRes = await handleMcpToolCall(
      'cleo_mutate', 'tasks', 'reopen', { taskId: 'T001' },
    );
    const restoreRes = await handleMcpToolCall(
      'cleo_mutate', 'tasks', 'restore', { taskId: 'T001' },
    );

    // Both should retain their distinct operation names
    expect(reopenRes._meta.operation).not.toBe(restoreRes._meta.operation);
    expect(reopenRes._meta.operation).toBe('reopen');
    expect(restoreRes._meta.operation).toBe('restore');
  });
});
