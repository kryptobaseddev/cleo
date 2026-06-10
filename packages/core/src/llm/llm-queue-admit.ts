/**
 * **LLM-queue admit gate** — the Node-side gate for the supervisor's LLM-queue
 * priority scheduler + per-provider rate governor (T11630 · AC1-AC4).
 *
 * The contended priority + rate state lives in the Rust arbiter
 * (`crates/cleo-supervisor/src/llm_queue.rs`), exposed over `lease-ipc` v1.1 as
 * the `queue_admit` → `queue_admit_result` verb. THIS module is the thin Node
 * gate every outbound LLM call passes through immediately before it hits the
 * wire: it asks the supervisor "may I admit this call?" and, on a `deferred`
 * answer, backs off `retry_after_ms` and re-asks — a structured deferral, never
 * a silent drop (AC4).
 *
 * ## Modes ({@link resolveLlmQueueMode})
 *
 * `CLEO_LLM_QUEUE_MODE` ∈ `{ supervisor | off }`, **default `off`** — mirrors
 * {@link ../store/writer-lease.ts}'s `resolveLeaseMode()` shape:
 *
 * - `off` — pure pass-through: {@link llmQueueAdmit} returns `{ admitted: true }`
 *   without touching the supervisor. The daemon is OFF by default in production,
 *   so this is the shipping config: EVERY LLM call works with no supervisor.
 * - `supervisor` — prefer the supervisor arbiter over the IPC socket; a
 *   `deferred` result is honoured with a back-off + re-request. When the socket
 *   is absent / refused / errors, the gate logs the demotion ONCE and degrades
 *   to direct execution (`{ admitted: true }`) — a dead/absent arbiter must
 *   NEVER block an LLM call.
 *
 * ## CRITICAL degrade-to-direct (headline correctness — AC4 inverse)
 *
 * Because the daemon stays OFF by default, the load-bearing path is the degrade:
 * mode `off`, no socket, `E_LEASE_UNAVAILABLE`, or a connect-refused all resolve
 * to `{ admitted: true }` and the caller executes the LLM call DIRECTLY. The
 * supervisor is a pure OPTIMISATION; its absence is never an error.
 *
 * @module llm/llm-queue-admit
 * @task T11630
 * @epic T11625
 * @see ../store/writer-lease.ts — the `resolveLeaseMode()` + log-once demotion this mirrors
 * @see ../../../runtime/src/daemon/lease-ipc-client.ts — the v1.1 codec this mirrors (boundary: core cannot import runtime)
 */

import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  LEASE_IPC_PROTOCOL_VERSION,
  type LeaseIpcRequest,
  LeaseIpcRequestEnvelopeSchema,
  LeaseIpcResponseEnvelopeSchema,
  type QueueAdmitResultResponse,
  type QueuePriorityClass,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { getLogger } from '../logger.js';

/** The supervisor IPC socket filename — MUST equal `SOCKET_NAME` in the Rust `crates/cleo-supervisor/src/paths.rs`. */
const SUPERVISOR_SOCKET_NAME = 'cleo-supervisor.sock';

/** The LLM-queue admit gate mode. Resolved once per process; default `off`. */
export type LlmQueueMode = 'supervisor' | 'off';

/**
 * The structured result of an admit gate decision. `admitted: true` means
 * execute the LLM call now; the gate NEVER returns a "dropped" — an over-budget
 * request is internally retried (with back-off) until admitted or the supervisor
 * is found unavailable (then degrades to admitted-direct). AC4.
 */
export interface LlmAdmitResult {
  /** Whether the LLM call may proceed (always `true` once this resolves). */
  readonly admitted: true;
  /**
   * How the admission was decided — `direct` when no supervisor arbitrated
   * (off-mode / degrade), `supervisor` when the arbiter granted it. Diagnostic
   * only; both mean "go".
   */
  readonly via: 'direct' | 'supervisor';
}

/** Options for {@link llmQueueAdmit}. */
export interface LlmQueueAdmitOptions {
  /**
   * Override the supervisor socket path. Defaults to
   * `<cleoHome>/cleo-supervisor.sock` (or `$CLEO_SUPERVISOR_SOCKET`).
   */
  socketPath?: string;
  /**
   * Max wall-clock (ms) the gate will spend re-requesting a deferred admit
   * before degrading to direct. Bounds the worst-case latency a starved call
   * adds; on timeout the call proceeds (the supervisor budget is advisory, never
   * a hard block on a real call). Default {@link DEFAULT_ADMIT_DEADLINE_MS}.
   */
  deadlineMs?: number;
}

