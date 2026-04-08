/**
 * Tests for the `cleo schema` command.
 *
 * Tests cover:
 *  1. tasks.add returns correct params and gates
 *  2. tasks.complete returns dependency/verification/children gates
 *  3. tasks.unknownop returns E_NOT_FOUND exit 4
 *  4. --format=human is NOT valid JSON but contains param names
 *  5. Snapshot of full tasks.add schema output
 *
 * @task T340
 * @epic T335
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerSchemaCommand } from '../schema.js';

// ---------------------------------------------------------------------------
// Mock cliOutput / cliError
// ---------------------------------------------------------------------------

const mockCliOutput = vi.fn();
const mockCliError = vi.fn();

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Mock process.exit so tests don't terminate the runner
const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  // noop — let tests assert on the error call then continue
}) as (code?: number | string | null) => never);

// Capture console.log output for human format tests
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

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
  const program = new Command();
  registerSchemaCommand(program);

  const schemaCmd = program.commands.find((c) => c.name() === 'schema');
  if (!schemaCmd?._action) {
    throw new Error('schema subcommand has no action registered');
  }

  await schemaCmd._action(operationArg, {
    format: opts.format ?? 'json',
    includeGates: opts.includeGates !== false,
    includeExamples: opts.includeExamples ?? false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo schema command (T340)', () => {
  beforeEach(() => {
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
  // 4. --format=human — not JSON, contains param names
  // -------------------------------------------------------------------------

  describe('--format=human', () => {
    it('prints to console.log (not through cliOutput)', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      // cliOutput should NOT be called — human goes direct to console.log
      expect(mockCliOutput).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('output is NOT valid JSON', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      const printed = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(() => JSON.parse(printed)).toThrow();
    });

    it('output contains the param names', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      const printed = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('title');
      expect(printed).toContain('priority');
      expect(printed).toContain('description');
    });

    it('output contains "Parameters:" section header', async () => {
      await invokeSchema('tasks.add', { format: 'human' });

      const printed = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('Parameters:');
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
