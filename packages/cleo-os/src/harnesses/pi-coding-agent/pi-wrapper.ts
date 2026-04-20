/**
 * Pi binary wrapper — low-level launcher for the Pi coding agent CLI.
 *
 * Handles prompt delivery, process spawning, stdin/stdout/stderr wiring,
 * and SIGTERM-then-SIGKILL cleanup. This module is the only place in
 * cleo-os that touches `child_process.spawn` directly for Pi.
 *
 * @remarks
 * Pi receives its prompt via **file mode**: the prompt text is written to a
 * temporary file under `/tmp/` and passed as a positional CLI argument
 * (`pi <file>`). This mirrors the pattern used by `PiSpawnProvider` in
 * `packages/adapters/` and avoids stdin complexity for non-interactive runs.
 *
 * CleoOS extension injection follows the same mechanism as `cli.ts`: each
 * discovered extension is prepended as `--extension <path>` so Pi loads
 * bridges (CANT bridge, hooks bridge, etc.) even in non-interactive mode.
 *
 * Environment variable overrides (all optional):
 *   - `CLEO_PI_BINARY`              — path to the `pi` binary (default: `pi` from PATH)
 *   - `CLEO_TERMINATE_GRACE_MS`     — SIGTERM grace window in ms (default: `5000`)
 *   - `CLEO_HARNESS_OUTPUT_BUFFER`  — ring buffer capacity per process (default: `500`)
 *
 * OpenClaw patterns adopted:
 *   - Extension injection via `--extension <path>` flags.
 *   - Prompt written to `/tmp/` with a unique suffix; cleaned up on exit.
 *   - `PI_TELEMETRY=0` injected by default to suppress telemetry in CI.
 *
 * @packageDocumentation
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessOutputLine, HarnessProcessState, HarnessProcessStatus } from './types.js';

/** Maximum number of output lines retained in the ring buffer per process. */
const DEFAULT_OUTPUT_BUFFER_SIZE = 500;

/** Default SIGTERM → SIGKILL grace window in milliseconds. */
const DEFAULT_TERMINATE_GRACE_MS = 5000;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the `pi` binary path.
 *
 * Honours `CLEO_PI_BINARY` env var when set (absolute path or bare name),
 * otherwise defaults to `pi` (expects the binary on PATH).
 *
 * @returns Resolved binary path string.
 *
 * @public
 */
export function getPiBinaryPath(): string {
  return process.env['CLEO_PI_BINARY'] ?? 'pi';
}

/**
 * Return the SIGTERM grace window in milliseconds.
 *
 * Reads `CLEO_TERMINATE_GRACE_MS` from the environment; falls back to
 * {@link DEFAULT_TERMINATE_GRACE_MS} when absent or non-positive.
 *
 * @public
 */
export function getTerminateGraceMs(): number {
  const raw = process.env['CLEO_TERMINATE_GRACE_MS'];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TERMINATE_GRACE_MS;
}

/**
 * Return the output ring buffer capacity.
 *
 * Reads `CLEO_HARNESS_OUTPUT_BUFFER` from the environment; falls back to
 * {@link DEFAULT_OUTPUT_BUFFER_SIZE} when absent or non-positive.
 *
 * @public
 */
export function getOutputBufferSize(): number {
  const raw = process.env['CLEO_HARNESS_OUTPUT_BUFFER'];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_OUTPUT_BUFFER_SIZE;
}

// ---------------------------------------------------------------------------
// Extension path resolution
// ---------------------------------------------------------------------------

/**
 * Collect CleoOS extension paths that exist on disk.
 *
 * Resolves the standard extension list relative to the compiled package root
 * (`extensions/` directory adjacent to `dist/`). Only paths that exist on
 * disk are returned — missing extensions are skipped silently so the adapter
 * degrades gracefully when extensions are not installed.
 *
 * Mirrors `collectExtensionPaths()` in `cli.ts` but does not depend on
 * `@cleocode/core` to keep this module free of external package imports.
 *
 * @returns Array of absolute `.js` extension paths.
 *
 * @public
 */
