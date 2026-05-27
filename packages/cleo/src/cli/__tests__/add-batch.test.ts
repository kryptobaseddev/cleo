/**
 * Tests for the `cleo add-batch` CLI command.
 *
 * Verifies that the command is a thin adapter: it reads file/stdin input,
 * then makes a single `dispatchRaw('mutate', 'tasks', 'add-batch', ...)` call.
 * All business logic (atomicity, validation) lives in CORE — this test only
 * covers CLI adapter behaviour.
 *
 * @task T9816
 * @epic T9813
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBatchCommand } from '../commands/add-batch.js';
import { setFormatContext } from '../format-context.js';

// ---------------------------------------------------------------------------
// Module mocks — hoisted so they apply before any import resolution
// ---------------------------------------------------------------------------

const { dispatchRawMock, existsSyncMock, readFileSyncMock, readFileMock } = vi.hoisted(() => ({
  dispatchRawMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock('../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: dispatchRawMock,
  dispatchFromCli: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

// T9917: add-batch.ts now reads input through `collectMutateInput` which
// uses `readFile` from `node:fs/promises`. Mock it in lockstep with the
// legacy `node:fs` mocks so the existing test fixtures continue to work.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    default: { ...original, readFile: readFileMock },
    readFile: readFileMock,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal success envelope returned by the mocked CORE op. */
function makeSuccessEnvelope(tasks: Array<{ id: string; title: string }>) {
  return {
    success: true,
    data: {
      created: tasks.length,
      tasks: tasks.map((t) => ({ task: { id: t.id, title: t.title }, duplicate: false })),
      dryRun: false,
    },
    meta: { operation: 'tasks.add-batch', duration_ms: 0, timestamp: new Date().toISOString() },
  };
}

/** Minimal error envelope returned by the mocked CORE op. */
function makeErrorEnvelope(code: string, message: string) {
  return {
    success: false,
    error: { code, message, fix: 'Fix your task specs' },
    meta: { operation: 'tasks.add-batch', duration_ms: 0, timestamp: new Date().toISOString() },
  };
}

/**
 * Invoke the addBatchCommand run handler with the given args.
 * Captures stdout/stderr and process.exitCode.
 */
async function invokeAddBatch(
  args: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  setFormatContext({ format: 'json', source: 'flag', quiet: false });
  return _invoke(args);
}

async function _invoke(args: Record<string, unknown>) {
  let stdoutBuf = '';
  let stderrBuf = '';

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;

  process.stdout.write = (chunk: unknown): boolean => {
    stdoutBuf += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrBuf += String(chunk);
    return true;
  };
  process.exitCode = undefined;

  const runFn = addBatchCommand.run as
    | ((ctx: { args: Record<string, unknown> }) => Promise<void>)
    | undefined;
  if (runFn) {
    try {
      await runFn({ args });
    } catch {
      // CLI sets exitCode before throwing; swallow.
    }
  }

  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;

  const result = {
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode: process.exitCode as number | undefined,
  };
  process.exitCode = origExitCode;
  return result;
}

// ---------------------------------------------------------------------------
// Tests — command metadata
// ---------------------------------------------------------------------------

