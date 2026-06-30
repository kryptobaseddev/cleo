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
