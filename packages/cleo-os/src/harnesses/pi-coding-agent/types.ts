/**
 * HarnessAdapter type contract for cleo-os sandbox harnesses.
 *
 * Defines the minimal surface a cleo-os harness adapter must expose for
 * controlling a process lifecycle: spawn, status, kill, and output streaming.
 * This interface is intentionally simpler than the full CAAMP
 * {@link packages/caamp | Harness} contract — cleo-os adapters wrap an
 * external agent binary rather than a first-class CAAMP provider.
 *
 * @remarks
 * cleo-os harness adapters follow the OpenClaw sandbox pattern: a thin
 * TypeScript wrapper that controls an external binary (Pi, Claude Code, etc.)
 * inside either a host-native or Docker sandbox environment.
 *
 * @see ADR-049 — CleoOS Sovereignty Invariants
 * @see ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter
 * @packageDocumentation
 */

/**
 * Lifecycle state of a spawned harness process.
 *
 * - `'running'` — process was started and has not yet exited.
 * - `'exited'` — process exited normally (exit code may be non-zero).
 * - `'killed'` — process was terminated via {@link HarnessAdapter.kill}.
 * - `'failed'` — process could not be started (pre-spawn error).
 *
 * @public
 */
export type HarnessProcessState = 'running' | 'exited' | 'killed' | 'failed';

/**
 * Describes a running or completed harness process.
 *
 * @public
 */
export interface HarnessProcessStatus {
  /** Stable identifier for this process instance. */
  instanceId: string;
  /** Task ID associated with this process. */
  taskId: string;
  /** Current lifecycle state. */
  state: HarnessProcessState;
  /** OS process ID, or `null` when the process could not be started. */
  pid: number | null;
  /** ISO-8601 timestamp when the process was spawned. */
  startedAt: string;
  /**
   * ISO-8601 timestamp when the process ended.
   * Only populated when `state` is `'exited'` or `'killed'`.
   * @defaultValue undefined
   */
  endedAt?: string;
  /**
   * Exit code from the process.
   * Only populated when `state` is `'exited'`.
   * @defaultValue undefined
   */
  exitCode?: number | null;
  /**
   * Error message when `state` is `'failed'`.
   * @defaultValue undefined
   */
  error?: string;
}

/**
 * A single line of output emitted from a harness process.
 *
 * @public
 */
export interface HarnessOutputLine {
  /** Source stream: stdout or stderr. */
  source: 'stdout' | 'stderr';
  /** The text content of this line (without trailing newline). */
  line: string;
  /** ISO-8601 timestamp when this line was captured. */
  timestamp: string;
}

/**
 * Options passed to {@link HarnessAdapter.spawn}.
 *
 * @public
 */
export interface HarnessSpawnOptions {
  /**
   * Working directory for the spawned process.
   * @defaultValue `process.cwd()`
   */
  cwd?: string;
  /**
   * Environment variable overrides merged atop the current process environment.
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * When `true`, run the process inside a Docker sandbox container instead of
   * host-native. Requires `CLEO_PI_SANDBOXED=1` or explicit `sandboxed: true`.
   * @defaultValue false
   */
  sandboxed?: boolean;
  /**
   * Abort signal. When it fires, the adapter terminates the process via
   * SIGTERM-then-SIGKILL with the configured grace window.
   * @defaultValue undefined
   */
  signal?: AbortSignal;
}

/**
 * Result returned synchronously from {@link HarnessAdapter.spawn}.
 *
 * @public
 */
export interface HarnessSpawnResult {
  /** Stable instance identifier (can be passed to status/kill/output). */
  instanceId: string;
  /** OS process ID, or `null` on failure. */
  pid: number | null;
  /** Promise resolving once the process exits or is killed. */
  exitPromise: Promise<HarnessProcessStatus>;
}

/**
 * Contract every cleo-os harness adapter MUST implement.
 *
 * @remarks
 * A harness adapter wraps one external agent binary and exposes a uniform
 * lifecycle surface. The adapter is responsible for:
 *
 * - Writing the prompt to the correct location (temp file or stdin).
 * - Launching the external binary with the right flags and environment.
 * - Optionally routing the launch through a Docker sandbox container
 *   (see {@link HarnessSpawnOptions.sandboxed}).
 * - Buffering recent output lines for post-mortem diagnostics.
 * - Terminating processes cleanly via SIGTERM-then-SIGKILL.
 *
 * @example
 * ```typescript
 * const adapter = new PiCodingAgentAdapter();
 * const { instanceId, exitPromise } = await adapter.spawn('T123', 'Implement the feature', { cwd: '/project' });
 * const status = await exitPromise;
 * console.log(status.exitCode);
 * ```
 *
 * @public
 */
export interface HarnessAdapter {
  /** Short adapter identifier (e.g. `"pi-coding-agent"`). */
  readonly id: string;

  /**
   * Spawn the agent binary with the given task prompt.
   *
   * @param taskId - Stable CLEO task identifier associated with this run.
   * @param prompt - Prompt / instruction text to pass to the agent.
   * @param opts - Spawn options (cwd, env, sandboxed, signal).
   * @returns Spawn result containing the instance ID and exit promise.
   */
  spawn(taskId: string, prompt: string, opts?: HarnessSpawnOptions): Promise<HarnessSpawnResult>;

  /**
   * Query the current status of a spawned process.
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   * @returns Current status, or `null` when the ID is not tracked.
   */
  status(instanceId: string): HarnessProcessStatus | null;

  /**
   * Terminate a running process.
   *
   * Sends SIGTERM, waits for the configured grace window (`CLEO_TERMINATE_GRACE_MS`
   * or 5000 ms), then sends SIGKILL when the process has not yet exited.
   * Idempotent — subsequent calls after the first are no-ops.
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   */
  kill(instanceId: string): Promise<void>;

  /**
   * Return recently captured output lines for a process.
   *
   * The adapter keeps a bounded ring buffer of the last
   * `CLEO_HARNESS_OUTPUT_BUFFER` (default: 500) lines. Useful for
   * post-mortem diagnostics without injecting output into the parent
   * LLM context.
   *
   * @param instanceId - Instance ID returned from {@link spawn}.
   * @returns Array of recent output lines, oldest first.
   */
  output(instanceId: string): HarnessOutputLine[];
}