/** Max wall-clock a deferred admit will be re-requested before degrading. */
export const DEFAULT_ADMIT_DEADLINE_MS = 30_000;

/** Connect timeout for the supervisor socket (ms). A slow/absent socket degrades fast. */
const CONNECT_TIMEOUT_MS = 250;

/** Per-request read timeout for a `queue_admit_result` (ms). */
const REQUEST_TIMEOUT_MS = 2_000;

/** Cap on a single deferral back-off so a misconfigured window cannot wedge a call. */
const MAX_RETRY_BACKOFF_MS = 5_000;

/**
 * Lazily-memoized module logger (import-time-side-effect-free — matches the
 * `writer-lease.ts` deferral pattern so a mocked import graph never hits a TDZ).
 */
let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('llm-queue-admit');
  return _log;
}

let _cachedMode: LlmQueueMode | null = null;
let _supervisorDemotionLogged = false;

/**
 * Resolve the LLM-queue mode from `CLEO_LLM_QUEUE_MODE`, once per process.
 *
 * Unknown / unset values resolve to `'off'` — the production-safe default while
 * the supervisor daemon is disabled. Mirrors `resolveLeaseMode()`.
 *
 * @returns The resolved {@link LlmQueueMode}.
 * @task T11630
 */
export function resolveLlmQueueMode(): LlmQueueMode {
  if (_cachedMode !== null) return _cachedMode;
  const raw = process.env.CLEO_LLM_QUEUE_MODE;
  _cachedMode = raw === 'supervisor' ? 'supervisor' : 'off';
  return _cachedMode;
}

/**
 * Reset cached process-global state (mode + demotion flag). Tests only.
 *
 * @internal
 */
export function _resetLlmQueueStateForTest(): void {
  _cachedMode = null;
  _supervisorDemotionLogged = false;
}

/** Log the supervisor→direct demotion AT MOST once per process. */
function logDemotionOnce(reason: string): void {
  if (_supervisorDemotionLogged) return;
  _supervisorDemotionLogged = true;
  log().info(
    `CLEO_LLM_QUEUE_MODE=supervisor but the LLM-queue arbiter is unavailable ` +
      `(${reason}); degrading to direct LLM execution for the process lifetime.`,
  );
}

/** The default supervisor socket path: `$CLEO_SUPERVISOR_SOCKET` or `<cleoHome>/cleo-supervisor.sock`. */
function defaultSocketPath(): string {
  const override = process.env.CLEO_SUPERVISOR_SOCKET;
  if (override !== undefined && override.length > 0) return override;
  return join(getCleoHome(), SUPERVISOR_SOCKET_NAME);
}

/** The "execute directly" result — the load-bearing degrade path. */
const ADMITTED_DIRECT: LlmAdmitResult = { admitted: true, via: 'direct' };

/** Async sleep that yields the event loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
}

/**
 * Gate an outbound LLM call through the supervisor's priority scheduler +
 * per-provider rate governor (T11630). Call this immediately BEFORE executing
 * the LLM request.
 *
 * - mode `off` (default) → returns `{ admitted: true, via: 'direct' }` with no
 *   IPC. The shipping config.
 * - mode `supervisor`, arbiter reachable → sends `queue_admit`; on `admitted`
 *   returns immediately; on `deferred` awaits `retry_after_ms` and re-requests
 *   until admitted or the deadline elapses (then degrades to direct — the budget
 *   is advisory). AC4: a deferral is a structured wait, never a dropped call.
 * - mode `supervisor`, arbiter UNreachable (no socket / connect-refused /
 *   `E_LEASE_UNAVAILABLE` / any transport error) → logs the demotion once and
 *   returns `{ admitted: true, via: 'direct' }`. A dead/absent supervisor MUST
 *   NEVER block an LLM call.
 *
 * @param provider      - The provider id the call targets (rate budget is per-provider).
 * @param priorityClass - The caller's priority class (lead > worker > background).
 * @param estTokens     - The caller's estimate of the request's token cost.
 * @param childId       - The child the call belongs to (in-flight tracking seam).
 * @param opts          - Socket path + deadline overrides.
 * @returns Always resolves to an `{ admitted: true }` result — never throws, never drops.
 *
 * @task T11630
 */
