/**
 * Lifecycle-bound registry for fire-and-forget best-effort DB writes (T10490).
 *
 * Task mutators (`addTask`, `completeTask`) kick off best-effort graph/LOOM
 * population that must NOT block or fail the mutation. Historically these were
 * orphaned `import().then().catch()` promises with no handle. Under the vitest
 * `forks` pool that creates two failure modes:
 *
 *   1. **Cross-test DB races (intermittent shard failures).** A detached op
 *      from test/file A can still be in flight when test/file B has already
 *      created a fresh fixture and reset the shared SQLite singleton
 *      (`store/sqlite.ts` `_db`/`_nativeDb`). The late write/read then lands on
 *      B's connection, corrupting B's reads — e.g. a freshly-written
 *      `pipeline_stage` reading back as null, which silently flips a
 *      forward-only transition guard.
 *   2. **`EnvironmentTeardownError: Closing rpc while onUserConsoleLog was
 *      pending`.** A detached op logging as the worker tears down races the
 *      RPC close. (The structured-logger sweep, T10490 §3.3, addresses the
 *      logging half; this registry addresses the lifetime half.)
 *
 * Registering each op here lets the test harness (and any caller that needs a
 * barrier) drain them via {@link awaitBackgroundOps} before resetting DB state.
 *
 * **Production behaviour is unchanged**: ops still run detached and nobody
 * awaits them on the hot path. The registry only adds an opt-in flush point.
 *
 * @task T10490
 * @see packages/core/src/store/__tests__/test-db-helper.ts (flush wiring)
 */

import { isAbsolute } from 'node:path';
import type {
  OperationExecutionContext,
  OperationExecutionIdentity,
  OperationExecutionOptions,
  OperationExecutionStopCode,
  OperationResourceUsage,
  OperationWaitResult,
} from '@cleocode/contracts/jobs';
import { registerTeardownAbort } from '../teardown-signal.js';

/** Promises for best-effort background work that has not yet settled. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Register a best-effort background promise so a later {@link awaitBackgroundOps}
 * can flush it. The promise is wrapped so a rejection never escapes the
 * registry (callers keep their own `.catch`); the wrapper removes itself from
 * the set once settled.
 *
 * @param op - the detached best-effort promise to track
 * @remarks Legacy tracking does not capture scope or cancel the supplied promise.
 * @example
 * ```ts
 * trackBackgroundOp(writeProjection());
 * ```
 */
export function trackBackgroundOp(op: Promise<unknown>): void {
  const tracked = Promise.resolve(op).catch(() => {
    /* Best-effort — the caller owns error handling; never reject the registry. */
  });
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
}

/**
 * Await every currently in-flight background op, then return. Safe to call
 * repeatedly and when nothing is pending. Loops until the set drains so an op
 * that schedules further tracked work during the flush is also awaited.
 * @remarks This legacy barrier can wait indefinitely on any one promise. It is
 * not the foreground maintenance budget or proof that untracked work stopped.
 * @example
 * ```ts
 * await awaitBackgroundOps();
 * ```
 */
