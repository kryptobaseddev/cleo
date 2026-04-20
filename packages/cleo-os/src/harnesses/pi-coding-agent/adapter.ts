/**
 * Pi Coding Agent Harness Adapter — cleo-os implementation.
 *
 * Implements the {@link HarnessAdapter} interface for the Pi coding agent CLI
 * (`@mariozechner/pi-coding-agent`). Provides process spawn, status, kill,
 * and output streaming for Pi processes launched by cleo-os.
 *
 * @remarks
 * This adapter is the cleo-os counterpart to the CAAMP
 * `PiSpawnProvider` in `packages/adapters/src/providers/pi/spawn.ts`.
 * Where the CAAMP spawn provider is a detached fire-and-forget launcher,
 * this adapter owns the full process lifecycle — attached stdin/stdout/stderr,
 * bounded output buffering, and structured exit promises — so it can be
 * used in orchestrated sandbox runs.
 *
 * Two launch modes are supported:
 * - **Host-native** (default): Pi is invoked directly from PATH (or via
 *   `CLEO_PI_BINARY`). This is the standard mode for local development.
 * - **Docker sandbox** (opt-in): Pi is launched inside the
 *   `cleo-sandbox/pi:local` Docker container when `CLEO_PI_SANDBOXED=1` is
 *   set or `sandboxed: true` is passed to {@link PiCodingAgentAdapter.spawn}.
 *   Falls back to host-native with a warning when Docker is unavailable.
 *
 * Instance IDs have the format `pi-<taskId>-<shortRandom>` to make
 * correlation with task records straightforward.
 *
 * @see packages/adapters/src/providers/pi/spawn.ts — CAAMP spawn provider
 * @see packages/cleo-os/src/harnesses/pi-coding-agent/pi-wrapper.ts — process management
 * @see packages/cleo-os/src/harnesses/pi-coding-agent/docker-mode.ts — sandbox mode
 * @task T922
 * @epic T911
 * @packageDocumentation
 */

import { writeFile } from 'node:fs/promises';
import { DockerModeAdapter, isSandboxedGlobally } from './docker-mode.js';
import { buildStatus, createProcessEntry, type PiProcessEntry, PiWrapper } from './pi-wrapper.js';
import type {
  HarnessAdapter,
  HarnessOutputLine,
  HarnessProcessStatus,
  HarnessSpawnOptions,
  HarnessSpawnResult,
} from './types.js';

// ---------------------------------------------------------------------------
// PiCodingAgentAdapter
// ---------------------------------------------------------------------------

/**
 * Harness adapter for the Pi coding agent CLI in the cleo-os sandbox.
 *
 * Manages a pool of Pi processes, each identified by a stable instance ID.
 * Supports host-native and Docker sandbox launch modes.
 *
 * @example
 * ```typescript
 * const adapter = new PiCodingAgentAdapter();
 * const { instanceId, exitPromise } = await adapter.spawn('T123', 'Write a hello-world script');
 * const status = await exitPromise;
 * console.log('exit code:', status.exitCode);
 * ```
 *
 * @public
 */
export class PiCodingAgentAdapter implements HarnessAdapter {
  /** Short adapter identifier. */
  readonly id = 'pi-coding-agent';

  /** Active process tracking entries keyed by instance ID. */
  private readonly processes = new Map<string, PiProcessEntry>();

  /** Low-level Pi process launcher. */
  private readonly wrapper = new PiWrapper();

  /** Docker sandbox mode adapter. */
  private readonly docker = new DockerModeAdapter();

  /**
   * Generate a stable instance ID for a spawned process.
   *
   * @param taskId - CLEO task ID.
   * @returns Instance ID string in the format `pi-<taskId>-<shortRandom>`.
   */
  private makeInstanceId(taskId: string): string {
    const rnd = Math.random().toString(36).slice(2, 9);
    return `pi-${taskId}-${rnd}`;
  }

