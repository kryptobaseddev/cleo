/**
 * Budget caps + circuit-breaker state machine for the self-improvement loop
 * (T11889 · T11889-C).
 *
 * The loop is an AUTONOMOUS dogfooding engine — it boots a sandbox, replays a
 * scenario, and on a regression it WRITES a leased DHQ row and opens a draft PR.
 * Two guardrails bound that autonomy:
 *
 *   1. {@link SelfImproveBudget} — HARD, in-code caps (`maxTokens`, `maxUsd`,
 *      `maxPrs = 1`, `maxWorktrees = 1`). These are REAL, not advisory: the engine
 *      asks {@link CircuitBreaker.assertWithinBudget} BEFORE each costed step, so a
 *      cap is enforced as a PRE-FLIGHT check (never merely observed after the fact).
 *      `MemoryMax=32G` is NOT an in-code cap — a CORE function cannot portably
 *      self-confine to a cgroup (`systemd-run` is Linux-only) — it is an OPERATIONAL
 *      launch-wrapper documented on {@link MEMORY_MAX_LAUNCH_WRAPPER}; the in-process
 *      complement is the gondolin VM's own `memory` option.
 *   2. {@link CircuitBreaker} — a one-way latch that HALTS the run (no further ops,
 *      no DHQ write, no PR) the moment any of these trip:
 *        - an architectural gate goes RED (`gateRed`);
 *        - the writer lease throws {@link "../store/writer-lease.js".LeaseUnavailableError}
 *          (a `require`-mode acquisition FAILURE — `leaseUnavailable`);
 *        - a budget cap would be exceeded (`budgetOverrun`);
 *        - a DB error escapes the leased section (`dbError`).
 *      It does NOT trip on "daemon OFF": the default lease mode is `local` (no
 *      daemon), so daemon-off is the NORMAL operating state — tripping on it would
 *      block EVERY write in the default config (P5 spec §B.7 correction).
 *
 * This module is PURE — no DB, no native handle, no `cleo` mutation, no I/O.
 * Import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/budget
 * @epic T11889
 * @task T11913
 */

/**
 * The reasons the circuit-breaker may latch OPEN. Each is a genuine
 * halt-the-loop condition (P5 spec §B.7). Deliberately does NOT include a
 * "daemon-off" reason — the default `local` lease mode runs daemon-less, so that
 * is the normal state, not a fault.
 */
export type CircuitBreakerReason =
  /** An architectural gate (`cleo check arch --strict`) went RED. */
  | 'gateRed'
  /** The writer lease threw `LeaseUnavailableError` (`require`-mode failure). */
  | 'leaseUnavailable'
  /** A budget cap (tokens/$/PRs/worktrees) would be exceeded. */
  | 'budgetOverrun'
  /** A DB error escaped the leased section. */
  | 'dbError';

/**
 * Hard, in-code budget caps for ONE self-improvement run.
 *
 * `maxPrs` and `maxWorktrees` are pinned to `1` by {@link DEFAULT_BUDGET}: the loop
 * opens AT MOST one draft PR and boots AT MOST one sandbox per run. `maxTokens` /
 * `maxUsd` bound model spend; the engine accumulates per-op cost and asks
 * {@link CircuitBreaker.assertWithinBudget} before each costed step.
 *
 * `MemoryMax=32G` is intentionally ABSENT here — it is enforced at the launch
 * boundary (see {@link MEMORY_MAX_LAUNCH_WRAPPER}), not by this object.
 */
export interface SelfImproveBudget {
  /** Maximum model tokens spent across the whole run. */
  readonly maxTokens: number;
  /** Maximum USD spent across the whole run. */
  readonly maxUsd: number;
  /** Maximum draft PRs opened in the run (pinned to `1`). */
  readonly maxPrs: number;
  /** Maximum sandbox envs booted in the run (pinned to `1`). */
  readonly maxWorktrees: number;
}

/**
 * The default budget for a self-improvement run. `maxPrs` / `maxWorktrees` are
 * `1` by contract; `maxTokens` / `maxUsd` are conservative defaults overridable
 * via {@link resolveBudget} (env) or an explicit partial.
 */
export const DEFAULT_BUDGET: SelfImproveBudget = {
  maxTokens: 200_000,
  maxUsd: 5,
  maxPrs: 1,
  maxWorktrees: 1,
};

