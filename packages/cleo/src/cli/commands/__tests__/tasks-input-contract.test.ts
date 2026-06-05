/**
 * Tests for T9917 — `tasks.add` / `tasks.add-batch` / `tasks.update` retrofit
 * to the schema-first OperationInputContract surface.
 *
 * Validates the uniform 3-step pattern shared by all three commands:
 *
 *   1. collectMutateInput (T9916) — `--params` / `--params-file` / stdin
 *   2. validateOperationInput (T9915) against INPUT_CONTRACTS (T9917)
 *   3. dispatchRaw — single core call once validated
 *
 * Coverage matrix (mirrors the task brief):
 *
 *   ┌─ cleo add ────────────────────────────────────────────────────┐
 *   │  • positional `cleo add "title" --priority high`              │
 *   │  • `cleo add --params '{"title":"hello",...}'`                │
 *   │  • `cleo add --params '{"badField":42}'` → E_VALIDATION_FAILED│
 *   ├─ cleo add-batch ──────────────────────────────────────────────┤
 *   │  • `cleo add-batch --params '[{...},{...}]'` (legacy array)   │
 *   │  • `cleo add-batch --params '{"tasks":[...]}'` (canonical)    │
 *   ├─ cleo update ─────────────────────────────────────────────────┤
 *   │  • `cleo update T9917 --params '{"status":"active"}'`         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Plus: validation-error envelope shape MUST include path / expected /
 * received / fix / errorCode entries (ValidationError contract).
 *
 * Tests mock the dispatcher so no real SQLite is touched.
 *
 * @task T9917
 * @epic T9903
 * @saga T9855
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must register before importing the commands under test)
// ---------------------------------------------------------------------------

const mockDispatchRaw = vi.fn();
const mockDispatchFromCli = vi.fn();
const mockHandleRawError = vi.fn();
const mockCliError = vi.fn();
const mockCliOutput = vi.fn();
const mockHumanInfo = vi.fn();
const mockHumanWarn = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  maybeEmitDescribe: () => false,
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  humanInfo: (...args: unknown[]) => mockHumanInfo(...args),
  humanWarn: (...args: unknown[]) => mockHumanWarn(...args),
}));

// `add.ts` delegates a few helpers to core (inferTaskAddParams + the
// signed-severity attestation); silence them so they don't touch disk.
const mockInferTaskAddParams = vi.fn();
const mockAppendSignedSeverityAttestation = vi.fn();
vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    inferTaskAddParams: (...args: unknown[]) => mockInferTaskAddParams(...args),
    appendSignedSeverityAttestation: (...args: unknown[]) =>
      mockAppendSignedSeverityAttestation(...args),
  };
});

// ---------------------------------------------------------------------------
// Commands under test — imported AFTER mocks
// ---------------------------------------------------------------------------

import { addCommand } from '../add.js';
import { addBatchCommand } from '../add-batch.js';
import { updateCommand } from '../update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExitError extends Error {
  code: number | string | null | undefined;
}

function stubProcessExit(): void {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    const err = new Error(`process.exit(${String(code)})`) as ExitError;
    err.code = code;
    throw err;
  });
}

async function invokeRun(
  cmd: { run?: (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void> },
  args: Record<string, unknown>,
): Promise<void> {
  const runFn = cmd.run;
  if (!runFn) throw new Error('command has no run handler');
  try {
    await runFn({ args, rawArgs: [] });
  } catch (err) {
    // process.exit throws via stubProcessExit above — swallow so tests see
    // the side-effects on mock spies.
    if ((err as ExitError).code === undefined) throw err;
  }
}

function successDispatchResponse(data: Record<string, unknown>): Record<string, unknown> {
  return {
    success: true,
    data,
    _meta: {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'cli',
      requestId: 'r-test',
    },
  };
}

// ---------------------------------------------------------------------------
// cleo add — positional + --params + bad-input
// ---------------------------------------------------------------------------

describe('cleo add — backwards-compat positional path (T9917)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProcessExit();
    mockInferTaskAddParams.mockResolvedValue({
      inferredParent: undefined,
      files: undefined,
      acceptance: undefined,
    });
    mockDispatchRaw.mockResolvedValue(successDispatchResponse({ id: 'T001', title: 'hello' }));
  });

  it('still dispatches when a positional title + --priority is supplied', async () => {
    await invokeRun(addCommand, { title: 'hello', priority: 'high' });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [gateway, domain, op, params] = mockDispatchRaw.mock.calls[0] ?? [];
    expect(gateway).toBe('mutate');
    expect(domain).toBe('tasks');
    expect(op).toBe('add');
    expect((params as Record<string, unknown>)['title']).toBe('hello');
    expect((params as Record<string, unknown>)['priority']).toBe('high');
    expect(mockCliError).not.toHaveBeenCalled();
  });
});

describe('cleo add — schema-first --params path (T9917)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProcessExit();
    mockInferTaskAddParams.mockResolvedValue({
      inferredParent: undefined,
      files: undefined,
      acceptance: undefined,
    });
    mockDispatchRaw.mockResolvedValue(successDispatchResponse({ id: 'T002', title: 'hello' }));
  });

  it('dispatches a valid --params JSON payload via schema-first path', async () => {
    await invokeRun(addCommand, {
      params: JSON.stringify({ title: 'hello', priority: 'high' }),
    });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [, , op, params] = mockDispatchRaw.mock.calls[0] ?? [];
    expect(op).toBe('add');
    expect((params as Record<string, unknown>)['title']).toBe('hello');
    expect((params as Record<string, unknown>)['priority']).toBe('high');
    // Schema-first path SHOULD NOT call inferTaskAddParams (legacy helper).
    expect(mockInferTaskAddParams).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and surfaces E_VALIDATION_FAILED with errors[]', async () => {
    await invokeRun(addCommand, {
      params: JSON.stringify({ title: 'ok', badField: 42 }),
    });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledTimes(1);
    const [message, code, details] = mockCliError.mock.calls[0] ?? [];
    expect(message).toContain('validation');
    expect(code).toBe(6); // ExitCode.VALIDATION_ERROR
    const detailObj = details as { name: string; details: { errors: unknown[] } };
    expect(detailObj.name).toBe('E_VALIDATION_FAILED');
    expect(Array.isArray(detailObj.details.errors)).toBe(true);
    expect(detailObj.details.errors.length).toBeGreaterThan(0);
    const firstError = detailObj.details.errors[0] as Record<string, unknown>;
    expect(firstError).toHaveProperty('path');
    expect(firstError).toHaveProperty('expected');
    expect(firstError).toHaveProperty('received');
    expect(firstError).toHaveProperty('fix');
    expect(firstError).toHaveProperty('errorCode');
  });

  it('rejects missing required title', async () => {
    await invokeRun(addCommand, {
      params: JSON.stringify({ priority: 'high' }),
    });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledTimes(1);
    const [, , details] = mockCliError.mock.calls[0] ?? [];
    const errors = (details as { details: { errors: Array<Record<string, unknown>> } }).details
      .errors;
    expect(errors.some((e) => String(e['errorCode']).includes('REQUIRED'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleo add-batch — array shape + canonical-object shape
// ---------------------------------------------------------------------------

describe('cleo add-batch — --params variants (T9917)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProcessExit();
    mockDispatchRaw.mockResolvedValue(
      successDispatchResponse({
        created: 2,
        tasks: [
          { task: { id: 'T100', title: 'a' }, duplicate: false },
          { task: { id: 'T101', title: 'b' }, duplicate: false },
        ],
      }),
    );
  });

  it('accepts the canonical { tasks: [...] } object via --params', async () => {
    await invokeRun(addBatchCommand, {
      params: JSON.stringify({ tasks: [{ title: 'a' }, { title: 'b' }] }),
    });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [, , op, params] = mockDispatchRaw.mock.calls[0] ?? [];
    expect(op).toBe('add-batch');
    const ts = (params as Record<string, unknown>)['tasks'] as Array<Record<string, unknown>>;
    expect(ts).toHaveLength(2);
    expect(ts[0]?.['title']).toBe('a');
    expect(ts[1]?.['title']).toBe('b');
  });

  it('accepts the legacy bare-array shape via --params and wraps it', async () => {
    await invokeRun(addBatchCommand, {
      params: JSON.stringify([{ title: 'a' }, { title: 'b' }]),
    });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [, , , params] = mockDispatchRaw.mock.calls[0] ?? [];
    const ts = (params as Record<string, unknown>)['tasks'] as Array<Record<string, unknown>>;
    expect(ts).toHaveLength(2);
  });

  it('rejects an empty tasks array with E_VALIDATION_FAILED', async () => {
    await invokeRun(addBatchCommand, {
      params: JSON.stringify({ tasks: [] }),
    });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledTimes(1);
    const [, , details] = mockCliError.mock.calls[0] ?? [];
    expect((details as { name: string }).name).toBe('E_VALIDATION_FAILED');
  });

  it('folds --parent into defaultParent when payload omits it', async () => {
    await invokeRun(addBatchCommand, {
      params: JSON.stringify({ tasks: [{ title: 'a' }] }),
      parent: 'T9903',
    });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [, , , params] = mockDispatchRaw.mock.calls[0] ?? [];
    expect((params as Record<string, unknown>)['defaultParent']).toBe('T9903');
  });
});

// ---------------------------------------------------------------------------
// cleo update — positional + --params taskId injection
// ---------------------------------------------------------------------------

describe('cleo update — --params path (T9917)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProcessExit();
    mockDispatchRaw.mockResolvedValue(
      successDispatchResponse({ task: { id: 'T9917', status: 'active' } }),
    );
  });

  it('dispatches a valid --params JSON payload', async () => {
    await invokeRun(updateCommand, {
      taskId: 'T9917',
      params: JSON.stringify({ status: 'active' }),
    });

    expect(mockDispatchRaw).toHaveBeenCalledTimes(1);
    const [, , op, params] = mockDispatchRaw.mock.calls[0] ?? [];
    expect(op).toBe('update');
    // Positional taskId was folded in when --params omitted it.
    expect((params as Record<string, unknown>)['taskId']).toBe('T9917');
    expect((params as Record<string, unknown>)['status']).toBe('active');
  });

  it('rejects an unknown field with E_VALIDATION_FAILED', async () => {
    await invokeRun(updateCommand, {
      taskId: 'T9917',
      params: JSON.stringify({ status: 'active', badField: 1 }),
    });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledTimes(1);
    const [, , details] = mockCliError.mock.calls[0] ?? [];
    const errors = (details as { details: { errors: Array<Record<string, unknown>> } }).details
      .errors;
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid status enum value', async () => {
    await invokeRun(updateCommand, {
      taskId: 'T9917',
      params: JSON.stringify({ status: 'no-such-status' }),
    });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledTimes(1);
    const [, , details] = mockCliError.mock.calls[0] ?? [];
    const errors = (details as { details: { errors: Array<Record<string, unknown>> } }).details
      .errors;
    expect(errors.some((e) => String(e['errorCode']).includes('ENUM'))).toBe(true);
  });
});
