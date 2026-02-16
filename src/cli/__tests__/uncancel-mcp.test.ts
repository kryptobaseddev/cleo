/**
 * Tests for uncancel MCP domain handler registration.
 * Verifies that uncancel is registered as a supported mutate operation.
 *
 * @task T4555
 * @epic T4545
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the engine imports to avoid initialization
vi.mock('../../mcp/engine/index.js', () => ({
  taskShow: vi.fn(),
  taskList: vi.fn(),
  taskFind: vi.fn(),
  taskExists: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskComplete: vi.fn(),
  taskDelete: vi.fn(),
  taskArchive: vi.fn(),
  taskNext: vi.fn(),
  taskBlockers: vi.fn(),
  taskTree: vi.fn(),
  taskDeps: vi.fn(),
  taskRelates: vi.fn(),
  taskAnalyze: vi.fn(),
  taskRestore: vi.fn(),
  taskUnarchive: vi.fn(),
  taskReorder: vi.fn(),
  taskReparent: vi.fn(),
  taskPromote: vi.fn(),
  taskReopen: vi.fn(),
  taskRelatesAdd: vi.fn(),
  taskComplexityEstimate: vi.fn(),
  resolveProjectRoot: () => '/tmp',
  isProjectInitialized: () => true,
}));

vi.mock('../../mcp/lib/executor.js', () => ({
  CLIExecutor: vi.fn().mockImplementation(() => ({
    isAvailable: () => false,
    execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
  })),
}));

vi.mock('../../mcp/lib/manifest.js', () => ({
  ManifestReader: vi.fn().mockImplementation(() => ({
    getTaskEntries: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../mcp/engine/capability-matrix.js', () => ({
  canRunNatively: () => true,
}));

vi.mock('../../mcp/lib/mode-detector.js', () => ({
  createCLIRequiredError: () => ({ success: false, error: { code: 'E_CLI_REQUIRED', message: 'CLI required' } }),
  createNotInitializedError: () => ({ success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Not initialized' } }),
}));

import { TasksHandler } from '../../mcp/domains/tasks.js';
import { CLIExecutor } from '../../mcp/lib/executor.js';

describe('TasksHandler - uncancel', () => {
  it('includes uncancel in supported mutate operations', () => {
    const executor = new CLIExecutor('cleo', '/tmp');
    const handler = new TasksHandler(executor, '/tmp/MANIFEST.jsonl', 'native');
    const ops = handler.getSupportedOperations();
    expect(ops.mutate).toContain('uncancel');
  });

  it('rejects uncancel without taskId', async () => {
    const executor = new CLIExecutor('cleo', '/tmp');
    const handler = new TasksHandler(executor, '/tmp/MANIFEST.jsonl', 'native');
    const result = await handler.mutate('uncancel', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });
});