/**
 * @deprecated Use {@link "../resources/spawn-wrapper.js".buildSpawnArgs} instead.
 *
 * The launch-boundary memory cap — an OPERATIONAL wrapper, NOT an in-code cap.
 *
 * A CORE function cannot portably self-confine to a cgroup (`systemd-run` is
 * Linux-only; re-exec'ing under it from inside the engine is fragile), so the
 * runbook / spawn wrapper that invokes `cleo selfimprove run` wraps it on Linux.
 * On macOS the gondolin VM's own `memory` option bounds the guest.
 *
 * **Retired (T11993)**: callers should use
 * `buildSpawnArgs('cleo', ['selfimprove', 'run', ...], {}, { scopeClass: 'agent' })`
 * from `@cleocode/core/resources/spawn-wrapper` instead.  This constant remains
 * exported only for backward compatibility until all doc references are updated.
 *
 * The new SSoT places children under `cleo.slice` with coredumps suppressed
 * via `ulimit -c 0` and staged memory budgets (see spawn-wrapper module TSDoc).
 */
export const MEMORY_MAX_LAUNCH_WRAPPER =
  'systemd-run --user --scope -p MemoryMax=32G -p MemorySwapMax=0' as const;

/**
 * The mutable cost accumulator the engine threads through one run. Every costed
 * step ADDS to this before asking the breaker whether the next step fits.
 */
export interface BudgetSpend {
  /** Tokens spent so far. */
  tokens: number;
  /** USD spent so far. */
  usd: number;
  /** Draft PRs opened so far. */
  prs: number;
  /** Sandbox envs booted so far. */
  worktrees: number;
}

/** A fresh, zeroed {@link BudgetSpend}. */
export function emptySpend(): BudgetSpend {
  return { tokens: 0, usd: 0, prs: 0, worktrees: 0 };
}

/**
 * The increment a single step would add to the spend. Each field defaults to `0`,
 * so a step that only opens a PR passes `{ prs: 1 }`.
 */
export interface BudgetCharge {
  /** Tokens this step would consume. */
  readonly tokens?: number;
  /** USD this step would consume. */
  readonly usd?: number;
  /** Draft PRs this step would open. */
  readonly prs?: number;
  /** Sandbox envs this step would boot. */
  readonly worktrees?: number;
}

/**
 * Thrown by {@link CircuitBreaker.assertWithinBudget} when a step's charge would
 * push the accumulated spend past a cap. Carries the offending dimension so the
 * engine can trip the breaker with `reason: 'budgetOverrun'` and surface WHICH cap.
 */
export class BudgetExceededError extends Error {
  /** Stable machine-readable code. */
  public readonly code = 'E_SELFIMPROVE_BUDGET_EXCEEDED' as const;
  /** Which cap was exceeded. */
  public readonly dimension: keyof SelfImproveBudget;

  /**
   * @param dimension - The exceeded cap dimension.
   * @param attempted - The accumulated value the step would have reached.
   * @param cap - The cap that bounds it.
   */
  constructor(dimension: keyof SelfImproveBudget, attempted: number, cap: number) {
    super(`self-improve budget exceeded: ${dimension} would reach ${attempted}, cap is ${cap}`);
    this.name = 'BudgetExceededError';
    this.dimension = dimension;
  }
}

/** Snapshot of the circuit-breaker latch state. */
export interface CircuitBreakerState {
  /** Whether the breaker has latched OPEN (the loop must halt). */
  readonly open: boolean;
  /** The reason the breaker tripped, or `null` while closed. */
  readonly reason: CircuitBreakerReason | null;
  /** A human-readable detail for the trip, or `null` while closed. */
  readonly detail: string | null;
}

/**
 * A one-way circuit-breaker latch + pre-flight budget gate for ONE run.
 *
 * Once {@link trip} is called the breaker stays OPEN for the run's lifetime —
 * there is no reset (a run is single-use; the next run constructs a fresh
 * breaker). {@link assertOpen} short-circuits B.4-B.5 to a no-op the moment the
 * latch is set, and {@link assertWithinBudget} is the PRE-FLIGHT check the engine
 * runs before each costed step.
 *
 * PURE — holds only in-memory counters; no I/O.
 */
export class CircuitBreaker {
  readonly #budget: SelfImproveBudget;
  readonly #spend: BudgetSpend;
  #open = false;
  #reason: CircuitBreakerReason | null = null;
  #detail: string | null = null;

  /**
   * @param budget - The caps for this run (defaults to {@link DEFAULT_BUDGET}).
   * @param spend - The starting spend (defaults to a zeroed accumulator).
   */
  constructor(budget: SelfImproveBudget = DEFAULT_BUDGET, spend: BudgetSpend = emptySpend()) {
    this.#budget = budget;
    this.#spend = spend;
  }