export async function llmQueueAdmit(
  provider: string,
  priorityClass: QueuePriorityClass,
  estTokens: number,
  childId: string,
  opts: LlmQueueAdmitOptions = {},
): Promise<LlmAdmitResult> {
  if (resolveLlmQueueMode() === 'off') {
    return ADMITTED_DIRECT;
  }

  const socketPath = opts.socketPath ?? defaultSocketPath();
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_ADMIT_DEADLINE_MS);

  for (;;) {
    let result: QueueAdmitResultResponse | { unavailable: true; reason: string };
    try {
      result = await sendQueueAdmit(socketPath, {
        kind: 'queue_admit',
        provider,
        priority_class: priorityClass,
        est_tokens: Math.max(0, Math.trunc(estTokens)),
        child_id: childId,
      });
    } catch (err) {
      // Any transport failure (ENOENT, ECONNREFUSED, timeout, malformed frame)
      // → the arbiter is unavailable; degrade to direct (AC4 inverse).
      logDemotionOnce(err instanceof Error ? err.message : String(err));
      return ADMITTED_DIRECT;
    }

    if ('unavailable' in result) {
      // The supervisor answered E_LEASE_UNAVAILABLE (arbiter not wired) →
      // degrade to direct.
      logDemotionOnce(result.reason);
      return ADMITTED_DIRECT;
    }

    if (result.disposition === 'admitted') {
      return { admitted: true, via: 'supervisor' };
    }

    // Deferred — structured back-off then re-request (AC4: never a silent drop).
    if (Date.now() >= deadline) {
      // The budget is advisory; a real call must not be blocked indefinitely.
      // Past the deadline, proceed (degrade to direct) rather than starve.
      log().debug(
        { provider, priorityClass, queuePosition: result.queue_position },
        'llm-queue admit deadline exceeded while deferred; proceeding directly',
      );
      return ADMITTED_DIRECT;
    }
    const backoff = Math.min(MAX_RETRY_BACKOFF_MS, Math.max(1, result.retry_after_ms));
    await sleep(backoff);
  }
}

/**
 * Send ONE `queue_admit` over a fresh supervisor socket connection and resolve
 * the typed `queue_admit_result` (or a sentinel when the arbiter answered
 * `E_LEASE_UNAVAILABLE`). Connection-per-request keeps the gate stateless and
 * transport failures isolated; the socket is closed before resolution.
 *
 * Encodes the request envelope + decodes the response line through the SAME
 * `@cleocode/contracts` v1.1 Zod schemas the runtime `lease-ipc-client` uses —
 * core cannot import `@cleocode/runtime` (cycle), so it mirrors the codec here.
 *
 * @throws On any transport error (connect refused, ENOENT, timeout, malformed frame).
 */
function sendQueueAdmit(
  socketPath: string,
  request: LeaseIpcRequest,
): Promise<QueueAdmitResultResponse | { unavailable: true; reason: string }> {
  return new Promise((resolve, reject) => {
    const id = `qa-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const envelope = LeaseIpcRequestEnvelopeSchema.parse({
      protocol_version: LEASE_IPC_PROTOCOL_VERSION,
      id,
      direction: 'request' as const,
      request,
    });
    const line = `${JSON.stringify(envelope)}\n`;

    let settled = false;
    let buffer = '';
    const socket: Socket = connect(socketPath);

    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (
      value: QueueAdmitResultResponse | { unavailable: true; reason: string },
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    socket.setTimeout(REQUEST_TIMEOUT_MS);
    // A connect that does not complete within the bound is a degrade signal.
    const connectTimer = setTimeout(
      () => fail(new Error('supervisor connect timeout')),
      CONNECT_TIMEOUT_MS,
    );

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(line);
    });
    socket.on('timeout', () => fail(new Error('supervisor request timeout')));
    socket.on('error', (err) => {
      clearTimeout(connectTimer);
      fail(err);
    });
    socket.on('close', () => {
      if (!settled) fail(new Error('supervisor closed the connection before responding'));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return; // wait for a full NDJSON line
      const raw = buffer.slice(0, nl);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (cause) {
        fail(
          new Error(`malformed lease-ipc frame: ${cause instanceof Error ? cause.message : cause}`),
        );
        return;
      }
      const parsed = LeaseIpcResponseEnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        fail(new Error(`off-contract lease-ipc response: ${parsed.error.message}`));
        return;
      }
      const { response } = parsed.data;
      if (response.kind === 'queue_admit_result') {
        succeed(response);
        return;
      }
      if (response.kind === 'error') {
        // E_LEASE_UNAVAILABLE (arbiter not wired) or any arbiter error →
        // treat as "supervisor cannot arbitrate"; the caller degrades to direct.
        succeed({ unavailable: true, reason: `${response.code}: ${response.message}` });
        return;
      }
      // Any other kind on a queue_admit correlation is a protocol violation.
      fail(new Error(`unexpected lease-ipc response kind for queue_admit: ${response.kind}`));
    });
  });
}
