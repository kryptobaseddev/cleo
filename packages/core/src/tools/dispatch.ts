/**
 * Agent tool-call dispatch engine (T1740 · epic T11456 · SG-TOOLS).
 *
 * The SINGLE chokepoint that turns a model-emitted tool-call `{ name, args }`
 * into an executed, LLM-safe result. It is the SDK-side dispatch path the T1738
 * architecture (D11141) names: **core DISPATCHES, cleo-os DRIVES**. Given a tool
 * call from the agent loop, it:
 *
 *  1. **Looks up** the tool in the injected {@link AgentToolRegistry} (the
 *     name→descriptor catalog). An unknown name is a typed
 *     `tool-not-found` result — never a throw.
 *  2. **Validates** the model-supplied arguments against the tool's Zod schema
 *     (defense in depth: the wire layer advertised the JSON-schema, but the
 *     model's emitted args are re-validated here before any side effect). A
 *     schema failure is a typed `invalid-args` result carrying the FLATTENED
 *     issue list — not the raw Zod error (no internals leak).
 *  3. **Checks availability** for the current {@link ToolAvailabilityContext}
 *     (network egress, binaries on PATH, capability flags). An unavailable tool
 *     is a typed `guard-denied` result — the model is told the tool is not
 *     offered right now, with no precondition internals.
 *  4. **Charges the budget** ({@link ToolCallBudget}) — per-call count / wall-time
 *     ceilings. An exhausted budget short-circuits with a typed `guard-denied`
 *     result BEFORE the tool runs; a per-call timeout races the execution and
 *     yields a typed `timeout` result.
 *  5. **Executes** the bound {@link AgentToolExecutable} over the injected
 *     {@link GuardedToolSurface} — the deny-first chokepoint
 *     ({@link ./guard.js}). Every fs/shell side effect therefore still funnels
 *     through the guard's path allowlist + command denylist + env scrub; there
 *     is NO raw-primitive bypass.
 *  6. **Formats** the outcome for LLM consumption ({@link formatToolResultForLlm})
 *     — a `tool_result`-shaped payload the Pi loop feeds back to the model. On
 *     ANY error the message is a redacted, classified summary; a raw secret,
 *     stack trace, or guard internal NEVER reaches the model-facing string.
 *
 * ## Sync + async handlers (AC2)
 *
 * A registered {@link AgentToolExecutable} returns a `Promise<unknown>`, but a
 * synchronous handler that returns a plain value is equally supported: the
 * engine `await`s the call so a non-thenable return is normalized to a resolved
 * value, and a synchronous throw is caught the same as a rejected promise.
 *
 * ## Why it lives in `core/src/tools` (Gate-11)
 *
 * The dispatch engine is a CORE-SDK concern, built entirely against the frozen
 * {@link AgentToolRegistry} + {@link GuardedToolSurface} contracts. It defines
 * NO new atomic tool primitive (Gate-11 Tools-vs-Skills boundary) and makes NO
 * LLM call (Gate-13): result-formatting is pure serialization. The harness
 * (`cleo-os`) and the in-process Pi adapter merely SUPPLY the registry, the
 * guard, and the workspace context, then read the {@link ToolDispatchResult}.
 *
 * @task T1740
 * @epic T11456
 * @see ./agent-registry.js — the name→descriptor catalog + availability checks
 * @see ./guard.js — the deny-first surface every executable routes side effects through
 * @see ../llm/pi/pi-tool-bridge.js — the AC6 consumer wiring this into the Pi loop
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import type { z } from 'zod';
import { getLogger } from '../logger.js';
import type {
  AgentToolDescriptor,
  AgentToolRegistry,
  ToolAvailabilityContext,
} from './agent-registry.js';
import { ALWAYS_AVAILABLE } from './agent-registry.js';

const log = getLogger('tool-dispatch');

// ---------------------------------------------------------------------------
// Error classification (AC3)
// ---------------------------------------------------------------------------

/**
 * The typed failure classes a dispatch can produce (AC3). Each maps a distinct
 * failure mode to a stable, model-safe category so the loop (and any UI) can
 * branch on the KIND without parsing a free-text message:
 *
 *  - `tool-not-found` — the model named a tool not in the registry.
 *  - `invalid-args`   — arguments failed the tool's Zod schema.
 *  - `guard-denied`   — the tool is unavailable for this context, or the
 *                       per-call budget was exhausted before it ran.
 *  - `execution-error`— the tool ran but threw (incl. a `GuardDeniedError`
 *                       from the deny-first surface during the side effect).
 *  - `timeout`        — the tool exceeded the per-call wall-time ceiling.
 */
