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

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  BackgroundJobWriteFence,
  OperationExecutionContext,
  OperationExecutionIdentity,
  OperationExecutionOptions,
  OperationExecutionStopCode,
  OperationExecutionTransfer,
  OperationExecutionTransferHandle,
  OperationResourceUsage,
  OperationWaitResult,
} from '@cleocode/contracts/jobs';
import { registerTeardownAbort } from '../teardown-signal.js';

/** Completion promises for best-effort background work that has not yet settled.
 *  Each resolves with its producer's settled result and never rejects, so the
 *  drain barrier can assess producers instead of only observing settlement. */
const inFlight = new Set<Promise<PromiseSettledResult<void>>>();

/** How one tracked producer ended, recorded when it settles (T12310). */
type ProducerDisposition = 'fulfilled' | 'failed' | 'cancelled' | 'discarded';

/** Producer results recorded since the last drain consumed them.
 *  Assessment happens at settle time, not by polling {@link inFlight}: a
 *  descendant registered and settled inside one drain round is gone from the
 *  registry before the next round can see it, and a producer that failed long
 *  before teardown never appears there at all. */
let producerLedger: Record<ProducerDisposition, number> = {
  fulfilled: 0,
  failed: 0,
  cancelled: 0,
  discarded: 0,
};

/** Record one producer's disposition for the next drain to report. */
function recordProducerOutcome(disposition: ProducerDisposition): void {
  producerLedger[disposition] += 1;
}

/** Work staged by an existing SQLite transaction, before its actual commit. */
interface DeferredBackgroundOperation {
  start(): void;
  discard(error: Error): void;
}

/** Lexical commit boundary; this owns no database or executor. */
interface BackgroundCommitBoundary {
  native: DatabaseSync;
  execution?: OperationExecutionContext;
  schedule?: (work: () => Promise<unknown>) => Promise<unknown>;
  parent?: BackgroundCommitBoundary;
  active: boolean;
  rollback?: Error;
  deferred: DeferredBackgroundOperation[];
}
const backgroundCommitBoundary = new AsyncLocalStorage<BackgroundCommitBoundary>();

/**
 * Stage lazy effects until the supplied transaction has actually committed.
 * @typeParam T - Committed transaction result.
 * @param native - Existing writer handle whose nested savepoints share this boundary.
 * @param commit - Existing transaction implementation, including commit or rollback.
 * @param execution - Existing captured budget; never replaced with a fresh context.
 * @param schedule - Existing writer queue admission for committed effects.
 * @returns The original committed result; deferred failures never undo it.
 * @remarks Call around the actual transaction, not an individual row write. Nested
 * successful savepoints transfer effects to their parent; rollback discards them.
 * This adds no deadline and never executes eager promises again.
 * @example
 * ```ts
 * await withBackgroundOpCommitBoundary(native, () => executeTransaction());
 * ```
 */
export async function withBackgroundOpCommitBoundary<T>(
  native: DatabaseSync,
  commit: () => Promise<T>,
  execution?: OperationExecutionContext,
  schedule?: (work: () => Promise<unknown>) => Promise<unknown>,
): Promise<T> {
  const inherited = backgroundCommitBoundary.getStore();
  const parent = inherited?.active && inherited.native === native ? inherited : undefined;
  const boundary: BackgroundCommitBoundary = {
    native,
    execution: execution ?? parent?.execution,
    schedule: schedule ?? parent?.schedule,
    parent,
    active: true,
    deferred: [],
  };
  try {
    const result = await backgroundCommitBoundary.run(boundary, commit);
    boundary.active = false;
    if (parent) parent.deferred.push(...boundary.deferred);
    else for (const operation of boundary.deferred) operation.start();
    return result;
  } catch (error) {
    boundary.active = false;
    boundary.rollback = new Error(
      'Background operation discarded because its transaction rolled back',
      { cause: error },
    );
    for (const operation of boundary.deferred) operation.discard(boundary.rollback);
    throw error;
  }
}

