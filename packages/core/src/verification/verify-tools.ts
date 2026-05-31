/**
 * Core verification helpers: verifyTypes + verifyRuntimeBoot.
 *
 * These two functions are the canonical agent-facing evidence-gathering tools
 * for type-safety and runtime-boot validation in the CLEO monorepo.
 *
 * ## `verifyTypes`
 *
 * Runs `tsc -b` (the project-reference composite build — the real
 * cross-package type oracle). Per-package `pnpm build` FALSE-passes
 * cross-package type breaks because esbuild transpiles without checking;
 * only `tsc -b` exercises the full type graph.
 *
 * ## `verifyRuntimeBoot`
 *
 * Performs a cold boot sequence:
 *   1. `node build.mjs` — rebuilds the CLI bundle from source.
 *   2. `node packages/cleo/dist/cli/index.js version` — smoke-boots the
 *      CLI and asserts it exits cleanly.
 *
 * This catches circular-import TDZ (temporal dead-zone) errors that are
 * invisible to both `tsc` and Biome because they are runtime-only
 * phenomena produced by ESM module evaluation order.
 *
 * ## Return contract
 *
 * Both functions return a {@link VerifyResult} with a discriminated
 * `passed` boolean, `durationMs`, and captured `stdout` / `stderr` tails
 * for actionable diagnostics.  Callers MUST check `passed` before treating
 * the output as valid.
 *
 * ## Regression tests captured
 *
 * - `verifyTypes`: dual-ORM-instance type break (two `drizzle-orm` versions
 *   resolve to different instances — tsc catches the shape mismatch; build passes).
 * - `verifyRuntimeBoot`: leaf-hoist TDZ (circular dep between a leaf package
 *   and a re-exported barrel causes the CLI to throw at startup; invisible to tsc).
 *
 * @task T11488
 * @see packages/core/src/tasks/tool-cache.ts — runToolCached (evidence caching layer)
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The result of a single verification run.
 *
 * @task T11488
 */
export interface VerifyResult {
  /** `true` when the verification step succeeded (exit code 0). */
  passed: boolean;
  /** Process exit code, or `null` if the process could not be spawned. */
  exitCode: number | null;
  /** Trailing stdout captured from the child process (up to 4096 bytes). */
  stdout: string;
  /** Trailing stderr captured from the child process (up to 4096 bytes). */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Human-readable label identifying which verification step this result
   * belongs to (e.g. `"tsc -b"`, `"node build.mjs"`, `"cleo version smoke"`).
   */
  step: string;
}

/**
 * Result of {@link verifyRuntimeBoot}, which runs two sequential steps.
 *
 * @task T11488
 */
export interface RuntimeBootResult {
  /** `true` when BOTH the build step and the CLI smoke step passed. */
  passed: boolean;
  /** Result for the `node build.mjs` step. */
  buildStep: VerifyResult;
  /** Result for the `node packages/cleo/dist/cli/index.js version` step. */
  cliSmokeStep: VerifyResult;
}

/**
 * Options accepted by {@link verifyTypes} and {@link verifyRuntimeBoot}.
 *
 * @task T11488
 */