export type ToolDispatchErrorKind =
  | 'tool-not-found'
  | 'invalid-args'
  | 'guard-denied'
  | 'execution-error'
  | 'timeout';

/**
 * Stable machine-readable error codes, one per {@link ToolDispatchErrorKind}.
 * Surfaced on the failure envelope so a programmatic caller never string-matches
 * the human message.
 */
export const TOOL_DISPATCH_ERROR_CODE: Readonly<Record<ToolDispatchErrorKind, string>> = {
  'tool-not-found': 'E_TOOL_NOT_FOUND',
  'invalid-args': 'E_TOOL_INVALID_ARGS',
  'guard-denied': 'E_TOOL_GUARD_DENIED',
  'execution-error': 'E_TOOL_EXECUTION_ERROR',
  timeout: 'E_TOOL_TIMEOUT',
};

// ---------------------------------------------------------------------------
// Dispatch I/O
// ---------------------------------------------------------------------------

/**
 * A single tool call as the model emits it — the dispatch engine's input. The
 * `name` is the model-visible tool name; `arguments` is the JSON-parsed argument
 * object (the engine never sees the raw JSON string — parsing is the loop's job,
 * the engine validates the parsed shape).
 */
export interface ToolCall {
  /** Stable id correlating the call to its `tool_result` (loop-supplied). */
  readonly id: string;
  /** Model-visible tool name to dispatch. */
  readonly name: string;
  /** JSON-parsed argument object the model supplied. */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * The successful outcome of a dispatch (AC4). `value` is the tool's raw return
 * (opaque to the engine); `display` is the LLM-facing string the loop feeds back
 * in the `tool_result` message.
 */
export interface ToolDispatchSuccess {
  /** Discriminant. */
  readonly ok: true;
  /** The dispatched tool's name (echoed for correlation). */
  readonly name: string;
  /** The raw tool return value (for structured logging / details). */
  readonly value: unknown;
  /** The LLM-facing rendering of `value` (the `tool_result` body). */
  readonly display: string;
}

/**
 * The failed outcome of a dispatch (AC3 + AC4). Carries the typed
 * {@link ToolDispatchErrorKind}, a stable code, and a REDACTED, model-safe
 * `message` — a raw secret / stack / guard internal is never placed here.
 */
export interface ToolDispatchFailure {
  /** Discriminant. */
  readonly ok: false;
  /** The dispatched tool's name (echoed for correlation). */
  readonly name: string;
  /** The typed failure class (AC3). */
  readonly kind: ToolDispatchErrorKind;
  /** Stable machine-readable code ({@link TOOL_DISPATCH_ERROR_CODE}). */
  readonly code: string;
  /** Redacted, model-safe failure summary (the `tool_result` body). */
  readonly message: string;
  /**
   * For `invalid-args`, the flattened schema issues (path + reason) — safe to
   * show the model so it can correct its call. Absent for other kinds.
   */
  readonly issues?: readonly ToolArgIssue[];
}

/** A flattened Zod issue: the field path and the human-readable reason. */
export interface ToolArgIssue {
  /** Dotted field path, e.g. `path` or `args.0`. Empty for a root issue. */
  readonly path: string;
  /** Human-readable validation reason. */
  readonly message: string;
}

/** The terminal result of a single dispatch — success or a classified failure. */
export type ToolDispatchResult = ToolDispatchSuccess | ToolDispatchFailure;

// ---------------------------------------------------------------------------
// Budget tracking (AC5)
// ---------------------------------------------------------------------------

/** Caps for {@link ToolCallBudget}. A cap of `undefined` means "unbounded". */
export interface ToolBudgetLimits {
  /** Max number of tool calls this budget admits. */
  readonly maxCalls?: number;
  /** Per-call wall-time ceiling in milliseconds (a slower call → `timeout`). */
  readonly perCallTimeoutMs?: number;
  /** Cumulative wall-time ceiling across all calls in milliseconds. */
  readonly totalTimeBudgetMs?: number;
}

/**
 * A snapshot of a {@link ToolCallBudget}'s consumption — surfaced so a consumer
 * (the Pi loop / a UI) can report remaining headroom (AC5).
 */
export interface ToolBudgetSnapshot {
  /** Calls charged so far. */
  readonly callsUsed: number;
  /** Calls remaining (`Infinity` when uncapped). */
  readonly callsRemaining: number;
  /** Cumulative wall-time charged so far, in ms. */
  readonly timeUsedMs: number;
  /** Cumulative wall-time remaining, in ms (`Infinity` when uncapped). */
  readonly timeRemainingMs: number;
}

/**
 * Per-run tool-call budget (AC5). Tracks call count + cumulative wall-time
 * against the configured {@link ToolBudgetLimits}. The engine consults
 * {@link admit} BEFORE running a tool (rejecting once a ceiling is hit) and
 * {@link charge}s the elapsed time AFTER. A single budget instance is threaded
 * across all calls of one run, so the count/time caps are run-scoped.
 */
export class ToolCallBudget {
  readonly #limits: ToolBudgetLimits;
  #callsUsed = 0;
  #timeUsedMs = 0;