/**
 * Track an eager legacy promise or defer a lazy effect until outer transaction commit.
 * @param op - Existing promise, or lazy operation that must not run before commit.
 * @param execution - Optional original budget, otherwise inherited from the transaction.
 * @returns An inspectable settled result, including rollback, cancellation and failures.
 * @remarks Lazy work retains captured async context and the original execution budget.
 * The registry counts staged work as pending. Eager promises have already started
 * and cannot gain rollback safety. Results are process-local, not durable job receipts.
 * @example
 * ```ts
 * const outcome = trackBackgroundOp(() => writeProjection());
 * const result = await outcome;
 * ```
 */
export function trackBackgroundOp(
  op: Promise<unknown> | (() => Promise<unknown>),
  execution?: OperationExecutionContext,
): Promise<PromiseSettledResult<void>> {
  const completion = Promise.withResolvers<PromiseSettledResult<void>>();
  const tracked = completion.promise;
  inFlight.add(tracked);
  void tracked.then(() => inFlight.delete(tracked));
  const settle = (work: Promise<unknown>): void => {
    void work.then(
      () => {
        recordProducerOutcome('fulfilled');
        completion.resolve({ status: 'fulfilled', value: undefined });
      },
      (reason: Error) => {
        // Teardown stops an in-flight producer by design; that is abandonment,
        // not a failure the caller can act on (T12310).
        recordProducerOutcome(isExpectedTeardownRejection(reason) ? 'cancelled' : 'failed');
        completion.resolve({ status: 'rejected', reason });
      },
    );
  };
  if (typeof op !== 'function') {
    settle(op);
    return tracked;
  }
  const resume = AsyncLocalStorage.snapshot();
  const capturedBoundary = backgroundCommitBoundary.getStore();
  const capturedExecution = execution ?? capturedBoundary?.execution;
  const schedule = capturedBoundary?.schedule;
  let started = false;
  const operation: DeferredBackgroundOperation = {
    start() {
      if (started) return;
      started = true;
      settle(
        Promise.resolve().then(() =>
          resume(() => {
            capturedExecution?.assertActive();
            const invoke = async (): Promise<unknown> => {
              capturedExecution?.assertActive();
              return op();
            };
            return schedule ? schedule(invoke) : invoke();
          }),
        ),
      );
    },
    discard(error) {
      if (started) return;
      started = true;
      // Never ran: its transaction rolled back, and that rollback is already
      // the caller's own result. Not a background failure to disclose again.
      recordProducerOutcome('discarded');
      completion.resolve({ status: 'rejected', reason: error });
    },
  };
  let boundary = backgroundCommitBoundary.getStore();
  while (boundary && !boundary.active) {
    if (boundary.rollback) {
      operation.discard(boundary.rollback);
      return tracked;
    }
    boundary = boundary.parent;
  }
  if (boundary) boundary.deferred.push(operation);
  else operation.start();
  return tracked;
}

/**
 * What the drain barrier actually observed about the producers it awaited.
 *
 * Settlement alone never established producer success, which is why the
 * shutdown receipt used to disclose every drain as `unassessed`. The registry
 * stores each producer's own settled result, so the barrier can assess them
 * and report a number instead of a caveat (T12310).
 */
export interface BackgroundDrainReport {
  /** Tracked producers assessed since the previous drain consumed the ledger.
   *  Untracked work is not included. */
  readonly observed: number;
  /** Producers that completed their own work. */
  readonly fulfilled: number;
  /** Producers that rejected for a reason other than an expected lifecycle stop. */
  readonly failed: number;
  /** Producers stopped by teardown cancellation, scope closure or deadline,
   *  not by their own failure. */
  readonly cancelled: number;
  /** Staged producers never started because their transaction rolled back. */
  readonly discarded: number;
}

/**
 * Whether a producer rejection is an expected teardown outcome rather than a failure.
 *
 * Teardown cancels registered execution contexts before it drains them, so a
 * best-effort producer that was still in flight rejects with a lifecycle code.
 * That is the shutdown path working as designed: the work was abandoned, not
 * attempted and failed, and the caller has nothing to act on.
 *
 * @param reason - The rejection reason observed from a tracked producer.
 * @returns `true` for cancellation, scope closure and deadline expiry.
 * @remarks An expected stop still means the work did not happen; it is silent
 * because it is not actionable, never because it succeeded.
 * @example
 * ```ts
 * if (!isExpectedTeardownRejection(error)) reportFailure(error);
 * ```
 */
