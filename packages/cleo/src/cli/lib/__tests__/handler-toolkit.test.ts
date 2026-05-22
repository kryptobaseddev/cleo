/**
 * Unit tests for handler-toolkit.ts (T10060 — T9833a).
 *
 * Tests each of the 5 primitives + makeDispatchSubcommand factory using
 * vi.mock to isolate from the real dispatch layer and filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (declared before any imports that pull in the mocked modules)
// ---------------------------------------------------------------------------

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn(),
  dispatchRaw: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

vi.mock('@cleocode/core', () => ({
  getProjectRoot: vi.fn().mockReturnValue('/fake/project-root'),
}));

vi.mock('@cleocode/core/agents', () => {
  class MockAgentRegistryAccessor {
    list = vi.fn().mockResolvedValue([]);
    get = vi.fn().mockResolvedValue(null);
  }
  return { AgentRegistryAccessor: MockAgentRegistryAccessor };
});

const mockSpawnSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('node:readline', () => {
  const rl = {
    question: vi.fn(),
    close: vi.fn(),
  };
  return {
    default: {
      createInterface: vi.fn().mockReturnValue(rl),
    },
    createInterface: vi.fn().mockReturnValue(rl),
  };
});

// ---------------------------------------------------------------------------
// Import subject AFTER mocks are registered
// ---------------------------------------------------------------------------

import readline from 'node:readline';
import { getProjectRoot } from '@cleocode/core';
import { dispatchFromCli, dispatchRaw } from '../../../dispatch/adapters/cli.js';
import type { DispatchResponse } from '../../../dispatch/types.js';
import { cliError, cliOutput } from '../../renderers/index.js';
import {
  applyOutputFlags,
  dispatchAndRender,
  execCleoCommand,
  loadAgentRegistry,
  makeDispatchSubcommand,
  withConfirmationFlow,
} from '../handler-toolkit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessResponse(data: unknown = { ok: true }): DispatchResponse {
  return {
    success: true,
    data,
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      requestId: 'req-123',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 5,
      source: 'cli',
    },
  };
}

function makeErrorResponse(
  code = 'E_NOT_FOUND',
  message = 'Not found',
  exitCode = 4,
): DispatchResponse {
  return {
    success: false,
    error: { code, message, exitCode },
    meta: {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'delete',
      requestId: 'req-456',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 2,
      source: 'cli',
    },
  };
}

// ---------------------------------------------------------------------------
// 1. dispatchAndRender
// ---------------------------------------------------------------------------

describe('dispatchAndRender', () => {
  beforeEach(() => {
    vi.mocked(dispatchRaw).mockResolvedValue(makeSuccessResponse());
    vi.mocked(cliOutput).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls dispatchRaw with gateway, domain, operation, params', async () => {
    await dispatchAndRender('query', 'tasks', 'show', { taskId: 'T1' });
    expect(dispatchRaw).toHaveBeenCalledWith('query', 'tasks', 'show', { taskId: 'T1' });
  });

  it('calls cliOutput on success', async () => {
    await dispatchAndRender(
      'query',
      'tasks',
      'show',
      {},
      { output: { command: 'show', operation: 'tasks.show' } },
    );
    expect(cliOutput).toHaveBeenCalled();
  });

  it('returns the raw DispatchResponse', async () => {
    const fakeResponse = makeSuccessResponse({ id: 'T1' });
    vi.mocked(dispatchRaw).mockResolvedValue(fakeResponse);
    const result = await dispatchAndRender('query', 'tasks', 'show', {});
    expect(result).toBe(fakeResponse);
  });

  it('defaults command and operation from domain+operation when not provided', async () => {
    await dispatchAndRender('query', 'memory', 'digest');
    const call = vi.mocked(cliOutput).mock.calls[0];
    expect(call).toBeDefined();
    const opts = call![1] as { command: string; operation: string };
    expect(opts.command).toBe('digest');
    expect(opts.operation).toBe('memory.digest');
  });
});

// ---------------------------------------------------------------------------
// 2. applyOutputFlags
// ---------------------------------------------------------------------------

describe('applyOutputFlags', () => {
  beforeEach(() => {
    vi.mocked(cliOutput).mockImplementation(() => {});
    vi.mocked(cliError).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliOutput with the response data on success', () => {
    const response = makeSuccessResponse({ tasks: [] });
    applyOutputFlags(response, { command: 'list', operation: 'tasks.list' });
    expect(cliOutput).toHaveBeenCalledWith(
      { tasks: [] },
      expect.objectContaining({ command: 'list' }),
    );
  });

  it('forwards page from response when not provided in outputOpts', () => {
    const response: DispatchResponse = {
      ...makeSuccessResponse(),
      page: { mode: 'offset', limit: 5, offset: 0, hasMore: true, total: 10 },
    };
    applyOutputFlags(response, { command: 'list' });
    const opts = vi.mocked(cliOutput).mock.calls[0]![1] as Record<string, unknown>;
    expect(opts['page']).toEqual({ mode: 'offset', limit: 5, offset: 0, hasMore: true, total: 10 });
  });

  it('calls cliError and exits on failure', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit');
    });
    const response = makeErrorResponse('E_NOT_FOUND', 'Task not found', 4);
    try {
      applyOutputFlags(response, { command: 'show', operation: 'tasks.show' });
    } catch {
      // swallow the mocked process.exit throw
    }
    expect(cliError).toHaveBeenCalledWith(
      'Task not found',
      4,
      expect.objectContaining({ name: 'E_NOT_FOUND' }),
      expect.any(Object),
    );
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. withConfirmationFlow
// ---------------------------------------------------------------------------

describe('withConfirmationFlow', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips action and writes dry-run message when dryRun is true', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const action = vi.fn();
    await withConfirmationFlow(action, { dryRun: true });
    expect(action).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
    stderrSpy.mockRestore();
  });

  it('calls action immediately when yes is true (no prompt)', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    await withConfirmationFlow(action, { yes: true });
    expect(action).toHaveBeenCalledTimes(1);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it('aborts and writes stderr when user declines interactively', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The readline mock returns the same rl instance each time createInterface is called
    const rlInstance = readline.createInterface({ input: process.stdin, output: process.stderr });
    vi.mocked(rlInstance.question).mockImplementation((_q: string, cb: (ans: string) => void) =>
      cb('n'),
    );

    const action = vi.fn();
    await withConfirmationFlow(action, {});
    expect(action).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Aborted.\n');
    stderrSpy.mockRestore();
  });

  it('calls action when user confirms interactively', async () => {
    const rlInstance = readline.createInterface({ input: process.stdin, output: process.stderr });
    vi.mocked(rlInstance.question).mockImplementation((_q: string, cb: (ans: string) => void) =>
      cb('y'),
    );

    const action = vi.fn().mockResolvedValue(undefined);
    await withConfirmationFlow(action, {});
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. loadAgentRegistry
// ---------------------------------------------------------------------------

describe('loadAgentRegistry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a registry instance and the project root', async () => {
    vi.mocked(getProjectRoot).mockReturnValue('/fake/project-root');
    const { registry, projectRoot } = await loadAgentRegistry();
    expect(projectRoot).toBe('/fake/project-root');
    expect(typeof registry.list).toBe('function');
  });

  it('binds the registry to the current project root', async () => {
    vi.mocked(getProjectRoot).mockReturnValue('/another/root');
    const { projectRoot } = await loadAgentRegistry();
    expect(projectRoot).toBe('/another/root');
  });
});

// ---------------------------------------------------------------------------
// 5. execCleoCommand
// ---------------------------------------------------------------------------

describe('execCleoCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:true and stdout on success', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '{"success":true}',
      stderr: '',
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = await execCleoCommand(['session', 'status', '--json']);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('{"success":true}');
    expect(result.exitCode).toBe(0);
  });

  it('returns ok:false and stderr on failure', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'E_NO_HANDLER',
      pid: 1235,
      output: [],
      signal: null,
    });

    const result = await execCleoCommand(['unknown-cmd']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('E_NO_HANDLER');
  });
});

// ---------------------------------------------------------------------------
// 6. makeDispatchSubcommand
// ---------------------------------------------------------------------------

describe('makeDispatchSubcommand', () => {
  beforeEach(() => {
    vi.mocked(dispatchFromCli).mockResolvedValue(undefined);
    vi.mocked(cliOutput).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a citty CommandDef object', () => {
    const cmd = makeDispatchSubcommand({
      name: 'digest',
      description: 'Show memory digest',
      args: {},
      gateway: 'query',
      domain: 'memory',
      operation: 'digest',
      output: { command: 'memory-digest', operation: 'memory.digest' },
      paramBuilder: () => ({}),
    });
    expect(cmd).toBeDefined();
    expect(typeof cmd).toBe('object');
  });

  it('merges --json flag into the args automatically', () => {
    const cmd = makeDispatchSubcommand({
      name: 'list',
      description: 'List items',
      args: { filter: { type: 'string', description: 'Filter' } },
      gateway: 'query',
      domain: 'tasks',
      operation: 'list',
      output: { command: 'list', operation: 'tasks.list' },
      paramBuilder: (args) => ({ filter: args['filter'] }),
    });

    const def = cmd as Record<string, unknown>;
    const args = def['args'] as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    expect(args!['json']).toBeDefined();
    expect(args!['filter']).toBeDefined();
  });

  it('uses paramBuilder to map args to dispatch params', async () => {
    const paramBuilder = vi.fn().mockReturnValue({ taskId: 'T999' });
    const cmd = makeDispatchSubcommand({
      name: 'show',
      description: 'Show task',
      args: { taskId: { type: 'string', description: 'Task ID' } },
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      output: { command: 'show', operation: 'tasks.show' },
      paramBuilder,
    });

    const def = cmd as Record<string, unknown>;
    const run = def['run'] as
      | ((ctx: { args: Record<string, unknown> }) => Promise<void>)
      | undefined;
    if (run) {
      await run({ args: { taskId: 'T999', json: false } });
      expect(paramBuilder).toHaveBeenCalledWith({ taskId: 'T999', json: false });
      expect(dispatchFromCli).toHaveBeenCalledWith(
        'query',
        'tasks',
        'show',
        { taskId: 'T999' },
        expect.any(Object),
      );
    }
  });
});