  /**
   * Spawn a Pi coding agent process with the given task prompt.
   *
   * When `opts.sandboxed` is `true` (or `CLEO_PI_SANDBOXED=1` is set), the
   * adapter first verifies Docker readiness and delegates to
   * {@link DockerModeAdapter.spawnInDocker}. On Docker failure it falls back
   * to host-native mode with a warning to stderr.
   *
   * The returned {@link HarnessSpawnResult.exitPromise} resolves once the
   * process exits or is killed. It NEVER rejects — failures are encoded in
   * the resolved {@link HarnessProcessStatus}.
   *
   * @param taskId - Stable CLEO task identifier associated with this run.
   * @param prompt - Prompt text to pass to the Pi agent.
   * @param opts - Optional spawn configuration.
   * @returns Spawn result containing the instance ID, PID, and exit promise.
   *
   * @public
   */
  async spawn(
    taskId: string,
    prompt: string,
    opts?: HarnessSpawnOptions,
  ): Promise<HarnessSpawnResult> {
    const instanceId = this.makeInstanceId(taskId);
    const cwd = opts?.cwd ?? process.cwd();
    const env = opts?.env ?? {};
    const useSandbox = opts?.sandboxed === true || isSandboxedGlobally();

    // Build exit promise — resolved by the process entry when the child exits.
    let resolveExit!: (status: HarnessProcessStatus) => void;
    const exitPromise = new Promise<HarnessProcessStatus>((resolve) => {
      resolveExit = resolve;
    });

    const entry = createProcessEntry(instanceId, taskId, resolveExit);
    this.processes.set(instanceId, entry);

    // Wire abort signal to kill.
    if (opts?.signal !== undefined) {
      opts.signal.addEventListener('abort', () => {
        void this.kill(instanceId);
      });
    }

    if (useSandbox) {
      await this.spawnInSandbox(entry, prompt, cwd, env);
    } else {
      await this.wrapper.start(entry, prompt, cwd, env);
    }

    return {
      instanceId,
      pid: entry.pid,
      exitPromise,
    };
  }

  /**
   * Query the current status of a spawned process.
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   * @returns Current status snapshot, or `null` when the ID is not tracked.
   *
   * @public
   */
  status(instanceId: string): HarnessProcessStatus | null {
    const entry = this.processes.get(instanceId);
    if (entry === undefined) return null;
    return buildStatus(entry);
  }

  /**
   * Terminate a running Pi process via SIGTERM-then-SIGKILL.
   *
   * Idempotent — subsequent calls after the first are no-ops.
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   *
   * @public
   */
  async kill(instanceId: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (entry === undefined) return;
    this.wrapper.terminate(entry);
  }

  /**
   * Return recently captured output lines for a process.
   *
   * Returns a snapshot of the bounded ring buffer maintained by the wrapper.
   * The buffer is limited to `CLEO_HARNESS_OUTPUT_BUFFER` lines (default 500).
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   * @returns Array of recent output lines, oldest first; empty when not found.
   *
   * @public
   */
  output(instanceId: string): HarnessOutputLine[] {
    const entry = this.processes.get(instanceId);
    if (entry === undefined) return [];
    return [...entry.outputBuffer];
  }

  // ---------------------------------------------------------------------------
  // Internal — Docker sandbox path
  // ---------------------------------------------------------------------------

  /**
   * Spawn Pi inside a Docker sandbox container.
   *
   * Checks Docker readiness first. On failure, falls back to host-native
   * mode with a stderr warning. Prompt delivery and output buffering follow
   * the same pattern as the host-native path in {@link PiWrapper.start}.
   *
   * @param entry - Process tracking entry (mutated in place).
   * @param prompt - Prompt text to deliver to Pi.
   * @param cwd - Host working directory (bind-mounted into container).
   * @param env - Extra environment variable overrides.
   */
  private async spawnInSandbox(
    entry: PiProcessEntry,
    prompt: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<void> {
    const readiness = await this.docker.checkReadiness();
    if (!readiness.ready) {
      process.stderr.write(
        `[cleo-os/pi-coding-agent] Docker sandbox not ready: ${readiness.reason ?? 'unknown reason'}. Falling back to host-native mode.\n`,
      );
      await this.wrapper.start(entry, prompt, cwd, env);
      return;
    }

    // Write prompt to a host-side temp file (bind-mounted read-only into container).
    const promptFilePath = `/tmp/cleo-pi-${entry.instanceId}.txt`;
    entry.tmpFile = promptFilePath;
    try {
      await writeFile(promptFilePath, prompt, 'utf-8');
    } catch (err) {
      entry.state = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.endedAt = new Date().toISOString();
      entry.resolveExit(buildStatus(entry));
      return;
    }

    // Delegate to DockerModeAdapter which builds `docker run` args and spawns.
    const child = this.docker.spawnInDocker({
      prompt,
      cwd,
      env,
      promptFilePath,
    });

    entry.child = child;
    entry.pid = child.pid ?? null;
    entry.state = 'running';

    const bufferSize = 500; // use default; getOutputBufferSize() is in pi-wrapper.ts

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.length === 0) continue;
        entry.outputBuffer.push({ source: 'stdout', line, timestamp: new Date().toISOString() });
        if (entry.outputBuffer.length > bufferSize) entry.outputBuffer.shift();
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.length === 0) continue;
        entry.outputBuffer.push({ source: 'stderr', line, timestamp: new Date().toISOString() });
        if (entry.outputBuffer.length > bufferSize) entry.outputBuffer.shift();
      }
    });

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
      // Clean up the host-side prompt temp file.
      if (entry.tmpFile !== null) {
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(entry.tmpFile);
        } catch {
          // Best-effort.
        }
        entry.tmpFile = null;
      }
      entry.resolveExit(buildStatus(entry));
    });
  }
}
