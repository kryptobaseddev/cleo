/**
 * Tests for `cleo config {show, get, set, validate, drift-check}` — verifies
 * the CLI namespace wires into the CORE SSoT registry (T9878) end-to-end.
 *
 * Each test uses an isolated `os.tmpdir()` project root so the live
 * `.cleo/config.json` of the host repo is never touched. The renderer layer
 * is mocked so `cliOutput`/`cliError` calls are observable.
 *
 * @task T9887
 * @saga T9855
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the renderer so cliOutput/cliError become observable spies that do not
// emit to stdout/stderr or call process.exit indirectly via field-extract.
const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
vi.mock('../../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Replace `getProjectRoot()` with a per-test stub that points at our temp dir.
let currentProjectRoot = '';
vi.mock('@cleocode/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...orig,
    getProjectRoot: () => currentProjectRoot,
  };
});

// Import AFTER mocks are wired (vi.mock is hoisted, but the bindings the
// commands close over are captured at import time).
import { configDriftCheckCommand } from '../drift-check.js';
import { configGetCommand } from '../get.js';
import { configSetCommand } from '../set.js';
import { configShowCommand } from '../show.js';
import { configValidateCommand } from '../validate.js';

type RunArgs = Record<string, unknown>;
type CittyCommand = {
  run?: (ctx: { args: RunArgs; rawArgs: string[] }) => Promise<void> | void;
};

async function invoke(cmd: CittyCommand, args: RunArgs): Promise<void> {
  const run = cmd.run;
  if (!run) throw new Error('command has no run()');
  await run({ args, rawArgs: [] });
}

let tempRoot = '';
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cleo-config-test-'));
  mkdirSync(join(tempRoot, '.cleo'), { recursive: true });
  currentProjectRoot = tempRoot;
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new Error(`__EXIT__:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cleo config show
// ---------------------------------------------------------------------------

describe('cleo config show', () => {
  it('returns envelope-shaped payload with project config (scope=project)', async () => {
    writeFileSync(
      join(tempRoot, '.cleo', 'config.json'),
      JSON.stringify({ foo: { bar: 1 } }),
      'utf8',
    );

    await invoke(configShowCommand, { scope: 'project' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    expect(data).toEqual({ scope: 'project', config: { foo: { bar: 1 } } });
    expect(opts).toMatchObject({ command: 'config-show', operation: 'config.show' });
    expect(mockCliError).not.toHaveBeenCalled();
  });

  it('rejects unknown --scope with a typed error envelope', async () => {
    await expect(invoke(configShowCommand, { scope: 'bogus' })).rejects.toThrow(/__EXIT__:1/);

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0]!;
    expect(message).toMatch(/invalid --scope/);
    expect(code).toBe(1);
    expect(details).toMatchObject({ name: 'E_CONFIG_SHOW_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// cleo config get
// ---------------------------------------------------------------------------

describe('cleo config get', () => {
  it('returns E_NOT_FOUND for a missing key', async () => {
    writeFileSync(join(tempRoot, '.cleo', 'config.json'), JSON.stringify({}), 'utf8');

    await expect(invoke(configGetCommand, { key: 'nonexistent.key' })).rejects.toThrow(
      /__EXIT__:4/,
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0]!;
    expect(message).toMatch(/key "nonexistent\.key" not found/);
    expect(code).toBe(4);
    expect(details).toMatchObject({ name: 'E_NOT_FOUND' });
  });

  it('returns the value for an existing key (default merged scope)', async () => {
    writeFileSync(
      join(tempRoot, '.cleo', 'config.json'),
      JSON.stringify({ release: { branchModel: 'feat-to-main' } }),
      'utf8',
    );

    await invoke(configGetCommand, { key: 'release.branchModel' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    expect(data).toEqual({
      scope: 'merged',
      key: 'release.branchModel',
      value: 'feat-to-main',
    });
  });
});

// ---------------------------------------------------------------------------
// cleo config set
// ---------------------------------------------------------------------------

describe('cleo config set', () => {
  it('writes a project config value and round-trips through get', async () => {
    await invoke(configSetCommand, { key: 'foo.bar', value: '42', type: 'number' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [setData] = mockCliOutput.mock.calls[0]!;
    expect(setData).toMatchObject({
      scope: 'project',
      key: 'foo.bar',
      value: 42,
      validate: { ok: true, issues: [] },
    });

    // Round-trip — `cleo config get foo.bar` should return 42.
    mockCliOutput.mockClear();
    await invoke(configGetCommand, { key: 'foo.bar', scope: 'project' });
    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [getData] = mockCliOutput.mock.calls[0]!;
    expect(getData).toEqual({ scope: 'project', key: 'foo.bar', value: 42 });
  });

  it('rejects --type number with a non-numeric value', async () => {
    await expect(
      invoke(configSetCommand, { key: 'foo', value: 'abc', type: 'number' }),
    ).rejects.toThrow(/__EXIT__:2/);

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message] = mockCliError.mock.calls[0]!;
    expect(message).toMatch(/--type number cannot coerce "abc"/);
  });
});

// ---------------------------------------------------------------------------
// cleo config validate
// ---------------------------------------------------------------------------

describe('cleo config validate', () => {
  it('returns ok envelope for a project config without a bound schema', async () => {
    writeFileSync(
      join(tempRoot, '.cleo', 'config.json'),
      JSON.stringify({ anything: 'goes' }),
      'utf8',
    );

    await invoke(configValidateCommand, { scope: 'project' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    expect(data).toEqual({ scope: 'project', ok: true, issues: [] });
    expect(mockCliError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleo config drift-check
// ---------------------------------------------------------------------------

describe('cleo config drift-check', () => {
  it('reports drift on a stale project-context.json (metadata scope)', async () => {
    // detectedAt set to >30 days ago triggers the staleness gate.
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(tempRoot, '.cleo', 'project-context.json'),
      JSON.stringify({ detectedAt: stale }),
      'utf8',
    );

    await expect(invoke(configDriftCheckCommand, { scope: 'metadata' })).rejects.toThrow(
      /__EXIT__:6/,
    );

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    expect(data).toMatchObject({
      scope: 'metadata',
      drift: true,
    });
    expect((data as { reason?: string }).reason).toMatch(/staleness-gate/);
  });

  it('returns drift=false when project config is well-formed', async () => {
    writeFileSync(join(tempRoot, '.cleo', 'config.json'), JSON.stringify({}), 'utf8');

    await invoke(configDriftCheckCommand, { scope: 'project' });

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data] = mockCliOutput.mock.calls[0]!;
    expect(data).toMatchObject({ scope: 'project', drift: false });
  });
});
