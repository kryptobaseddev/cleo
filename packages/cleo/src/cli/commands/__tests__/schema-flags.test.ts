/**
 * Tests for `cleo schema <op> --input` and `--examples` flags.
 *
 * Coverage:
 *  1. `--input` returns `{ data.schema }` non-null for an op with a contract
 *  2. `--examples` returns `{ data.examples }` array for an op with a contract
 *  3. Bare `cleo schema <op>` (no flag) still returns the flat param list
 *     (backwards-compat with the pre-T9918 surface).
 *  4. Unknown op returns exit 4 / E_NOT_FOUND.
 *  5. Known op with no registered contract returns the structured
 *     "no contract" payload with a `meta.hint`.
 *
 * @task T9918
 * @epic T9855
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaCommand } from '../schema.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCliOutput = vi.fn();
const mockCliError = vi.fn();

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

const mockSetFormatContext = vi.fn();
vi.mock('../../format-context.js', () => ({
  setFormatContext: (...args: unknown[]) => mockSetFormatContext(...args),
  getFormatContext: () => ({ format: 'json', source: 'default', quiet: false }),
}));

const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  // noop — let tests assert on the error call then continue
}) as (code?: number | string | null) => never);

vi.spyOn(console, 'log').mockImplementation(() => undefined);

// ---------------------------------------------------------------------------
// Helper — invoke schemaCommand with explicit flags
// ---------------------------------------------------------------------------

interface InvokeOpts {
  format?: string;
  includeGates?: boolean;
  includeExamples?: boolean;
  input?: boolean;
  examples?: boolean;
}

async function invokeSchema(operationArg: string, opts: InvokeOpts = {}): Promise<void> {
  await schemaCommand.run?.({
    args: {
      operation: operationArg,
      format: opts.format ?? 'json',
      'include-gates': opts.includeGates !== false,
      'include-examples': opts.includeExamples ?? false,
      input: opts.input ?? false,
      examples: opts.examples ?? false,
    },
    rawArgs: [],
    cmd: schemaCommand,
  } as Parameters<NonNullable<typeof schemaCommand.run>>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo schema <op> --input / --examples (T9918)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. --input
  // -------------------------------------------------------------------------

  describe('--input', () => {
    it('returns an object with a non-null `schema` for tasks.add-batch', async () => {
      await invokeSchema('tasks.add-batch', { input: true });

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [
        { operation: string; schema: unknown },
        unknown,
      ];

      expect(data.operation).toBe('tasks.add-batch');
      expect(data.schema).not.toBeNull();
      expect(typeof data.schema).toBe('object');
    });

    it('returned schema has draft-07 $schema marker and object root', async () => {
      await invokeSchema('tasks.add-batch', { input: true });

      const [data] = mockCliOutput.mock.calls[0] as [{ schema: Record<string, unknown> }, unknown];

      expect(data.schema).toHaveProperty('$schema');
      expect(data.schema['type']).toBe('object');
      expect(data.schema['required']).toEqual(['tasks']);
    });

    it('omits the `examples` key on --input', async () => {
      await invokeSchema('tasks.add-batch', { input: true });

      const [data] = mockCliOutput.mock.calls[0] as [Record<string, unknown>, unknown];

      expect(data).not.toHaveProperty('examples');
    });
  });

  // -------------------------------------------------------------------------
  // 2. --examples
  // -------------------------------------------------------------------------

  describe('--examples', () => {
    it('returns an `examples` array of example payloads', async () => {
      await invokeSchema('tasks.add-batch', { examples: true });

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [
        { operation: string; examples: Array<{ name: string; value: unknown }> },
        unknown,
      ];

      expect(data.operation).toBe('tasks.add-batch');
      expect(Array.isArray(data.examples)).toBe(true);
      expect(data.examples.length).toBeGreaterThan(0);
    });

    it('every example has `name` and `value`', async () => {
      await invokeSchema('tasks.add-batch', { examples: true });

      const [data] = mockCliOutput.mock.calls[0] as [
        { examples: Array<{ name: string; value: unknown }> },
        unknown,
      ];

      for (const ex of data.examples) {
        expect(typeof ex.name).toBe('string');
        expect(ex.name.length).toBeGreaterThan(0);
        expect(ex.value).toBeDefined();
      }
    });

    it('omits the `schema` key on --examples', async () => {
      await invokeSchema('tasks.add-batch', { examples: true });

      const [data] = mockCliOutput.mock.calls[0] as [Record<string, unknown>, unknown];

      expect(data).not.toHaveProperty('schema');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Backwards-compat — bare invocation still returns the flat param list
  // -------------------------------------------------------------------------

  describe('backwards-compat (no flag)', () => {
    it('cleo schema tasks.add-batch returns a flat params list with `tasks`', async () => {
      await invokeSchema('tasks.add-batch');

      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data] = mockCliOutput.mock.calls[0] as [
        { params: Array<{ name: string; required: boolean }> },
        unknown,
      ];

      expect(Array.isArray(data.params)).toBe(true);
      const paramNames = data.params.map((p) => p.name);
      expect(paramNames).toContain('tasks');
    });

    it('bare invocation surface has `gateway` and `operation` keys (LAFS shape)', async () => {
      await invokeSchema('tasks.add-batch');

      const [data] = mockCliOutput.mock.calls[0] as [
        { gateway: string; operation: string },
        unknown,
      ];

      expect(data.gateway).toBe('mutate');
      expect(data.operation).toBe('tasks.add-batch');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Unknown operation — E_NOT_FOUND (same path as bare invocation)
  // -------------------------------------------------------------------------

  describe('unknown op with --input', () => {
    it('returns exit code 4 / E_NOT_FOUND', async () => {
      await invokeSchema('tasks.totally-not-real', { input: true });

      expect(mockCliError).toHaveBeenCalledOnce();
      const [, code, details] = mockCliError.mock.calls[0] as [string, number, { name: string }];

      expect(code).toBe(4);
      expect(details.name).toBe('E_NOT_FOUND');
      expect(mockProcessExit).toHaveBeenCalledWith(4);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Known op without a registered contract — graceful empty + hint
  // -------------------------------------------------------------------------

  describe('known op without registered contract', () => {
    it('--input returns schema: null with a meta.hint', async () => {
      // `tasks.add` exists in OPERATIONS but is not yet seeded into INPUT_CONTRACTS.
      await invokeSchema('tasks.add', { input: true });

      expect(mockCliError).not.toHaveBeenCalled();
      expect(mockCliOutput).toHaveBeenCalledOnce();
      const [data, opts] = mockCliOutput.mock.calls[0] as [
        { schema: unknown; examples: unknown[] },
        { extensions?: { hint?: string } },
      ];

      expect(data.schema).toBeNull();
      expect(data.examples).toEqual([]);
      expect(opts.extensions?.hint).toContain('No OperationInputContract registered');
    });

    it('--examples returns the same empty + hint payload', async () => {
      await invokeSchema('tasks.add', { examples: true });

      expect(mockCliError).not.toHaveBeenCalled();
      const [data, opts] = mockCliOutput.mock.calls[0] as [
        { schema: unknown; examples: unknown[] },
        { extensions?: { hint?: string } },
      ];

      expect(data.examples).toEqual([]);
      expect(data.schema).toBeNull();
      expect(opts.extensions?.hint).toContain('No OperationInputContract registered');
    });
  });
});