export function resolveExtensionPaths(): string[] {
  // Compiled path: dist/harnesses/pi-coding-agent/ → walk up to dist/ → package root
  const packageRoot = join(__dirname, '..', '..', '..');
  const extensionsDir = join(packageRoot, 'extensions');
  const candidates = [
    'cleo-startup.js',
    'cleo-cant-bridge.js',
    'cleo-hooks-bridge.js',
    'cleo-chatroom.js',
    'cleo-agent-monitor.js',
  ];
  return candidates.map((name) => join(extensionsDir, name)).filter((p) => existsSync(p));
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Internal state tracked for each spawned Pi process.
 */
export interface PiProcessEntry {
  /** OS process ID (or null if spawn failed before assigning one). */
  pid: number | null;
  /** Live child process handle (null after the process exits). */
  child: ChildProcess | null;
  /** Task ID from the caller. */
  taskId: string;
  /** Stable instance ID. */
  instanceId: string;
  /** ISO-8601 spawn timestamp. */
  startedAt: string;
  /** Current lifecycle state. */
  state: HarnessProcessState;
  /** Exit code (populated on exit). */
  exitCode: number | null;
  /** Signal used to terminate (populated on kill). */
  terminatingSignal: NodeJS.Signals | null;
  /** ISO-8601 end timestamp. */
  endedAt: string | null;
  /** Error message for 'failed' state. */
  error: string | null;
  /** Bounded output ring buffer. */
  outputBuffer: HarnessOutputLine[];
  /** Resolve callback for the exitPromise. */
  resolveExit: (status: HarnessProcessStatus) => void;
  /** Path of the temporary prompt file (cleaned up on exit). */
  tmpFile: string | null;
  /** SIGKILL timer handle (set during the grace window). */
  killTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Append a line to a bounded ring buffer, evicting the oldest entry when the
 * buffer is full.
 *
 * @param buffer - The mutable ring buffer.
 * @param line - Line to append.
 * @param bufferSize - Maximum buffer capacity.
 */
function appendOutputLine(
  buffer: HarnessOutputLine[],
  line: HarnessOutputLine,
  bufferSize: number,
): void {
  buffer.push(line);
  if (buffer.length > bufferSize) {
    buffer.shift();
  }
}

/**
 * Delete a temporary prompt file, swallowing any errors.
 *
 * @param path - Absolute path to the temp file, or `null` to skip.
 */
async function cleanupTmpFile(path: string | null): Promise<void> {
  if (path === null) return;
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup — ignore ENOENT and other errors.
  }
}

/**
 * Snapshot the current state of a process entry as a {@link HarnessProcessStatus}.
 *
 * @param entry - The process tracking entry.
 * @returns Immutable status snapshot.
 *
 * @public
 */
export function buildStatus(entry: PiProcessEntry): HarnessProcessStatus {
  return {
    instanceId: entry.instanceId,
    taskId: entry.taskId,
    state: entry.state,
    pid: entry.pid,
    startedAt: entry.startedAt,
    ...(entry.endedAt !== null ? { endedAt: entry.endedAt } : {}),
    ...(entry.state === 'exited' && entry.exitCode !== null ? { exitCode: entry.exitCode } : {}),
    ...(entry.error !== null ? { error: entry.error } : {}),
  };
}

/**
 * Create a new process tracking entry for a given instance and task.
 *
 * The entry starts in a transitional `'failed'` state that will be
 * immediately overwritten by {@link PiWrapper.start} on success.
 *
 * @param instanceId - Stable instance identifier.
 * @param taskId - CLEO task ID.
 * @param resolveExit - Promise resolve callback wired to the exit promise.
 * @returns Initialised (pre-spawn) tracking entry.
 *
 * @public
 */
export function createProcessEntry(
  instanceId: string,
  taskId: string,
  resolveExit: (status: HarnessProcessStatus) => void,
): PiProcessEntry {
  return {
    pid: null,
    child: null,
    taskId,
    instanceId,
    startedAt: new Date().toISOString(),
    state: 'failed', // overwritten by start() on success
    exitCode: null,
    terminatingSignal: null,
    endedAt: null,
    error: null,
    outputBuffer: [],
    resolveExit,
    tmpFile: null,
    killTimer: null,
  };
}

// ---------------------------------------------------------------------------
// PiWrapper
// ---------------------------------------------------------------------------

/**
 * Low-level Pi process launcher.
 *
 * Manages the full lifecycle of Pi CLI processes: spawning via
 * {@link start}, output buffering into a ring buffer, and
 * SIGTERM-then-SIGKILL termination via {@link terminate}. Process state
 * is tracked in a {@link PiProcessEntry} held by the caller
 * ({@link PiCodingAgentAdapter}).
 *
 * @public
 */
export class PiWrapper {
  /**
   * Spawn a Pi CLI process for the given task.
   *
   * Writes the prompt to a temporary file in `/tmp/`, builds the argument
   * list (prepending `--extension <path>` for each available CleoOS
   * extension), and spawns Pi as a child process. Stdout and stderr are
   * line-buffered into `entry.outputBuffer`.
   *
   * When spawn fails (e.g. binary not found), `entry.state` is set to
   * `'failed'` and `entry.resolveExit` is called before returning.
   *
   * @param entry - Pre-allocated process tracking entry. Mutated in place.
   * @param prompt - Prompt text to deliver to Pi.
   * @param cwd - Working directory for the child process.
   * @param env - Environment variable overrides merged atop the current env.
   * @returns The mutated `entry` (for chaining convenience).
   *
   * @public
   */
  async start(
    entry: PiProcessEntry,
    prompt: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<PiProcessEntry> {
    const bufferSize = getOutputBufferSize();
    const binaryPath = getPiBinaryPath();

    // Write prompt to a temporary file (file-mode delivery).
    const tmpFile = `/tmp/cleo-pi-${entry.instanceId}.txt`;
    entry.tmpFile = tmpFile;
    try {
      await writeFile(tmpFile, prompt, 'utf-8');
    } catch (err) {
      entry.state = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.endedAt = new Date().toISOString();
      entry.resolveExit(buildStatus(entry));
      return entry;
    }

    // Build argument list: [--extension <path>...] <promptFile>
    const extensionPaths = resolveExtensionPaths();
    const extensionFlags = extensionPaths.flatMap((p) => ['--extension', p]);
    const args = [...extensionFlags, tmpFile];

    // Merge environment: parent env → telemetry disable → caller overrides.
    const parentEnv: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
    );
    const mergedEnv: Record<string, string> = {
      ...parentEnv,
      PI_TELEMETRY: '0', // suppress telemetry in CI/sandbox runs
      ...env,
    };

    let child: ChildProcess;
    try {
      child = spawn(binaryPath, args, {
        cwd,
        env: mergedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      entry.state = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.endedAt = new Date().toISOString();
      await cleanupTmpFile(tmpFile);
      entry.tmpFile = null;
      entry.resolveExit(buildStatus(entry));
      return entry;
    }

    entry.child = child;
    entry.pid = child.pid ?? null;
    entry.state = 'running';

    // Buffer stdout lines into the ring buffer.
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.length === 0) continue;
        appendOutputLine(
          entry.outputBuffer,
          { source: 'stdout', line, timestamp: new Date().toISOString() },
          bufferSize,
        );
      }
    });

    // Buffer stderr lines into the ring buffer.
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.length === 0) continue;
        appendOutputLine(
          entry.outputBuffer,
          { source: 'stderr', line, timestamp: new Date().toISOString() },
          bufferSize,
        );
      }
    });

    // Handle process exit.
    child.on('close', async (code, signal) => {
      if (entry.killTimer !== null) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      entry.child = null;
      entry.endedAt = new Date().toISOString();
      if (entry.state === 'running') {
        entry.state = signal !== null ? 'killed' : 'exited';
        entry.exitCode = code;
        entry.terminatingSignal = signal as NodeJS.Signals | null;
      }
      await cleanupTmpFile(entry.tmpFile);
      entry.tmpFile = null;
      entry.resolveExit(buildStatus(entry));
    });

    return entry;
  }

  /**
   * Terminate a Pi process via SIGTERM-then-SIGKILL.
   *
   * Sends SIGTERM immediately. If the process has not exited within the
   * configured grace window ({@link getTerminateGraceMs}), sends SIGKILL.
   * Idempotent — subsequent calls when the process is already dead are no-ops.
   *
   * @param entry - The process tracking entry to terminate.
   *
   * @public
   */
  terminate(entry: PiProcessEntry): void {
    if (entry.child === null || entry.state !== 'running') return;
    const graceMs = getTerminateGraceMs();
    entry.state = 'killed';
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // Process may have already exited between the state check and the signal.
    }
    entry.killTimer = setTimeout(() => {
      entry.killTimer = null;
      if (entry.child !== null) {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // Already dead — ignore.
        }
      }
    }, graceMs);
  }
}
