/**
 * Tests for the `cleo schema` command.
 *
 * Tests cover:
 *  1. tasks.add returns correct params and gates
 *  2. tasks.complete returns dependency/verification/children gates
 *  3. tasks.unknownop returns E_NOT_FOUND exit 4
 *  4. --format=human routes through cliOutput (T1729 migration)
 *  5. Snapshot of full tasks.add schema output
 *
 * @task T340, T1729
 * @epic T335, T1691
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaCommand } from '../schema.js';

// ---------------------------------------------------------------------------
// Mock cliOutput / cliError
// ---------------------------------------------------------------------------

const mockCliOutput = vi.fn();
const mockCliError = vi.fn();

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Mock format-context so setFormatContext calls are tracked and don't persist
const mockSetFormatContext = vi.fn();
vi.mock('../../format-context.js', () => ({
  setFormatContext: (...args: unknown[]) => mockSetFormatContext(...args),
  getFormatContext: () => ({ format: 'json', source: 'default', quiet: false }),
}));

// Mock process.exit so tests don't terminate the runner
const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  // noop — let tests assert on the error call then continue
}) as (code?: number | string | null) => never);

// Suppress console.log noise during tests
vi.spyOn(console, 'log').mockImplementation(() => undefined);

// ---------------------------------------------------------------------------
// Helper — invoke the schema command action directly
// ---------------------------------------------------------------------------

/**
 * Invoke the schema command with the given operation arg and options.
 *
 * @param operationArg - e.g. `"tasks.add"` or `"tasks.unknownop"`
 * @param opts - CLI option overrides
 */
