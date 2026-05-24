/**
 * Tests for T10341: typed CLI-layer validation for --severity and
 * --pipeline-stage on `cleo add` and `cleo update`.
 *
 * Before T10341 the CLI accepted any string and let SQLite's CHECK
 * constraint reject the write with an opaque
 * `CHECK constraint failed: severity` (or `pipeline_stage`) error.
 *
 * After T10341 the dispatch boundary validates the value against the
 * canonical enums in `@cleocode/contracts` (`TASK_SEVERITIES`) and
 * `@cleocode/core` (`TASK_PIPELINE_STAGES` + forward-only transitions)
 * and short-circuits with a typed error code naming the valid members:
 *   - `E_INVALID_SEVERITY_VALUE` for severity (exit 6)
 *   - `E_INVALID_PIPELINE_STAGE` for pipeline-stage (exit 6)
 *
 * Tests mock the dispatcher layer so no real SQLite database is touched.
 *
 * @task T10341
 * @epic T10327
 * @saga T10326
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dispatch and renderer before importing the command under test
// ---------------------------------------------------------------------------

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();
const mockDispatchFromCli = vi.fn();
const mockCliError = vi.fn();
const mockCliOutput = vi.fn();
const mockHumanInfo = vi.fn();
const mockHumanWarn = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  humanInfo: (...args: unknown[]) => mockHumanInfo(...args),
  humanWarn: (...args: unknown[]) => mockHumanWarn(...args),
}));

// Mock Core inference + attestation — add.ts/update.ts delegate to these.
const mockInferTaskAddParams = vi.fn();
const mockAppendSignedSeverityAttestation = vi.fn();
const mockParseAcceptanceCriteria = vi.fn();
vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    inferTaskAddParams: (...args: unknown[]) => mockInferTaskAddParams(...args),
    appendSignedSeverityAttestation: (...args: unknown[]) =>
      mockAppendSignedSeverityAttestation(...args),
    parseAcceptanceCriteria: (...args: unknown[]) => mockParseAcceptanceCriteria(...args),
  };
});

// ---------------------------------------------------------------------------
// Import commands after mocks are registered
// ---------------------------------------------------------------------------

import { addCommand } from '../add.js';
import { updateCommand } from '../update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noInference = { inferredParent: undefined, files: undefined, acceptance: undefined };

async function invokeAdd(title: string, extraArgs: Record<string, unknown> = {}): Promise<void> {
  const runFn = addCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { title, ...extraArgs }, rawArgs: [] });
}

async function invokeUpdate(
  taskId: string,
  extraArgs: Record<string, unknown> = {},
): Promise<void> {
  const runFn = updateCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { taskId, ...extraArgs }, rawArgs: [] });
}

function successResponse(data: Record<string, unknown> = { id: 'T001' }): Record<string, unknown> {
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
// Test suites
// ---------------------------------------------------------------------------

describe('cleo add --severity validation (T10341)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInferTaskAddParams.mockResolvedValue(noInference);
    mockAppendSignedSeverityAttestation.mockResolvedValue(undefined);
    mockDispatchRaw.mockResolvedValue(successResponse());
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  it('rejects --severity CRITICAL with E_INVALID_SEVERITY_VALUE (exit 6)', async () => {
    await expect(invokeAdd('Task with bad sev', { severity: 'CRITICAL' })).rejects.toThrow(
      'process.exit(6)',
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      number,
      { name: string; fix: string },
    ];
    expect(code).toBe(6);
    expect(details.name).toBe('E_INVALID_SEVERITY_VALUE');
    expect(message).toContain('P0, P1, P2, P3');
    expect(message).toContain("got 'CRITICAL'");
    expect(details.fix).toContain('P0, P1, P2, P3');

    // Dispatch MUST NOT have been called — validation aborts before dispatch.
    expect(mockDispatchRaw).not.toHaveBeenCalled();
    // Attestation MUST NOT have fired either — would leak an audit entry for
    // a request the validator rejects.
    expect(mockAppendSignedSeverityAttestation).not.toHaveBeenCalled();
  });

  it('rejects --severity P9 (numeric-but-invalid) with E_INVALID_SEVERITY_VALUE', async () => {
    await expect(invokeAdd('Bad severity', { severity: 'P9' })).rejects.toThrow('process.exit(6)');

    const [, , details] = mockCliError.mock.calls[0] as [string, number, { name: string }];
    expect(details.name).toBe('E_INVALID_SEVERITY_VALUE');
    expect(mockDispatchRaw).not.toHaveBeenCalled();
  });

  it.each(['P0', 'P1', 'P2', 'P3'])('accepts --severity %s as a valid enum member', async (sev) => {
    await invokeAdd('Valid severity task', { severity: sev });
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();
  });

  it('does NOT validate severity when flag is absent', async () => {
    await invokeAdd('No severity task');
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();
  });
});

describe('cleo update --severity validation (T10341)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendSignedSeverityAttestation.mockResolvedValue(undefined);
    mockDispatchFromCli.mockResolvedValue(undefined);
    mockDispatchRaw.mockResolvedValue(
      successResponse({ id: 'T001', pipelineStage: 'implementation' }),
    );
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  it('rejects --severity FATAL with E_INVALID_SEVERITY_VALUE (exit 6)', async () => {
    await expect(invokeUpdate('T001', { severity: 'FATAL' })).rejects.toThrow('process.exit(6)');

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      number,
      { name: string },
    ];
    expect(code).toBe(6);
    expect(details.name).toBe('E_INVALID_SEVERITY_VALUE');
    expect(message).toContain("got 'FATAL'");
    expect(mockDispatchFromCli).not.toHaveBeenCalled();
    expect(mockAppendSignedSeverityAttestation).not.toHaveBeenCalled();
  });

  it('accepts --severity P0 (canonical enum member)', async () => {
    await invokeUpdate('T001', { severity: 'P0' });
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });
});

describe('cleo update --pipeline-stage validation (T10341)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendSignedSeverityAttestation.mockResolvedValue(undefined);
    mockDispatchFromCli.mockResolvedValue(undefined);
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  it('rejects unknown --pipeline-stage value with E_INVALID_PIPELINE_STAGE (exit 6)', async () => {
    // No show needed — validator short-circuits on unknown stage name
    mockDispatchRaw.mockResolvedValue(successResponse({ id: 'T001', pipelineStage: 'research' }));

    await expect(invokeUpdate('T001', { 'pipeline-stage': 'not-a-real-stage' })).rejects.toThrow(
      'process.exit(6)',
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      number,
      { name: string; fix: string },
    ];
    expect(code).toBe(6);
    expect(details.name).toBe('E_INVALID_PIPELINE_STAGE');
    expect(message).toContain('research');
    expect(message).toContain('implementation');
    expect(message).toContain("got 'not-a-real-stage'");

    // tasks.show MUST NOT have been called — invalid-name path short-circuits
    // before the round trip.
    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).not.toHaveBeenCalled();
  });

  it('rejects backward --pipeline-stage transition with E_INVALID_PIPELINE_STAGE', async () => {
    // Existing task is at 'testing' (order 8); attempting to move back to
    // 'research' (order 1) must be rejected.
    mockDispatchRaw.mockResolvedValue(successResponse({ id: 'T001', pipelineStage: 'testing' }));

    await expect(invokeUpdate('T001', { 'pipeline-stage': 'research' })).rejects.toThrow(
      'process.exit(6)',
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      number,
      { name: string; fix: string },
    ];
    expect(code).toBe(6);
    expect(details.name).toBe('E_INVALID_PIPELINE_STAGE');
    expect(message).toContain('forward-only');
    expect(message).toContain("from 'testing'");
    expect(message).toContain("to 'research'");
    expect(details.fix).toContain('testing'); // current stage echoed in fix
    expect(details.fix).toContain('release'); // a valid forward stage

    // tasks.show was called once (to learn current stage), but tasks.update
    // dispatch must NOT have fired.
    expect(mockDispatchFromCli).not.toHaveBeenCalled();
  });

  it('accepts forward --pipeline-stage transition (implementation → testing)', async () => {
    mockDispatchRaw.mockResolvedValue(
      successResponse({ id: 'T001', pipelineStage: 'implementation' }),
    );

    await invokeUpdate('T001', { 'pipeline-stage': 'testing' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });

  it('accepts same-stage --pipeline-stage transition (idempotent)', async () => {
    mockDispatchRaw.mockResolvedValue(
      successResponse({ id: 'T001', pipelineStage: 'implementation' }),
    );

    await invokeUpdate('T001', { 'pipeline-stage': 'implementation' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });

  it('accepts --pipeline-stage when task has no current stage (first assignment)', async () => {
    mockDispatchRaw.mockResolvedValue(successResponse({ id: 'T001', pipelineStage: null }));

    await invokeUpdate('T001', { 'pipeline-stage': 'implementation' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });

  it('does NOT validate pipeline-stage when flag is absent', async () => {
    await invokeUpdate('T001', { title: 'just a title change' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    // No tasks.show round-trip when --pipeline-stage is absent.
    expect(mockDispatchRaw).not.toHaveBeenCalled();
  });
});
