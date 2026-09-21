/**
 * Resource Governor — shared types for the Never-OOM admission layer.
 *
 * The {@link ResourceGovernor} (in `@cleocode/core`) admits resource-intensive
 * work through priority classes whose budgets are computed from host memory and
 * memory-pressure (PSI). A denial returns a structured, retryable
 * {@link ResourceDeferral} (code {@link RESOURCE_DEFERRED_CODE}) rather than a
 * silent drop or a crash — orchestrators treat it like a lifecycle gate: wait
 * and retry, never fail the task.
 *
 * Mirrors the llm-queue deferral contract (`retry_after_ms`, degrade-to-direct)
 * so the two admission surfaces share one shape.
 *
 * @task T11999
 * @epic T11992
 * @adr resource-governor-never-oom-architecture §3.4
 */

import type { OperationExecutionContext } from './jobs.js';

/**
 * Governor arbitration mode. Mirrors the writer-lease mode shape
 * (`writer-lease.ts` {@link LeaseMode}).
 *
 * - `supervisor` — defer to the Rust `cleo-supervisor` `resource_admit` verb
 *   (continuous PSI, priority wakeups). Demotes to `local` when the supervisor
 *   IPC client is not wired/reachable (never deadlocks).
 * - `local` — DEFAULT. Daemon-off arbitration through shared per-class slot
 *   directories (proper-lockfile crash-stale auto-release) + a point-sample of
 *   {@link ResourceSample} taken inside `acquire`. Genuinely cross-process
 *   without a daemon, mirroring the tool-semaphore engine.
 * - `off` — pure pass-through; every acquire is granted immediately.
 */
export type GovernorMode = 'supervisor' | 'local' | 'off';

/**
 * Priority classes (highest priority first). `interactive-cli` is NEVER gated;
 * `full-build` is pinned to one machine-wide slot regardless of pressure.
 *
 * @adr resource-governor-never-oom-architecture §3.4 (classes)
 */
export type ResourceClass =
  | 'interactive-cli'
  | 'agent-session'
  | 'llm-call'
  | 'test-run'
  | 'scoped-build'
  | 'full-build'
  | 'db-heavy'
  | 'background-autonomous';

/**
 * All resource classes in descending priority order. Single source of truth for
 * iteration + validation.
 */
export const RESOURCE_CLASSES: readonly ResourceClass[] = Object.freeze([
  'interactive-cli',
  'agent-session',
  'llm-call',
  'test-run',
  'scoped-build',
  'full-build',
  'db-heavy',
  'background-autonomous',
]);

/** Error code emitted when an acquire is denied because no slot is available. */
export const RESOURCE_DEFERRED_CODE = 'E_RESOURCE_DEFERRED' as const;

/**
 * Soft-signal code raised on the next admit when the host enters `backoff` —
 * asks granted work to checkpoint. Existing grants are NEVER revoked.
 */
export const RESOURCE_BACKPRESSURE_CODE = 'E_RESOURCE_BACKPRESSURE' as const;

/**
 * Structured, retryable deferral returned when admission is denied. Never a
 * silent drop; callers back off `retryAfterMs` and re-request, or annotate the
 * unit as deferred and let a pull-based retry pick it up.
 */
export interface ResourceDeferral {
  /** Discriminant for narrowing against the success grant. */
  readonly deferred: true;
  /** The class whose budget was exhausted. */
  readonly class: ResourceClass;
  /** Suggested back-off before re-requesting, in milliseconds. */
  readonly retryAfterMs: number;
  /** Human-readable reason (pressure state, budget, held count). */
  readonly reason: string;
}

/**
 * A granted admission slot. Hold it for the lifetime of the work, then
 * {@link ResourceGrant.release}. Releasing reaps the slot so the next acquirer
 * can proceed; releasing twice is a no-op.
 */
export interface ResourceGrant {
  /** Discriminant for narrowing against {@link ResourceDeferral}. */
  readonly deferred: false;
  /** The class this grant belongs to. */
  readonly class: ResourceClass;
  /**
   * Slot index held (local mode), or `-1` for an ungated pass-through grant
   * (`interactive-cli`, `off` mode, or an unbounded budget).
   */
  readonly slot: number;
  /** Monotonic timestamp (ms) when the grant was acquired. */
  readonly acquiredAtMs: number;
  /** Release the slot. Idempotent. */
  release(): Promise<void>;
}

/** Discriminated union returned by a non-blocking `tryAcquire`. */
export type AdmissionResult = ResourceGrant | ResourceDeferral;

/**
 * Default back-off hint when a class is saturated, in milliseconds. Aligned
 * with the llm-queue `DEFAULT_ADMIT_DEADLINE_MS` so the two surfaces agree.
 */
export const DEFAULT_RESOURCE_RETRY_AFTER_MS = 2_000;

/** Type guard: did an admission attempt produce a usable grant? */
export function isResourceGrant(r: AdmissionResult): r is ResourceGrant {
  return r.deferred === false;
}

/** Explicit local user-manager connection for resource-controlled process launch. */
export interface SystemdControlContext {
  /** Absolute existing runtime directory used only by the manager probe and launcher. */
  runtimeDirectory: string;
  /**
   * Optional local Unix bus address.
   * @defaultValue The bus socket in runtimeDirectory.
   */
  busAddress?: string;
}