  /**
   * @param limits - The ceilings this budget enforces (each optional → uncapped).
   */
  constructor(limits: ToolBudgetLimits = {}) {
    this.#limits = limits;
  }

  /** The per-call timeout ceiling in ms, or `undefined` when uncapped. */
  get perCallTimeoutMs(): number | undefined {
    return this.#limits.perCallTimeoutMs;
  }

  /**
   * Whether another call is admitted right now. Returns a typed denial reason
   * (or `null` when admitted) so the engine can map it onto the precise
   * `guard-denied` message WITHOUT exposing the limit internals to the model.
   *
   * @returns `null` when a call is admitted; otherwise the human-readable reason.
   */
  admit(): string | null {
    if (this.#limits.maxCalls !== undefined && this.#callsUsed >= this.#limits.maxCalls) {
      return `tool-call budget exhausted (max ${this.#limits.maxCalls} calls)`;
    }
    if (
      this.#limits.totalTimeBudgetMs !== undefined &&
      this.#timeUsedMs >= this.#limits.totalTimeBudgetMs
    ) {
      return `tool-call time budget exhausted (max ${this.#limits.totalTimeBudgetMs}ms)`;
    }
    return null;
  }

  /**
   * Charge one completed call against the budget.
   *
   * @param elapsedMs - The call's measured wall-time in milliseconds.
   */
  charge(elapsedMs: number): void {
    this.#callsUsed += 1;
    this.#timeUsedMs += Math.max(0, elapsedMs);
  }