describe('addBatchCommand metadata', () => {
  it('exports a command with name "add-batch"', () => {
    const meta =
      typeof addBatchCommand.meta === 'function' ? addBatchCommand.meta() : addBatchCommand.meta;
    expect((meta as { name: string }).name).toBe('add-batch');
  });

  it('description mentions atomic transaction', () => {
    const meta =
      typeof addBatchCommand.meta === 'function' ? addBatchCommand.meta() : addBatchCommand.meta;
    expect((meta as { description: string }).description).toContain('atomic');
  });

  it('defines --file, --parent, --dry-run args', () => {
    const args = addBatchCommand.args as Record<string, { type: string }> | undefined;
    expect(args?.['file']).toBeDefined();
    expect(args?.['parent']).toBeDefined();
    expect(args?.['dry-run']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — single dispatch call (file input)
// ---------------------------------------------------------------------------

describe('addBatchCommand dispatch behaviour (file input)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls dispatchRaw exactly once for file input with all tasks', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify([
        { title: 'Task A', acceptance: ['a'] },
        { title: 'Task B', acceptance: ['b'] },
      ]),
    );
    dispatchRawMock.mockResolvedValueOnce(
      makeSuccessEnvelope([
        { id: 'T001', title: 'Task A' },
        { id: 'T002', title: 'Task B' },
      ]),
    );

    await invokeAddBatch({ file: '/tmp/tasks.json' });

    expect(dispatchRawMock).toHaveBeenCalledTimes(1);
    expect(dispatchRawMock).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add-batch',
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ title: 'Task A' }),
          expect.objectContaining({ title: 'Task B' }),
        ]),
      }),
    );
  });

  it('forwards dryRun: true when --dry-run is set', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify([{ title: 'T', acceptance: ['a'] }]));
    dispatchRawMock.mockResolvedValueOnce(makeSuccessEnvelope([]));

    await invokeAddBatch({ file: '/tmp/tasks.json', 'dry-run': true });

    expect(dispatchRawMock).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add-batch',
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('forwards defaultParent when --parent is set', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify([{ title: 'Child', acceptance: ['a'] }]));
    dispatchRawMock.mockResolvedValueOnce(makeSuccessEnvelope([]));

    await invokeAddBatch({ file: '/tmp/tasks.json', parent: 'T999' });

    expect(dispatchRawMock).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add-batch',
      expect.objectContaining({ defaultParent: 'T999' }),
    );
  });

  it('does NOT include defaultParent when --parent is not set', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify([{ title: 'Task', acceptance: ['a'] }]));
    dispatchRawMock.mockResolvedValueOnce(makeSuccessEnvelope([]));

    await invokeAddBatch({ file: '/tmp/tasks.json' });

    const callArgs = dispatchRawMock.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('defaultParent');
  });

  it('exits 1 and does NOT call dispatchRaw again when CORE op returns success: false', async () => {
    // T9917: payload must pass schema validation FIRST (titles required).
    // CORE-side failures (e.g. parent not found, BRAIN duplicate guard) now
    // produce the legacy exit 1 / E_BATCH_FAILED envelope.
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify([
        { title: 'Good', acceptance: ['a'] },
        { title: 'Also good', acceptance: ['b'] },
      ]),
    );
    dispatchRawMock.mockResolvedValueOnce(makeErrorEnvelope('E_BATCH_FAILED', 'parent not found'));

    const result = await invokeAddBatch({ file: '/tmp/tasks.json' });

    expect(result.exitCode).toBe(1);
    // Exactly ONE call — CLI never retries
    expect(dispatchRawMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT call dispatchRaw when file does not exist', async () => {
    // T9917: collectMutateInput uses fs/promises.readFile. ENOENT bubbles up
    // through the CLI catch path which surfaces it as E_VALIDATION_FAILED
    // (exit 6) — same outcome (no dispatch, non-zero exit) as the legacy
    // existsSync-based pre-check.
    existsSyncMock.mockReturnValue(false);
    readFileMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await invokeAddBatch({ file: '/does/not/exist.json' });

    expect(dispatchRawMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(6);
  });

  it('does NOT call dispatchRaw when JSON from file is invalid', async () => {
    // T9917: collectMutateInput surfaces JSON parse errors with the source
    // label and a snippet — CLI maps that to E_VALIDATION_FAILED (exit 6),
    // up from the legacy exit 2.
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue('not valid json{{{');

    const result = await invokeAddBatch({ file: '/tmp/bad.json' });

    expect(dispatchRawMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(6);
  });

  it('does NOT include dryRun when --dry-run is not set', async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify([{ title: 'Task', acceptance: ['a'] }]));
    dispatchRawMock.mockResolvedValueOnce(makeSuccessEnvelope([]));

    await invokeAddBatch({ file: '/tmp/tasks.json' });

    const callArgs = dispatchRawMock.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('dryRun');
  });
});
