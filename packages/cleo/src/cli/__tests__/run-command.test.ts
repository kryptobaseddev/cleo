/**
 * `cleo run` CLI surface (T12979): flags after `--` belong to the child, and
 * the runner's exit code mirrors the child's outcome. `--passthrough` (#1777
 * R7) leaves stdout to the child and reports only on stderr. The heap and
 * worker plan is reported (T13122).
 *
 * @task T12979
 * @task T13122
 */

import type {
  RunGovernedOptions,
  RunGovernedResult,
} from '@cleocode/core/resources/run-governed.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never spawn a real command from this file, even if the refusal regresses.
const runGoverned = vi.hoisted(() =>
  vi.fn<(opts: RunGovernedOptions) => Promise<RunGovernedResult>>(),
);
vi.mock('@cleocode/core/resources/run-governed.js', () => ({ runGoverned }));

import { GovernedRunInTestRunnerError } from '@cleocode/core/tasks/tool-runner-guard.js';
import { runCommand, runExitCode } from '../commands/run.js';
import { extractIdempotencyKeyArg } from '../idempotency-context.js';

describe('cleo run argv', () => {
  it('leaves --idempotency-key after -- to the child command', () => {
    const r = extractIdempotencyKeyArg(['run', '--', 'tool', '--idempotency-key', 'k1']);
    expect(r.idempotencyKey).toBeUndefined();
    expect(r.argv).toEqual(['run', '--', 'tool', '--idempotency-key', 'k1']);
  });

  it('still reads a cleo --idempotency-key before --', () => {
    const r = extractIdempotencyKeyArg(['add', '--idempotency-key', 'k2', 'x']);
    expect(r.idempotencyKey).toBe('k2');
    expect(r.argv).toEqual(['add', 'x']);
  });
});

describe('runExitCode', () => {
  it('mirrors the child: code, 128+signal, 127 when it could not start', () => {
    expect(runExitCode({ exitCode: 0, signal: null, spawnError: null })).toBe(0);
    expect(runExitCode({ exitCode: 3, signal: null, spawnError: null })).toBe(3);
    expect(runExitCode({ exitCode: null, signal: 'SIGTERM', spawnError: null })).toBe(143);
    expect(runExitCode({ exitCode: null, signal: 'SIGKILL', spawnError: null })).toBe(137);
    expect(runExitCode({ exitCode: null, signal: null, spawnError: 'ENOENT' })).toBe(127);
  });
});

describe('cleo run refuses watchers (#1777 round 6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runGoverned.mockReset();
  });

  it.each([
    [['turbo', 'run', 'dev']],
    [['pnpm', 'dev']],
    [['vitest', '--ui']],
    [['nx', 'run', 'app:serve']],
  ])('%j exits E_VALIDATION (6) without admission', async (argv) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = runCommand.run as (ctx: {
      args: Record<string, unknown>;
      rawArgs: string[];
    }) => Promise<void>;
    await expect(run({ args: { wait: false }, rawArgs: ['--', ...argv] })).rejects.toThrow(
      'exit 6',
    );
    expect(exit).toHaveBeenCalledWith(6);
    expect(runGoverned).not.toHaveBeenCalled();
  });
});

type RunCtx = { args: Record<string, unknown>; rawArgs: string[] };
const invoke = (args: Record<string, unknown>, argv: readonly string[]): Promise<void> =>
  (runCommand.run as (ctx: RunCtx) => Promise<void>)({
    args: { wait: false, ...args },
    rawArgs: ['--', ...argv],
  });

function exited(
  over: Partial<Extract<RunGovernedResult, { kind: 'exited' }>> = {},
): RunGovernedResult {
  return {
    kind: 'exited',
    class: 'test-run',
    command: 'npx vitest run',
    exitCode: 0,
    signal: null,
    spawnError: null,
    durationMs: 5,
    waitedMs: 0,
    pausedMs: 0,
    pauses: 0,
    slot: 0,
    ungoverned: null,
    ...over,
  };
}

/**
 * Every variable the heavy-tool plan reads (T13122), blanked so a developer's
 * shell profile cannot turn a quiet run into a clamp warning.
 */
