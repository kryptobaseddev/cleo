/**
 * Pseudo-terminal (PTY) shell runner (T1741 · epic T11456 · SG-TOOLS).
 *
 * The `terminal` toolset's execution backend. Runs a command under a PTY when
 * the OPTIONAL `node-pty` native dependency is loadable, otherwise transparently
 * degrades to a plain `child_process.spawn` (the {@link defaultShellExecutor}
 * path) so the tool ALWAYS works without a heavy native dep. `node-pty` is
 * loaded lazily via dynamic `import()` inside the runner — NEVER at module
 * import — so this file is import-time side-effect-free (and adds no startup
 * cost / hard dependency).
 *
 * The child runs under the SCRUBBED, explicitly-constructed environment from
 * {@link scrubSubprocessEnv} (same security posture as the non-PTY path): the
 * daemon's secrets are never inherited and a Pi-controlled loader hook / PATH
 * can never reach the spawned process. This runner is invoked ONLY from the
 * guard chokepoint ({@link ./guard.js}), so the command denylist applies before
 * any process is spawned — there is no raw bypass.
 *
 * @epic T11456
 * @task T1741
 * @see ./guard.js — the deny-first chokepoint that wraps this runner
 */

import { spawn } from 'node:child_process';
import type { RunShellInput, RunShellResult } from '@cleocode/contracts/tools/agent-tools';
import { getLogger } from '../logger.js';
import { scrubSubprocessEnv } from './env-scrub.js';

const log = getLogger('tool-pty');

/** Default PTY geometry. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * The minimal structural shape of the `node-pty` module we use. Declared
 * locally so this file carries NO type dependency on the optional package —
 * the dynamic import is shape-checked against this, not against `@types/node-pty`.
 */
interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name?: string;
      readonly cols?: number;
      readonly rows?: number;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

/** The minimal structural shape of a spawned `node-pty` process. */
interface NodePtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

/**
 * Attempt to lazily load `node-pty`. Returns `null` when the optional dep is not
 * installed or fails to load (any reason), so the caller can degrade to spawn.
 *
 * The import specifier is held in a variable so bundlers/TS do not treat the
 * missing optional dep as a hard, statically-resolved dependency.
 *
 * @returns The loaded module shape, or `null` when unavailable.
 */
async function loadNodePty(): Promise<NodePtyModule | null> {
  const specifier = 'node-pty';
  try {
    const mod: unknown = await import(specifier);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as { spawn?: unknown }).spawn === 'function'
    ) {
      return candidate as NodePtyModule;
    }
    return null;
  } catch (err) {
    log.debug({ err }, 'node-pty not loadable — falling back to non-PTY spawn');
    return null;
  }
}

/**
 * Run a command under a non-PTY `spawn`, capturing stdout/stderr/exit-code.
 * This is the always-available fallback when `node-pty` is absent or `spawn`
 * mode was explicitly requested.
 *
 * @param input - {@link RunShellInput}.
 * @param ptyFellBack - Whether this spawn is a fallback from a requested PTY.
 * @returns The {@link RunShellResult} (`mode: 'spawn'`).
 */
function runSpawn(input: RunShellInput, ptyFellBack: boolean): Promise<RunShellResult> {
  return new Promise<RunShellResult>((resolve, reject) => {
    const child = spawn(input.command, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: scrubSubprocessEnv({ extra: input.env }),
      timeout: input.timeoutMs,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code, mode: 'spawn', ptyFellBack });
    });
  });
}

/**
 * Run a command under a PTY via the lazily-loaded `node-pty`. The PTY interleaves
 * stdout + stderr on a single stream (as a real terminal does), so the result's
 * `stderr` is empty and all output lands in `stdout`.
 *
 * @param pty - The loaded `node-pty` module.
 * @param input - {@link RunShellInput}.
 * @returns The {@link RunShellResult} (`mode: 'pty'`).
 */
function runWithPty(pty: NodePtyModule, input: RunShellInput): Promise<RunShellResult> {
  return new Promise<RunShellResult>((resolve, reject) => {
    let proc: NodePtyProcess;
    try {
      proc = pty.spawn(input.command, [...(input.args ?? [])], {
        name: 'xterm-256color',
        cols: input.cols ?? DEFAULT_COLS,
        rows: input.rows ?? DEFAULT_ROWS,
        cwd: input.cwd,
        env: scrubSubprocessEnv({ extra: input.env }),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = '';
    let timer: NodeJS.Timeout | undefined;
    if (typeof input.timeoutMs === 'number' && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill();
      }, input.timeoutMs);
    }
    proc.onData((data) => {
      stdout += data;
    });
    proc.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: '',
        code: typeof signal === 'number' && signal > 0 ? null : exitCode,
        mode: 'pty',
        ptyFellBack: false,
      });
    });
  });
}

/**
 * Run a command under a PTY when possible, else a non-PTY spawn.
 *
 * - `spawn` mode → always {@link runSpawn}.
 * - `pty` / `auto` mode → attempt {@link loadNodePty}; on success {@link runWithPty},
 *   otherwise degrade to {@link runSpawn} with `ptyFellBack: true`.
 *
 * The actual process is always launched under the scrubbed subprocess env. This
 * function performs NO policy decision of its own — it is the executor the guard
 * chokepoint ({@link ./guard.js}) invokes AFTER its denylist check passes.
 *
 * @param input - {@link RunShellInput}.
 * @returns The {@link RunShellResult}.
 *
 * @example
 * ```ts
 * const res = await runPty({ command: 'echo', args: ['hi'], mode: 'auto' });
 * // res.mode === 'pty' when node-pty is installed, else 'spawn' (ptyFellBack: true)
 * ```
 */
export async function runPty(input: RunShellInput): Promise<RunShellResult> {
  const mode = input.mode ?? 'auto';
  if (mode === 'spawn') {
    return runSpawn(input, false);
  }
  const pty = await loadNodePty();
  if (pty === null) {
    return runSpawn(input, true);
  }
  return runWithPty(pty, input);
}