async function invokeSchema(
  operationArg: string,
  opts: {
    format?: string;
    includeGates?: boolean;
    includeExamples?: boolean;
  } = {},
): Promise<void> {
  await schemaCommand.run?.({
    args: {
      operation: operationArg,
      format: opts.format ?? 'json',
      'include-gates': opts.includeGates !== false,
      'include-examples': opts.includeExamples ?? false,
    },
    rawArgs: [],
    cmd: schemaCommand,
  } as Parameters<NonNullable<typeof schemaCommand.run>>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo schema command (T340)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. tasks.add — params
  // -------------------------------------------------------------------------

  describe('tasks.add', () => {
    it('returns a JSON envelope with required param fields', async () => {
      await invokeSchema('tasks.add');

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [
        { params: Array<{ name: string; required: boolean }> },
        unknown,
      ];

      // Must include at minimum: title, parent, priority, type, size, description, acceptance
      const paramNames = data.params.map((p) => p.name);
      expect(paramNames).toContain('title');
      expect(paramNames).toContain('parent');
      expect(paramNames).toContain('priority');
      expect(paramNames).toContain('type');
      expect(paramNames).toContain('size');
      expect(paramNames).toContain('description');
      expect(paramNames).toContain('acceptance');
    });

    it('priority param has enum [low, medium, high, critical]', async () => {
      await invokeSchema('tasks.add');

      const [data] = mockCliOutput.mock.calls[0] as [
        { params: Array<{ name: string; enum?: readonly string[] }> },
        unknown,
      ];

      const priority = data.params.find((p) => p.name === 'priority');
      expect(priority).toBeDefined();
      expect(priority?.enum).toEqual(['low', 'medium', 'high', 'critical']);
    });

    it('title param is required', async () => {
      await invokeSchema('tasks.add');

      const [data] = mockCliOutput.mock.calls[0] as [
        { params: Array<{ name: string; required: boolean }> },
        unknown,
      ];

      const title = data.params.find((p) => p.name === 'title');
      expect(title?.required).toBe(true);
    });

    it('gates include anti-hallucination and acceptance-criteria-format', async () => {
      await invokeSchema('tasks.add');

      const [data] = mockCliOutput.mock.calls[0] as [
        {
          gates?: Array<{ name: string; errorCode: string }>;
        },
        unknown,
      ];

      expect(data.gates).toBeDefined();
      const gateNames = (data.gates ?? []).map((g) => g.name);
      expect(gateNames).toContain('anti-hallucination');
      expect(gateNames).toContain('acceptance-criteria-format');
    });

    it('gateway is mutate', async () => {
      await invokeSchema('tasks.add');

      const [data] = mockCliOutput.mock.calls[0] as [{ gateway: string }, unknown];
      expect(data.gateway).toBe('mutate');
    });

    it('operation key is "tasks.add"', async () => {
      await invokeSchema('tasks.add');

      const [data] = mockCliOutput.mock.calls[0] as [{ operation: string }, unknown];
      expect(data.operation).toBe('tasks.add');
    });
  });

  // -------------------------------------------------------------------------
  // 2. tasks.complete — gates
  // -------------------------------------------------------------------------

  describe('tasks.complete', () => {
    it('gates include dependency-check, verification-required, and children-completion', async () => {
      await invokeSchema('tasks.complete');

      const [data] = mockCliOutput.mock.calls[0] as [
        {
          gates?: Array<{ name: string }>;
        },
        unknown,
      ];

      expect(data.gates).toBeDefined();
      const gateNames = (data.gates ?? []).map((g) => g.name);
      expect(gateNames).toContain('dependency-check');
      expect(gateNames).toContain('verification-required');
      expect(gateNames).toContain('children-completion');
    });

    it('taskId is a required positional param', async () => {
      await invokeSchema('tasks.complete');

      const [data] = mockCliOutput.mock.calls[0] as [
        { params: Array<{ name: string; required: boolean }> },
        unknown,
      ];

      const taskId = data.params.find((p) => p.name === 'taskId');
      expect(taskId?.required).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Unknown operation — E_NOT_FOUND
  // -------------------------------------------------------------------------

  describe('unknown operation', () => {
    it('calls cliError with exit code 4 for an unknown operation', async () => {
      await invokeSchema('tasks.unknownop');

      expect(mockCliError).toHaveBeenCalledOnce();
      const [message, code, details] = mockCliError.mock.calls[0] as [
        string,
        number,
        { name: string; fix: string },
      ];

      expect(code).toBe(4);
      expect(details.name).toBe('E_NOT_FOUND');
      expect(message).toContain('tasks.unknownop');
    });

    it('fix hint points at cleo schema --list', async () => {
      await invokeSchema('tasks.unknownop');

      const [, , details] = mockCliError.mock.calls[0] as [string, number, { fix: string }];
      expect(details.fix).toContain('cleo schema');
    });

    it('calls process.exit(4)', async () => {
      await invokeSchema('tasks.unknownop');

      expect(mockProcessExit).toHaveBeenCalledWith(4);
    });
  });

  // -------------------------------------------------------------------------
  // 4. --format=human — routes through cliOutput with format context set (T1729)
  // -------------------------------------------------------------------------

  describe('--format=human', () => {
    it('calls cliOutput (routes through renderer pipeline)', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      // T1729: human format now routes through cliOutput — no direct console.log bypass
      expect(mockCliOutput).toHaveBeenCalledOnce();
    });

    it('sets format context to human before calling cliOutput', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      expect(mockSetFormatContext).toHaveBeenCalledWith({
        format: 'human',
        source: 'flag',
        quiet: false,
      });
    });

    it('cliOutput receives schema data with params', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      const [data] = mockCliOutput.mock.calls[0] as [{ params: Array<{ name: string }> }, unknown];

      const paramNames = data.params.map((p) => p.name);
      expect(paramNames).toContain('title');
      expect(paramNames).toContain('priority');
      expect(paramNames).toContain('description');
    });

    it('cliOutput receives command: "schema" for renderer dispatch', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      const [, opts] = mockCliOutput.mock.calls[0] as [
        unknown,
        { command: string; operation: string },
      ];

      expect(opts.command).toBe('schema');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Snapshot of full tasks.add schema
  // -------------------------------------------------------------------------

  describe('tasks.add snapshot', () => {
    it('full schema matches snapshot', async () => {
      await invokeSchema('tasks.add', { includeExamples: true });

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [unknown, unknown];

      // Snapshot captures the full schema shape — any future drift will be detected
      expect(data).toMatchSnapshot();
    });
  });
});