const PLAN_INPUTS = [
  'NODE_OPTIONS',
  'VITEST_MAX_WORKERS',
  'JEST_MAX_WORKERS',
  'RUST_TEST_THREADS',
  'CARGO_BUILD_JOBS',
  'GOMAXPROCS',
  'PYTEST_XDIST_AUTO_NUM_WORKERS',
  'npm_config_workspace_concurrency',
  'pnpm_config_workspace_concurrency',
  'MAKEFLAGS',
  'CLEO_HEAVY_HEAP_MB',
  'CLEO_HEAVY_WORKERS',
  'CLEO_HEAVY_WORKSPACE_CONCURRENCY',
] as const;

describe('cleo run --passthrough (#1777 R7)', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    for (const name of PLAN_INPUTS) vi.stubEnv(name, '');
    out = [];
    err = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    runGoverned.mockReset();
  });

  const argv = ['npx', 'vitest', 'run', 'a.test.ts'];
  const opts = (): RunGovernedOptions => runGoverned.mock.calls[0]?.[0] as RunGovernedOptions;

  it('success: the child gets the stdio, and cleo run writes nothing at all', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({ passthrough: true }, argv);
    expect(opts()).toMatchObject({ passthrough: true, foreground: false, argv });
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it.each([
    [{ exitCode: 3 }, 3, 'E_COMMAND_FAILED: command exited with 3'],
    [
      { exitCode: null, signal: 'SIGTERM' as const },
      143,
      'E_COMMAND_FAILED: command killed by SIGTERM',
    ],
  ])('a failed child (%j): its code passes through, one stderr line, nothing on stdout', async (over, code, line) => {
    runGoverned.mockResolvedValue(exited(over));
    await expect(invoke({ passthrough: true }, argv)).rejects.toThrow(`exit ${code}`);
    expect(out).toEqual([]);
    expect(err).toEqual([`[cleo run] ${line}\n`]);
  });

  it('a command that could not start exits 127 with its envelope on stderr', async () => {
    runGoverned.mockResolvedValue(exited({ exitCode: null, spawnError: 'spawn nope ENOENT' }));
    await expect(invoke({ passthrough: true }, argv)).rejects.toThrow('exit 127');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('E_COMMAND_FAILED');
    expect(err.join('')).toContain('spawn nope ENOENT');
  });

  it('a deferral exits 75 with its details on stderr and nothing on stdout', async () => {
    runGoverned.mockResolvedValue({
      kind: 'deferred',
      reason: 'no slot free',
      details: {
        class: 'test-run',
        reason: 'no slot free',
        retryAfterMs: 1000,
        queuePosition: null,
        pressure: { state: 'ok', score: 0, reason: 'ok', memAvailableBytes: null },
        running: [],
      },
      alternatives: [{ action: 'retry', command: 'cleo run -- npx vitest run a.test.ts' }],
      fix: 'Continue other work, or re-run with --wait to queue.',
    });
    await expect(invoke({ passthrough: true }, argv)).rejects.toThrow('exit 75');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('E_RESOURCE_DEFERRED');
    expect(err.join('')).toContain('no slot free');
  });

  it('a runner error goes to stderr (exit 1), never into the child stdout (R8-2)', async () => {
    runGoverned.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, rmdir '/home/run/jobs/x.json'"), {
        code: 'EACCES',
      }),
    );
    await expect(invoke({ passthrough: true }, argv)).rejects.toThrow('exit 1');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('cleo run failed: EACCES');
  });

  it('invalid input goes to stderr too', async () => {
    await expect(invoke({ passthrough: true }, [])).rejects.toThrow('exit 6');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('cleo run needs a command after --');
    expect(runGoverned).not.toHaveBeenCalled();
  });

  it('stays quiet: progress (info) notices are dropped, warnings are printed', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({ passthrough: true }, argv);
    opts().notice?.('admitted after 3s in the test-run queue', 'info');
    opts().notice?.('paused: machine at backoff', 'warn');
    expect(err).toEqual(['[cleo run] paused: machine at backoff\n']);
  });

  it('T13122: an inherited heap above the budget is clamped, and that warning shows under --passthrough', async () => {
    vi.stubEnv('NODE_OPTIONS', '--enable-source-maps --max-old-space-size=999999');
    runGoverned.mockResolvedValue(exited());
    await invoke({ passthrough: true }, argv);
    const childHeap = /--max-old-space-size=(\d+)/.exec(opts().env.NODE_OPTIONS ?? '')?.[1];
    expect(Number(childHeap)).toBeLessThan(999999);
    expect(opts().env.NODE_OPTIONS).toMatch(/^--enable-source-maps --max-old-space-size=\d+$/);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^\[cleo run\] planned resources: heap \d+ MiB .*clamped NODE_OPTIONS/);
  });

  it('T13122: the envelope names the heap and worker plan the child got', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({}, argv);
    const envelope = JSON.parse(out.join('')) as {
      data: { resources: { heapMb: number; workers: number; heapSource: string } };
    };
    expect(envelope.data.resources.heapSource).toBe('default');
    expect(opts().env.NODE_OPTIONS).toBe(`--max-old-space-size=${envelope.data.resources.heapMb}`);
    expect(opts().env.VITEST_MAX_WORKERS).toBe(String(envelope.data.resources.workers));
    // Both spellings, whatever the launcher (an npx-run script may call pnpm -r).
    expect(opts().env.pnpm_config_workspace_concurrency).toBe('1');
    expect(opts().env.npm_config_workspace_concurrency).toBe('1');
    expect(err[0]).toMatch(/^\[cleo run\] planned resources: heap \d+ MiB \(CLEO default\)/);
  });

  it('without --passthrough every notice is printed', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({}, argv);
    opts().notice?.('admitted after 3s in the test-run queue', 'info');
    expect(err).toContain('[cleo run] admitted after 3s in the test-run queue\n');
    expect(opts()).toMatchObject({ passthrough: false, foreground: false });
  });

  describe('a terminal on stdin', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });
    afterEach(() => {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    });

    it('--passthrough keeps the child in the foreground group (spawned detached: false)', async () => {
      runGoverned.mockResolvedValue(exited());
      await invoke({ passthrough: true }, argv);
      expect(opts()).toMatchObject({ passthrough: true, foreground: true });
    });

    it('without --passthrough the layout is unchanged', async () => {
      runGoverned.mockResolvedValue(exited());
      await invoke({}, argv);
      expect(opts()).toMatchObject({ foreground: false });
    });
  });
});