export interface VerifyOptions {
  /**
   * Absolute path to the monorepo root (the directory containing `build.mjs`
   * and the root `tsconfig.json`).
   *
   * When omitted the working directory of the calling process is used.
   */
  cwd?: string;
  /**
   * Maximum number of bytes retained from stdout / stderr streams.
   *
   * @defaultValue `4096`
   */
  tailBytes?: number;
  /**
   * Timeout in milliseconds for the child process.  When the timeout
   * expires the child is killed and `passed` is `false`.
   *
   * `verifyTypes` default: `300_000` (5 min — full tsc -b on a cold cache).
   * `verifyRuntimeBoot` default: `120_000` (2 min — covers a cold esbuild run).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum bytes retained from a child stream. */
const DEFAULT_TAIL_BYTES = 4096;

/**
 * Minimal ring-buffer that retains the last `cap` bytes of appended data.
 *
 * @internal
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    // Trim from the front when we overflow the cap.
    while (this.size > this.cap && this.chunks.length > 0) {
      const front = this.chunks[0]!;
      if (this.size - front.length >= this.cap) {
        this.size -= front.length;
        this.chunks.shift();
      } else {
        break;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf-8');
  }
}

/**
 * Spawn a command and collect stdout / stderr tails.
 *
 * @param cmd   - Executable name.
 * @param args  - Argument list.
 * @param cwd   - Working directory.
 * @param step  - Human-readable label for the {@link VerifyResult}.
 * @param opts  - Tail and timeout options.
 *
 * @internal
 */
async function runStep(
  cmd: string,
  args: string[],
  cwd: string,
  step: string,
  opts: { tailBytes: number; timeoutMs: number },
): Promise<VerifyResult> {
  const startMs = Date.now();
  const { tailBytes, timeoutMs } = opts;

  return new Promise<VerifyResult>((resolve) => {
    const stdoutBuf = new TailBuffer(tailBytes);
    const stderrBuf = new TailBuffer(tailBytes);

    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf.append(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf.append(d);
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: null,
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        durationMs: Date.now() - startMs,
        step,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? null : code;
      resolve({
        passed: exitCode === 0,
        exitCode,
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        durationMs: Date.now() - startMs,
        step: timedOut ? `${step} [timed out after ${timeoutMs}ms]` : step,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `tsc -b` — the cross-package TypeScript type oracle.
 *
 * Per-package `pnpm build` compiles via esbuild (transpile-only) and
 * therefore passes silently when cross-package type breaks exist.  Only
 * `tsc -b` exercises the full composite project-reference graph.
 *
 * Returns a {@link VerifyResult} with `passed: true` iff `tsc` exits with
 * code 0 (no type errors).
 *
 * @param opts - Optional cwd, tail size, and timeout overrides.
 * @returns Structured pass/fail result with diagnostic output.
 *
 * @example
 * ```ts
 * const result = await verifyTypes({ cwd: '/path/to/monorepo' });
 * if (!result.passed) {
 *   console.error('Type errors found:', result.stderr);
 * }
 * ```
 *
 * @task T11488
 */
export async function verifyTypes(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const cwd = opts.cwd ?? process.cwd();
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return runStep('node', ['node_modules/.bin/tsc', '-b'], cwd, 'tsc -b', {
    tailBytes,
    timeoutMs,
  });
}

/**
 * Run a cold monorepo build + CLI boot smoke.
 *
 * Performs two sequential steps:
 *
 * 1. **Build**: `node build.mjs` — rebuilds the CLI bundle from source
 *    (catches bundler/esbuild-level issues).
 * 2. **CLI smoke**: `node packages/cleo/dist/cli/index.js version` — boots
 *    the CLI and asserts a clean exit (catches circular-import TDZ errors
 *    that are invisible to the type checker).
 *
 * The CLI smoke step is skipped when the build step fails (there is no
 * artefact to boot).
 *
 * Returns a {@link RuntimeBootResult} with `passed: true` iff BOTH steps
 * exit with code 0.
 *
 * @param opts - Optional cwd, tail size, and timeout overrides.
 * @returns Structured result containing per-step diagnostics.
 *
 * @example
 * ```ts
 * const result = await verifyRuntimeBoot({ cwd: '/path/to/monorepo' });
 * if (!result.passed) {
 *   if (!result.buildStep.passed) {
 *     console.error('Build failed:', result.buildStep.stderr);
 *   } else {
 *     console.error('CLI boot failed:', result.cliSmokeStep.stderr);
 *   }
 * }
 * ```
 *
 * @task T11488
 */
export async function verifyRuntimeBoot(opts: VerifyOptions = {}): Promise<RuntimeBootResult> {
  const cwd = opts.cwd ?? process.cwd();
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Step 1: rebuild the CLI bundle.
  const buildStep = await runStep('node', ['build.mjs'], cwd, 'node build.mjs', {
    tailBytes,
    timeoutMs,
  });

  if (!buildStep.passed) {
    // Skip the smoke step when build fails — there is nothing to boot.
    const cliSmokeStep: VerifyResult = {
      passed: false,
      exitCode: null,
      stdout: '',
      stderr: 'Skipped: build step failed.',
      durationMs: 0,
      step: 'node packages/cleo/dist/cli/index.js version [skipped]',
    };
    return { passed: false, buildStep, cliSmokeStep };
  }

  // Step 2: cold-boot CLI and assert `version` exits cleanly.
  const cliSmokeStep = await runStep(
    'node',
    ['packages/cleo/dist/cli/index.js', 'version'],
    cwd,
    'node packages/cleo/dist/cli/index.js version',
    { tailBytes, timeoutMs },
  );

  return {
    passed: cliSmokeStep.passed,
    buildStep,
    cliSmokeStep,
  };
}