/** Original execution deadline and optional cancellation observed at process-launch boundaries. */
export type ProcessLaunchExecution = Pick<OperationExecutionContext, 'deadlineAt'> &
  Partial<Pick<OperationExecutionContext, 'signal'>>;

/**
 * Captured inputs for a bounded process invocation; environment is copied before launch.
 * @remarks The original absolute deadline covers launcher discovery and target execution;
 * bounded cleanup may finish later. No caller environment is implicitly merged.
 * @example
 * ```typescript
 * const options: ProcessCaptureOptions = { cwd: '/project', env: {}, execution: { deadlineAt: Date.now() + 2000 } };
 * ```
 */
export interface ProcessCaptureOptions {
  /** Explicit working directory for the requested executable. */
  readonly cwd: string;
  /** Explicit child environment; caller credentials are not added implicitly. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Original shared deadline and cancellation, never reset between gates. */
  readonly execution: ProcessLaunchExecution;
  /** Aggregate stdout/stderr byte limit; exceeding it stops execution without a verdict. */
  readonly maxOutputBytes?: number;
  /** Requested hard native-memory ceiling in MiB; target admission requires observed cgroup enforcement. */
  readonly memoryMaxMb?: number;
  /** Requested kernel task ceiling (processes and threads); target admission requires observed cgroup enforcement. */
  readonly tasksMax?: number;
  /** Existing manager connection used only for launcher/control operations. */
  readonly systemdControl?: SystemdControlContext;
}

/**
 * Why capture stopped without a complete target verdict.
 * @remarks Cancellation, deadline and malformed transport are not target test failures.
 * @example
 * ```typescript
 * const stopped: ProcessCaptureStop = 'deadline';
 * ```
 */
export type ProcessCaptureStop =
  | 'deadline'
  | 'cancelled'
  | 'teardown'
  | 'output-limit'
  | 'resource-limit'
  | 'transport-error';

/**
 * Kernel limits observed inside the owned cgroup before target admission.
 * @remarks Values describe the capture scope, including its transport and descendants.
 * They are observations at admission, not protection against later privileged reconfiguration.
 * Null means the corresponding cgroup file contains an unlimited value.
 * @example
 * ```typescript
 * const bounded = result.resourceLimits?.memoryMaxBytes === 4096 * 1024 * 1024;
 * ```
 */
export interface ProcessCaptureResourceObservation {
  /** Exact unified cgroup path containing the capture transport. */
  readonly cgroup: string;
  /** Observed memory.max bytes, or null when no finite ceiling was observed. */
  readonly memoryMaxBytes: number | null;
  /** Observed pids.max, counting kernel tasks including threads, or null. */
  readonly tasksMax: number | null;
}

/**
 * Observed target result, kept separate from wrapper and cleanup outcomes.
 * @remarks A numeric exit alone is insufficient: started, stop/error and output completeness
 * must also be checked. Cleanup scope does not cover descendants deliberately escaping it.
 * @example
 * ```typescript
 * const completed = result.started && result.stopped === null && result.error === null;
 * ```
 */
export interface ProcessCaptureResult {
  /** True only after the transport observed the requested executable's spawn event. */
  readonly started: boolean;
  /** Requested executable PID when observed; distinct from the scope launcher. */
  readonly targetPid: number | null;
  /** Actual target close code, never synthesized from a wrapper or launch error. */
  readonly exitCode: number | null;
  /** Actual target terminating signal, if reported before transport termination. */
  readonly signal: string | null;
  /** Missing executable, permission or transport failure diagnostic. */
  readonly error: string | null;
  /** Original stop condition; stopped executions cannot establish a passing verdict. */
  readonly stopped: ProcessCaptureStop | null;
  /** Bounded UTF-8 standard output. */
  readonly stdout: string;
  /** Bounded UTF-8 standard error. */
  readonly stderr: string;
  /** Whether output exceeded the capture limit. */
  readonly outputTruncated: boolean;
  /** Total wall time including cleanup, which may exceed the execution deadline. */
  readonly durationMs: number;
  /** Actual selected launcher mode; does not establish observed memory containment. */
  readonly mode: 'systemd' | 'pgid';
  /** Exact scope name, where the launcher selected systemd. */
  readonly unitName?: string;
  /** Only a finite kernel ceiling observed inside the exact owned scope establishes this claim. */
  readonly nativeMemory: 'unverified' | 'observed-cgroup';
  /** Present only after validated pre-target observation of requested hard limits. */
  readonly resourceLimits?: ProcessCaptureResourceObservation;
  /** POSIX group cleanup covers members, not descendants that deliberately escape it. */
  readonly cleanupScope: 'process-group' | 'direct-child';
  /** Returned only after the owned transport emitted close; not a claim about escaped descendants. */
  readonly transportClosed: true;
  /** Whether the transport observed the requested target close before stopping. */
  readonly targetCloseObserved: boolean;
  /** Exact observed cleanup evidence, distinct from mere absence of an error. */
  readonly cleanupObservation:
    | 'scope-terminal'
    | 'process-group-absent'
    | 'process-group-signalled'
    | 'unverified';
  /** Cleanup failures remain visible; no successful cleanup claim is inferred from exit. */
  readonly cleanupErrors: readonly string[];
}