describe('an explicit --class asserts a bounded job (#1777 R7-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runGoverned.mockReset();
  });

  it('skips the watcher refusal', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runGoverned.mockResolvedValue(exited({ class: 'scoped-build' }));
    await invoke({ class: 'build' }, ['pnpm', 'dev']);
    expect(runGoverned).toHaveBeenCalledTimes(1);
    expect(runGoverned.mock.calls[0]?.[0]).toMatchObject({
      cls: 'scoped-build',
      argv: ['pnpm', 'dev'],
    });
  });
});

describe('cleo run refuses accidental whole-suite runs (T13236)', () => {
  let err: string[];
  beforeEach(() => {
    for (const name of PLAN_INPUTS) vi.stubEnv(name, '');
    err = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    runGoverned.mockReset();
  });

  it.each([
    [['pnpm', 'exec', 'vitest', 'run']],
    [['npx', 'vitest', 'run', '--reporter', 'json']],
    [['pnpm', 'exec', 'vitest', 'run', '']],
    [['pnpm', 'exec', 'vitest', 'run', '.']],
    // This package's (and the root's) `test` script is a vitest run.
    [['pnpm', 'test']],
  ])('%j (an empty file list) exits 6 naming the remedy, without admission', async (argv) => {
    await expect(invoke({ passthrough: true }, argv)).rejects.toThrow('exit 6');
    expect(runGoverned).not.toHaveBeenCalled();
    const text = err.join('');
    expect(text).toContain('would run the whole suite');
    expect(text).toContain('--whole-suite');
  });

  it('--whole-suite lets a deliberate whole-suite run through', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({ 'whole-suite': true }, ['pnpm', 'exec', 'vitest', 'run']);
    expect(runGoverned).toHaveBeenCalledTimes(1);
  });

  it('a run that names a file is not refused', async () => {
    runGoverned.mockResolvedValue(exited());
    await invoke({}, ['pnpm', 'exec', 'vitest', 'run', 'src/a.test.ts']);
    expect(runGoverned).toHaveBeenCalledTimes(1);
  });

  it('inside a test runner the governed runner refusal exits 8 with its code on stderr', async () => {
    runGoverned.mockRejectedValue(
      new GovernedRunInTestRunnerError('npx vitest run a.test.ts', 'VITEST'),
    );
    await expect(
      invoke({ passthrough: true }, ['npx', 'vitest', 'run', 'a.test.ts']),
    ).rejects.toThrow('exit 8');
    expect(err.join('')).toContain('E_RUN_SPAWN_IN_TEST_RUNNER');
  });
});