  /** A read-only snapshot of current consumption (AC5). */
  snapshot(): ToolBudgetSnapshot {
    const callsRemaining =
      this.#limits.maxCalls === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, this.#limits.maxCalls - this.#callsUsed);
    const timeRemainingMs =
      this.#limits.totalTimeBudgetMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, this.#limits.totalTimeBudgetMs - this.#timeUsedMs);
    return {
      callsUsed: this.#callsUsed,
      callsRemaining,
      timeUsedMs: this.#timeUsedMs,
      timeRemainingMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Maximum length of a formatted `tool_result` body before truncation (AC4). */
export const MAX_TOOL_RESULT_CHARS = 16_000;

/**
 * Construction dependencies for {@link ToolDispatchEngine}.
 */
export interface ToolDispatchEngineDeps {
  /** The frozen tool catalog the engine dispatches against (name→descriptor). */
  readonly registry: AgentToolRegistry;
  /**
   * The deny-first guarded surface every executable performs side effects
   * through. Injected — the engine never constructs a guard (Gate-11).
   */
  readonly tools: GuardedToolSurface;
  /**
   * Availability context (AC5 of the registry): a tool whose
   * {@link AgentToolDescriptor.available} predicate is false for this context is
   * `guard-denied` before it runs. Defaults to `{}` (everything available).
   */
  readonly availability?: ToolAvailabilityContext;
  /**
   * Optional run-scoped budget (AC5). When omitted an unbounded budget is used,
   * so a call count / time ceiling is opt-in. Threaded across all
   * {@link ToolDispatchEngine.dispatch} calls of one run.
   */
  readonly budget?: ToolCallBudget;
}

/**
 * The agent tool-call dispatch engine (AC1).
 *
 * One instance per agent run: it holds the frozen registry, the guarded surface,
 * the availability context, and the run-scoped budget, and dispatches each
 * model-emitted {@link ToolCall} to a classified {@link ToolDispatchResult}.
 * {@link dispatch} NEVER throws — every failure mode is encoded as a typed
 * {@link ToolDispatchFailure} (AC3), so the agent loop can always feed a
 * `tool_result` back and continue.
 *
 * @example
 * ```ts
 * const registry = await createAgentToolRegistry();
 * const tools = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
 * const engine = new ToolDispatchEngine({
 *   registry,
 *   tools,
 *   budget: new ToolCallBudget({ maxCalls: 50, perCallTimeoutMs: 30_000 }),
 * });
 * const result = await engine.dispatch({ id: 'c1', name: 'read_file_paged', arguments: { path } });
 * // result.ok ? feed result.display : feed the classified result.message
 * ```
 */
export class ToolDispatchEngine {
  readonly #registry: AgentToolRegistry;
  readonly #tools: GuardedToolSurface;
  readonly #availability: ToolAvailabilityContext;
  readonly #budget: ToolCallBudget;

  /**
   * @param deps - The registry, guarded surface, availability context, and
   *   optional run-scoped budget.
   */
  constructor(deps: ToolDispatchEngineDeps) {
    this.#registry = deps.registry;
    this.#tools = deps.tools;
    this.#availability = deps.availability ?? {};
    this.#budget = deps.budget ?? new ToolCallBudget();
  }

  /** A read-only snapshot of the run's budget consumption (AC5). */
  budgetSnapshot(): ToolBudgetSnapshot {
    return this.#budget.snapshot();
  }

  /**
   * Dispatch a single model-emitted tool call to a classified result (AC1–AC5).
   *
   * The full pipeline — lookup → validate → availability → budget admit →
   * (timed) execute → charge → format — runs here. It NEVER throws: a thrown
   * executable (incl. a deny-first `GuardDeniedError` during the side effect)
   * becomes an `execution-error`, a slow executable a `timeout`, an unknown name
   * a `tool-not-found`, bad args an `invalid-args`, and an unavailable tool /
   * exhausted budget a `guard-denied`. A `signal` (when supplied) aborts the
   * underlying call cooperatively.
   *
   * @param call - The model-emitted tool call (`{ id, name, arguments }`).
   * @param signal - Optional abort signal threaded into the per-call race.
   * @returns The terminal {@link ToolDispatchResult}.
   */
  async dispatch(call: ToolCall, signal?: AbortSignal): Promise<ToolDispatchResult> {
    // 1. Lookup (AC1).
    const descriptor = this.#registry.get(call.name);
    if (!descriptor) {
      return this.#fail(call.name, 'tool-not-found', `unknown tool "${call.name}"`);
    }

    // 2. Validate arguments against the tool's Zod schema (AC3 — defense in depth).
    const parsed = descriptor.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = flattenZodIssues(parsed.error);
      return this.#fail(
        call.name,
        'invalid-args',
        `arguments for "${call.name}" failed validation`,
        issues,
      );
    }

    // 3. Availability check (AC5 — registry availability predicates).
    const available = (descriptor.available ?? ALWAYS_AVAILABLE)(this.#availability);
    if (!available) {
      return this.#fail(
        call.name,
        'guard-denied',
        `tool "${call.name}" is not available in the current context`,
      );
    }

    // 4. Budget admit (AC5 — count/time ceilings BEFORE running).
    const denial = this.#budget.admit();
    if (denial !== null) {
      return this.#fail(call.name, 'guard-denied', denial);
    }

    // 5. Timed execution through the guarded surface (AC2 sync/async + AC5 timeout).
    // `parsed.data` is the schema-validated argument object; a tool's `parameters`
    // is always a Zod object schema, so the validated value is a record. Coerce to
    // the executable's input shape (the generic `z.ZodType` infers `unknown`).
    const validatedArgs: Readonly<Record<string, unknown>> = isRecord(parsed.data)
      ? parsed.data
      : {};
    const startedAt = Date.now();
    try {
      const value = await this.#runWithTimeout(descriptor, validatedArgs, signal);
      this.#budget.charge(Date.now() - startedAt);
      // 6. Format the success for LLM consumption (AC4).
      return { ok: true, name: call.name, value, display: formatToolValueForLlm(value) };
    } catch (err) {
      // Charge the elapsed time even on failure so a long-running failed call
      // still counts against the time budget (AC5).
      this.#budget.charge(Date.now() - startedAt);
      if (err instanceof ToolTimeoutError) {
        return this.#fail(call.name, 'timeout', err.message);
      }
      // Any thrown executable error (incl. a deny-first GuardDeniedError raised
      // DURING the side effect) is an execution-error. The message is REDACTED
      // (AC3) — no raw secret/stack reaches the model-facing result.
      const redacted = redactErrorMessage(err);
      log.debug({ tool: call.name, kind: 'execution-error' }, 'tool dispatch execution failed');
      return this.#fail(call.name, 'execution-error', redacted);
    }
  }

  /**
   * Run the executable, racing it against the per-call timeout when one is set.
   *
   * Both a synchronous return value and a `Promise` are handled: `await`ing a
   * non-thenable normalizes it to a resolved value, and a synchronous throw is
   * caught by {@link dispatch}'s surrounding `try` exactly like a rejection
   * (AC2). The timeout rejects with a {@link ToolTimeoutError} the caller maps
   * to a `timeout` result.
   */
  async #runWithTimeout(
    descriptor: AgentToolDescriptor,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeoutMs = this.#budget.perCallTimeoutMs;
    // `Promise.resolve(...)` normalizes a synchronous (non-thenable) return into
    // a resolved promise; a synchronous throw inside `execute` rejects it.
    const run = Promise.resolve(descriptor.execute(args, this.#tools));
    if (timeoutMs === undefined) return run;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ToolTimeoutError(
              `tool "${descriptor.name}" exceeded the per-call timeout of ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      // Abort short-circuits the race the same as a timeout would — but as an
      // execution-error (the call was cancelled, not slow). A pre-aborted signal
      // rejects immediately.
      if (signal) {
        if (signal.aborted) {
          reject(new Error('tool call aborted'));
        } else {
          signal.addEventListener('abort', () => reject(new Error('tool call aborted')), {
            once: true,
          });
        }
      }
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Build a classified {@link ToolDispatchFailure}. */
  #fail(
    name: string,
    kind: ToolDispatchErrorKind,
    message: string,
    issues?: readonly ToolArgIssue[],
  ): ToolDispatchFailure {
    return {
      ok: false,
      name,
      kind,
      code: TOOL_DISPATCH_ERROR_CODE[kind],
      message,
      ...(issues !== undefined ? { issues } : {}),
    };
  }
}

/** Thrown internally when a tool call exceeds its per-call timeout (AC5). */
export class ToolTimeoutError extends Error {
  /** Machine-readable code. */
  readonly code = 'E_TOOL_TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Result formatting (AC4)
// ---------------------------------------------------------------------------

/**
 * Render a tool's raw return value into the LLM-facing `tool_result` body (AC4).
 *
 * A string passes through; everything else is JSON-serialized (pretty, stable).
 * A circular / non-serializable value degrades to its `String(...)` form rather
 * than throwing. The result is hard-capped at {@link MAX_TOOL_RESULT_CHARS} with
 * a truncation marker so one tool call cannot blow the model's context window.
 *
 * @param value - The raw tool return.
 * @returns The model-safe `tool_result` string.
 */
export function formatToolValueForLlm(value: unknown): string {
  let rendered: string;
  if (typeof value === 'string') {
    rendered = value;
  } else if (value === undefined) {
    rendered = '';
  } else {
    try {
      rendered = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      // Circular / BigInt / non-serializable — degrade rather than throw.
      rendered = String(value);
    }
  }
  return truncateForLlm(rendered);
}

/**
 * Project a terminal {@link ToolDispatchResult} onto the `tool_result` message
 * shape the agent loop feeds back to the model (AC4).
 *
 * The `content` is `result.display` on success or the redacted, classified
 * `result.message` on failure (with the flattened arg issues appended when
 * present). `isError` lets the loop / transport mark the turn so the model knows
 * the call did not succeed.
 *
 * @param result - The dispatch outcome.
 * @returns A `{ toolCallId, toolName, content, isError }` envelope.
 */
export function formatToolResultForLlm(
  call: Pick<ToolCall, 'id'>,
  result: ToolDispatchResult,
): ToolResultPayload {
  if (result.ok) {
    return { toolCallId: call.id, toolName: result.name, content: result.display, isError: false };
  }
  const issuesText =
    result.issues && result.issues.length > 0
      ? `\n${result.issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`
      : '';
  return {
    toolCallId: call.id,
    toolName: result.name,
    content: `[${result.code}] ${result.message}${issuesText}`,
    isError: true,
  };
}

/**
 * The LLM-facing `tool_result` payload shape (AC4) — the minimal subset the loop
 * needs to build a provider `tool_result` / `toolResult` message. Structurally a
 * subset of `pi-ai`'s `ToolResultMessage`, so the Pi bridge maps it 1:1.
 */
export interface ToolResultPayload {
  /** Correlates back to the originating {@link ToolCall.id}. */
  readonly toolCallId: string;
  /** The tool's name (echoed for the provider message). */
  readonly toolName: string;
  /** The model-facing result body (display on success, redacted summary on error). */
  readonly content: string;
  /** Whether the turn is an error result. */
  readonly isError: boolean;
}

// ---------------------------------------------------------------------------
// Redaction + helpers
// ---------------------------------------------------------------------------

/** Truncate a rendered result to {@link MAX_TOOL_RESULT_CHARS} with a marker. */
function truncateForLlm(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const head = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${head}\n…[truncated ${omitted} chars]`;
}

/**
 * Produce a REDACTED, model-safe message from a thrown executable error (AC3).
 *
 * Only the error's single-line `message` is kept — never the stack trace (which
 * can leak absolute paths / internal module structure) and never an attached
 * `cause`. The message itself is scrubbed for obvious secret-looking tokens so a
 * tool that interpolates a credential into its error string cannot leak it to
 * the model. A non-`Error` throw degrades to a fixed, generic summary.
 *
 * @param err - The thrown value.
 * @returns A single-line, secret-scrubbed message safe for the model.
 */
export function redactErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'tool execution failed';
  // Keep a single line (drop any embedded newlines/stack-like content) and cap
  // the length so a runaway message cannot dominate the context window.
  const firstLine = raw.split('\n', 1)[0] ?? 'tool execution failed';
  return scrubSecrets(firstLine).slice(0, 500);
}

/**
 * Best-effort secret scrub for a model-facing string. Masks the high-signal
 * secret shapes (provider key prefixes, bearer tokens, long base64-ish blobs)
 * so a leaked credential cannot reach the LLM-facing result. This is a
 * defense-in-depth net on TOP of the architecture's rule that no plaintext key
 * is ever in scope here — not a substitute for it.
 *
 * @param text - The candidate message.
 * @returns The message with secret-looking tokens masked.
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xoxb|xoxp|AKIA)[-_a-zA-Z0-9]{12,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[redacted-jwt]');
}

/**
 * Flatten a {@link z.ZodError} into the minimal, model-safe
 * {@link ToolArgIssue}[] — path + reason only, no raw Zod internals.
 *
 * @param error - The Zod validation error.
 * @returns The flattened issues.
 */
export function flattenZodIssues(error: z.ZodError): readonly ToolArgIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Narrow an unknown to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