export function isExpectedTeardownRejection(reason: unknown): boolean {
  return (
    reason instanceof OperationExecutionError &&
    (reason.code === 'E_OPERATION_CANCELLED' ||
      reason.code === 'E_OPERATION_CLOSED' ||
      reason.code === 'E_OPERATION_DEADLINE')
  );
}

/**
 * Await every currently in-flight background op, then report what they did.
 * Safe to call repeatedly and when nothing is pending. Loops until the set
 * drains so an op that schedules further tracked work during the flush is also
 * awaited.
 * @returns Counts for every tracked producer assessed since the previous drain.
 * @remarks This legacy barrier can wait indefinitely on any one promise. It is
 * not the foreground maintenance budget or proof that untracked work stopped.
 * The counts describe only the tracked subset and are CONSUMED by this call, so
 * two drains never report the same producer twice; a zero `observed` means no
 * tracked producer settled since the last drain, not that none exists.
 * @example
 * ```ts
 * const report = await awaitBackgroundOps();
 * if (report.failed > 0) disclose(report.failed);
 * ```
 */
export async function awaitBackgroundOps(): Promise<BackgroundDrainReport> {
  if (backgroundCommitBoundary.getStore()?.active) {
    throw new Error('Cannot drain background work before its transaction commits');
  }
  // Bound rescheduling rounds only; a round itself can wait indefinitely.
  for (let i = 0; i < 100 && inFlight.size > 0; i++) {
    await Promise.allSettled(Array.from(inFlight));
  }
  const ledger = producerLedger;
  producerLedger = { fulfilled: 0, failed: 0, cancelled: 0, discarded: 0 };
  return {
    observed: ledger.fulfilled + ledger.failed + ledger.cancelled + ledger.discarded,
    fulfilled: ledger.fulfilled,
    failed: ledger.failed,
    cancelled: ledger.cancelled,
    discarded: ledger.discarded,
  };
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
  const writeFence = captureWriteFence(options.writeFence);
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
    ...(writeFence ? { writeFence } : {}),
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

/** Copy and validate an optional authority reference without admitting work. */
function captureWriteFence(input?: BackgroundJobWriteFence): BackgroundJobWriteFence | undefined {
  const writeFence = input
    ? Object.freeze({
        ...input,
        lease: Object.freeze({ ...input.lease }),
      })
    : undefined;
  if (
    writeFence &&
    (!isAbsolute(writeFence.dbPath) ||
      !/^[a-f0-9]{64}$/.test(writeFence.proposalHash) ||
      !writeFence.lease.jobId?.trim() ||
      !writeFence.lease.ownerId?.trim() ||
      !Number.isSafeInteger(writeFence.lease.epoch) ||
      writeFence.lease.epoch < 1 ||
      !Number.isSafeInteger(writeFence.lease.expiresAt) ||
      writeFence.lease.expiresAt <= 0)
  )
    throw new TypeError('Invalid operation write fence');
  return writeFence;
}

/**
 * Bind a newly claimed job fence without replacing the caller's lifetime or budget.
 * @param context - Original captured operation whose accounting remains authoritative.
 * @param writeFence - Persisted attempt reference to check at domain write boundaries.
 * @param allowCancelledOutcome - Permit an already cancelled scope solely for bounded outcome bookkeeping.
 * @returns Immutable scoped view sharing the original deadline, cancellation and accounting.
 * @throws Error if the scope is inactive, already fenced, or the reference is malformed.
 * @remarks This does not renew a lease or authorize mutation. Binding changes only
 * the immutable authority reference; closing either view invalidates both. The
 * outcome option requires an aborted signal and remaining deadline/lease time,
 * preserves the original failing domain guards, and does not prove persisted ownership.
 * @example
 * ```ts
 * const guarded = bindOperationWriteFence(context, fence);
 * await existingDomainOperation(guarded);
 * ```
 */
export function bindOperationWriteFence(
  context: OperationExecutionContext,
  writeFence: BackgroundJobWriteFence,
  allowCancelledOutcome = false,
): OperationExecutionContext {
  if (typeof allowCancelledOutcome !== 'boolean')
    throw new TypeError('Outcome binding requires an explicit boolean');
  if (context.writeFence) throw new Error('Operation already has an immutable write fence');
  const captured = captureWriteFence(writeFence);
  if (!captured) throw new TypeError('A claimed operation write fence is required');
  if (allowCancelledOutcome) {
    if (Date.now() >= context.deadlineAt)
      throw new OperationExecutionError('E_OPERATION_DEADLINE', 'Outcome binding deadline elapsed');
    if (!context.signal.aborted)
      throw new TypeError('Outcome-only binding requires an already cancelled operation');
    if (captured.lease.expiresAt <= Date.now())
      throw new TypeError('Outcome binding lease reference expired');
  } else context.assertActive();
  return Object.freeze({ ...context, writeFence: captured });
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

/**
 * Reserve a worker stage in the original resource budget and link cancellation.
 * @param context - Origin-owned operation context.
 * @param usage - Complete declared stage admission charged before the transfer exists.
 * @returns Structured-cloneable scope and listener cleanup owned by the originating caller.
 * @remarks The shared flag is cooperative evidence, not synchronous preemption or
 * permission to write. Executors still validate domain fences at the commit boundary.
 * Release only after observing actual completion or explicitly reporting unresolved work.
 * @example
 * ```ts
 * const usage = { bytes: payloadBytes, items: 1 };
 * const link = transferOperationContext(context, usage);
 * try { await existingWorker.enqueue(link.transfer); } finally { link.release(); }
 * ```
 */
export function transferOperationContext(
  context: OperationExecutionContext,
  usage: OperationResourceUsage,
): OperationExecutionTransferHandle {
  context.consume(usage);
  const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(cancellation);
  const cancel = () => {
    Atomics.store(state, 0, 1);
  };
  context.signal.addEventListener('abort', cancel, { once: true });
  if (context.signal.aborted) cancel();
  return Object.freeze({
    transfer: Object.freeze({
      identity: context.identity,
      ...(context.writeFence ? { writeFence: context.writeFence } : {}),
      deadlineAt: context.deadlineAt,
      cancellation,
    }),
    release: () => {
      cancel();
      context.signal.removeEventListener('abort', cancel);
    },
  });
}

/**
 * Receive an admitted worker scope without granting another resource budget.
 * @param transfer - Serialized identity/deadline plus the origin-owned cancellation flag.
 * @returns Cooperating worker context with no additional byte/item admission allowance.
 * @throws TypeError - Malformed shared cancellation storage or identity/deadline.
 * @remarks The origin must reserve the complete stage before sending it. Positive
 * receiver resource charges refuse rather than reset the original aggregate limits.
 * A busy worker observes cancellation when it next checks a boundary; a committed
 * result must still be reported as committed if cancellation arrives afterwards.
 * @example
 * ```ts
 * const context = receiveOperationContext(envelope.execution);
 * try { context.assertActive(); await existingHandler(context); } finally { context.close(); }
 * ```
 */
export function receiveOperationContext(
  transfer: OperationExecutionTransfer,
): OperationExecutionContext {
  if (
    !(transfer.cancellation instanceof SharedArrayBuffer) ||
    transfer.cancellation.byteLength !== Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError('Invalid operation cancellation transfer');
  }
  const state = new Int32Array(transfer.cancellation);
  const controller = new AbortController();
  const context = createOperationExecutionContext(transfer.identity, {
    deadlineAt: transfer.deadlineAt,
    writeFence: transfer.writeFence,
    budgetMs: Math.max(0, transfer.deadlineAt - Date.now()),
    signal: controller.signal,
    resources: { maxBytes: 0, maxItems: 0 },
  });
  const assertActive = () => {
    if (Atomics.load(state, 0) !== 0) controller.abort();
    context.assertActive();
  };
  return Object.freeze({
    ...context,
    assertActive,
    consume: (usage: OperationResourceUsage) => {
      assertActive();
      context.consume(usage);
    },
  });
}