  /** Whether the breaker has latched OPEN. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** The current latch state (open flag + reason + detail). */
  get state(): CircuitBreakerState {
    return { open: this.#open, reason: this.#reason, detail: this.#detail };
  }

  /** The accumulated spend so far (a live read of the internal counters). */
  get spend(): Readonly<BudgetSpend> {
    return { ...this.#spend };
  }

  /**
   * Latch the breaker OPEN. Idempotent: the FIRST trip wins — a later trip does
   * not overwrite the original reason (the first fault is the relevant one).
   *
   * @param reason - The trip reason.
   * @param detail - A human-readable detail for logs / the run report.
   */
  trip(reason: CircuitBreakerReason, detail: string): void {
    if (this.#open) return;
    this.#open = true;
    this.#reason = reason;
    this.#detail = detail;
  }

  /**
   * Throw if the breaker is OPEN — the engine calls this at the top of each
   * phase so a tripped breaker short-circuits the rest of the run.
   *
   * @throws {Error} `E_SELFIMPROVE_CIRCUIT_OPEN` when the breaker is latched.
   */
  assertClosed(): void {
    if (this.#open) {
      const err = new Error(`self-improve circuit-breaker OPEN (${this.#reason}): ${this.#detail}`);
      (err as Error & { code: string }).code = 'E_SELFIMPROVE_CIRCUIT_OPEN';
      throw err;
    }
  }

  /**
   * PRE-FLIGHT budget check for a costed step. Computes the spend the step WOULD
   * reach and — if any dimension would exceed its cap — TRIPS the breaker with
   * `reason: 'budgetOverrun'` and throws {@link BudgetExceededError} BEFORE the
   * step runs. On success it COMMITS the charge to the accumulator.
   *
   * @param charge - The increment the step would add.
   * @throws {BudgetExceededError} When a cap would be exceeded (and trips the breaker).
   */
  chargeOrTrip(charge: BudgetCharge): void {
    const next: BudgetSpend = {
      tokens: this.#spend.tokens + (charge.tokens ?? 0),
      usd: this.#spend.usd + (charge.usd ?? 0),
      prs: this.#spend.prs + (charge.prs ?? 0),
      worktrees: this.#spend.worktrees + (charge.worktrees ?? 0),
    };

    const checks: Array<[keyof SelfImproveBudget, number, number]> = [
      ['maxTokens', next.tokens, this.#budget.maxTokens],
      ['maxUsd', next.usd, this.#budget.maxUsd],
      ['maxPrs', next.prs, this.#budget.maxPrs],
      ['maxWorktrees', next.worktrees, this.#budget.maxWorktrees],
    ];
    for (const [dimension, attempted, cap] of checks) {
      if (attempted > cap) {
        const err = new BudgetExceededError(dimension, attempted, cap);
        this.trip('budgetOverrun', err.message);
        throw err;
      }
    }

    this.#spend.tokens = next.tokens;
    this.#spend.usd = next.usd;
    this.#spend.prs = next.prs;
    this.#spend.worktrees = next.worktrees;
  }
}

/**
 * Resolve the effective {@link SelfImproveBudget}, layering env overrides over an
 * explicit partial over {@link DEFAULT_BUDGET}. `maxPrs` / `maxWorktrees` are
 * ALWAYS clamped to at most `1` regardless of override — the one-PR / one-sandbox
 * ceiling is a hard invariant, not a tunable.
 *
 * Env overrides (numeric): `CLEO_SELFIMPROVE_MAX_TOKENS`, `CLEO_SELFIMPROVE_MAX_USD`.
 *
 * @param overrides - Optional explicit partial caps (test / caller injection).
 * @param env - The environment to read overrides from (defaults to `process.env`).
 * @returns The resolved, invariant-clamped budget.
 */
export function resolveBudget(
  overrides: Partial<SelfImproveBudget> = {},
  env: NodeJS.ProcessEnv = process.env,
): SelfImproveBudget {
  const envTokens = Number(env.CLEO_SELFIMPROVE_MAX_TOKENS);
  const envUsd = Number(env.CLEO_SELFIMPROVE_MAX_USD);

  const maxTokens =
    overrides.maxTokens ??
    (Number.isFinite(envTokens) && envTokens > 0 ? envTokens : DEFAULT_BUDGET.maxTokens);
  const maxUsd =
    overrides.maxUsd ?? (Number.isFinite(envUsd) && envUsd > 0 ? envUsd : DEFAULT_BUDGET.maxUsd);

  // The one-PR / one-sandbox ceiling is invariant — clamp to at most 1.
  const maxPrs = Math.min(1, overrides.maxPrs ?? DEFAULT_BUDGET.maxPrs);
  const maxWorktrees = Math.min(1, overrides.maxWorktrees ?? DEFAULT_BUDGET.maxWorktrees);

  return { maxTokens, maxUsd, maxPrs, maxWorktrees };
}