export async function awaitBackgroundOps(): Promise<void> {
  // Bound rescheduling rounds only; a round itself can wait indefinitely.
  for (let i = 0; i < 100 && inFlight.size > 0; i++) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

/**
 * Number of background ops currently in flight. Diagnostic/test use — assert it
 * is `0` after a flush to account for the tracked subset at a test boundary.
 * @returns Number of registered, unsettled promises.
 * @remarks Unregistered work is not included in this count.
 * @example
 * ```ts
 * const pending = pendingBackgroundOpCount();
 * ```
 */
export function pendingBackgroundOpCount(): number {
  return inFlight.size;
}

/**
 * Stable refusal at a cooperating operation boundary.
 * @remarks A refusal does not roll back work already committed by another stage.
 * @example
 * ```ts
 * if (error instanceof OperationExecutionError) record(error.code);
 * ```
 */
export class OperationExecutionError extends Error {
  /** Machine-readable reason that a new stage was refused. */
  readonly code: OperationExecutionStopCode;

  /**
   * Construct a boundary refusal.
   * @param code - Stable cancellation/deadline/limit reason.
   * @param message - Specific diagnostic for the caller.
   */
  constructor(code: OperationExecutionStopCode, message: string) {
    super(message);
    this.name = 'OperationExecutionError';
    this.code = code;
  }
}

/**
 * Capture one immutable scope and cooperative foreground lifetime.
 * @param identity - Explicit routing and caller identity, captured before awaiting.
 * @param options - Shared deadline, caller cancellation and admission limits.
 * @returns One context to pass unchanged through nested stages; close it in finally.
 * @remarks The timer requests cancellation; boundary checks independently inspect
 * wall time. Neither can preempt synchronous work. Resource limits count declared
 * bytes/items, not actual process memory. This creates no executor or background job.
 * @example
 * ```ts
 * const context = createOperationExecutionContext(identity, { budgetMs: 2000 });
 * try { context.assertActive(); await inspect(context); }
 * finally { context.close(); }
 * ```
 */
export function createOperationExecutionContext(
  identity: OperationExecutionIdentity,
  options: OperationExecutionOptions = {},
): OperationExecutionContext {
  for (const key of ['projectId', 'projectRoot', 'actor', 'operation', 'idempotencyKey'] as const) {
    const value = identity[key];
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new TypeError(`Operation ${key} must be a nonempty string`);
  }
  if (!isAbsolute(identity.projectRoot))
    throw new TypeError('Operation projectRoot must be absolute');
  const budgetMs = options.budgetMs ?? 2000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0)
    throw new TypeError('Operation budgetMs must be a nonnegative safe integer');
  if (options.deadlineAt !== undefined && !Number.isSafeInteger(options.deadlineAt))
    throw new TypeError('Operation deadlineAt must be a safe integer');
  const resources = Object.freeze({ ...options.resources });
  for (const value of Object.values(resources)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TypeError('Operation resource limits must be nonnegative safe integers');
  }
  const deadlineAt = Math.min(Date.now() + budgetMs, options.deadlineAt ?? Infinity);
  if (!Number.isSafeInteger(deadlineAt))
    throw new TypeError('Operation deadline exceeds safe range');
  const callerSignal = options.signal;
  const controller = new AbortController();
  let bytes = 0;
  let items = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (code: OperationExecutionStopCode, message: string) => {
    if (!controller.signal.aborted) controller.abort(new OperationExecutionError(code, message));
  };
  const cancel = () => stop('E_OPERATION_CANCELLED', 'Operation cancelled by its caller');
  const expire = () => stop('E_OPERATION_DEADLINE', 'Shared operation deadline reached');
  const remainingMs = () => {
    const remaining = Math.max(0, deadlineAt - Date.now());
    if (remaining === 0) expire();
    return remaining;
  };
  const assertActive = () => {
    if (closed)
      throw new OperationExecutionError('E_OPERATION_CLOSED', 'Operation scope is closed');
    remainingMs();
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof OperationExecutionError
        ? reason
        : new OperationExecutionError(
            'E_OPERATION_CANCELLED',
            'Operation cancelled during teardown',
          );
    }
  };
  const consume = (usage: OperationResourceUsage) => {
    assertActive();
    const addBytes = usage.bytes ?? 0;
    const addItems = usage.items ?? 0;
    if (
      !Number.isSafeInteger(addBytes) ||
      addBytes < 0 ||
      !Number.isSafeInteger(addItems) ||
      addItems < 0
    )
      throw new TypeError('Operation resource usage must be nonnegative safe integers');
    const nextBytes = bytes + addBytes;
    const nextItems = items + addItems;
    if (
      !Number.isSafeInteger(nextBytes) ||
      !Number.isSafeInteger(nextItems) ||
      nextBytes > (resources.maxBytes ?? Infinity) ||
      nextItems > (resources.maxItems ?? Infinity)
    ) {
      stop('E_OPERATION_RESOURCE_LIMIT', 'Operation resource admission limit exceeded');
      assertActive();
    }
    bytes = nextBytes;
    items = nextItems;
  };
  const deregister = registerTeardownAbort(controller);
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  // setTimeout cannot represent arbitrary long deadlines. Recheck instead of
  // allowing overflow to cancel a long-lived explicitly bounded invocation early.
  const schedule = () => {
    const remaining = remainingMs();
    if (remaining > 0 && !controller.signal.aborted && !closed) {
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
      timer.unref();
    }
  };
  schedule();
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    deadlineAt,
    signal: controller.signal,
    resources,
    remainingMs,
    assertActive,
    consume,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
      deregister();
      stop('E_OPERATION_CLOSED', 'Operation scope is closed');
    },
  });
}

/**
 * Observe supplied work until it settles or the shared scope is cancelled.
 * @typeParam T - Supplied promise's result type.
 * @param context - Existing operation context; this does not start a new budget.
 * @param work - Already accepted work whose outcome is being observed.
 * @returns Actual settlement or an explicit unresolved observation, never fake cancellation.
 * @remarks The underlying promise may continue. Its rejection remains handled,
 * but preventing later writes requires guarded executor/chokepoint boundaries.
 * A synchronous overrun is reported after returning control, not called preemption.
 * @example
 * ```ts
 * const observed = await observeOperation(context, verification);
 * if (!observed.settled) reportPending(operationId);
 * ```
 */
export function observeOperation<T>(
  context: OperationExecutionContext,
  work: Promise<T>,
): Promise<OperationWaitResult<T>> {
  return new Promise((resolve) => {
    let observed = false;
    const finish = (result: OperationWaitResult<T>) => {
      if (observed) return;
      observed = true;
      context.signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => {
      const reason = context.signal.reason;
      finish({
        settled: false,
        reason: reason instanceof OperationExecutionError ? reason.code : 'E_OPERATION_CANCELLED',
        deadlineExceeded: Date.now() >= context.deadlineAt,
      });
    };
    void work.then(
      (value) =>
        finish({
          settled: true,
          success: true,
          value,
          deadlineExceeded: Date.now() >= context.deadlineAt,
        }),
      (error) =>
        finish({
          settled: true,
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
          deadlineExceeded: Date.now() >= context.deadlineAt,
        }),
    );
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
  });
}
