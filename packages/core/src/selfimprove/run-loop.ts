/**
 * Self-improvement loop engine entry (T11889 · T11889-C).
 *
 * {@link runSelfImprove} is the CORE engine the thin `cleo selfimprove run` CLI
 * verb delegates to. It orchestrates the full walking skeleton:
 *
 *   1. **boot ONE sandbox** via
 *      {@link "../llm/pi/resolve-execution-env.js".resolveExecutionEnv} (prefers the
 *      Gondolin micro-VM; degrades to the in-process `GuardedExecutionEnv` in CI) —
 *      counted against the `maxWorktrees = 1` budget;
 *   2. **replay** the canned scenario in-process via the injected
 *      {@link "./replay.js".ReplayDispatch} port (the cleo handler supplies the real
 *      adapter; the default scenario is `query`-only so the replay never mutates);
 *   3. **diff** the captured envelopes vs the golden
 *      ({@link "./envelope-diff.js".diffEnvelopes}) — zero regressions ⇒ a SILENT,
 *      no-write green run;
 *   4. on a regression, **emit ONE DHQ** row via the leased
 *      {@link "./dhq-adapter.js".DhqAdapter} (UPSERT under
 *      `withWriterLease('project','bulk',…)`) — ONLY when `execute` is set;
 *   4b. **generate a fix** ({@link "./fix-gen.js".generateFixPatch}, T11975) — ONLY
 *      when `execute` AND `CLEO_PI_RUNNER_ENABLED=1`. Drives the LLM strictly via
 *      the E9 chokepoint to produce a unified-diff patch at the path the egress
 *      expects (`<cwd>/selfimprove-<scenario>.patch`). Degrades gracefully (no
 *      patch ⇒ the egress guard skips the PR); the outcome is recorded back onto
 *      the DHQ row. NEVER throws a rogue mutation, NEVER auto-merges;
 *   5. **open ONE DRAFT PR** ({@link "./draft-pr.js".openDraftPr}, dry-run unless
 *      `execute`) and record its URL back on the DHQ row — fires only when the
 *      fix-gen stage wrote a patch file (the existing `existsSync` egress guard).
 *
 * Self-dogfooding guardrails (NON-NEGOTIABLE, P5 spec §B.7):
 *   - **Default OFF.** Mutation + egress require `opts.execute === true`. Without
 *     it the loop runs DRY-RUN: replay + diff + report, NO DB write, NO PR.
 *   - **Circuit-breaker** ({@link "./budget.js".CircuitBreaker}) HALTS the run on
 *     gate-RED, a `require`-mode lease throw (`LeaseUnavailableError`), budget
 *     overrun, or a DB error from the leased section. It does NOT trip on
 *     "daemon OFF" (the normal `local`-mode state).
 *   - **Budget caps** (in-code): `maxTokens` / `maxUsd` / `maxPrs = 1` /
 *     `maxWorktrees = 1`, checked PRE-FLIGHT before each costed step. `MemoryMax=32G`
 *     is an operational launch-wrapper, not an in-code cap.
 *   - **Fix-gen is GATED + DRAFT-PR-ONLY (T11975).** The autonomous fix-generation
 *     stage runs ONLY behind BOTH `execute` AND `CLEO_PI_RUNNER_ENABLED=1` (the
 *     same gates guarding the rest of the loop). It produces a candidate patch via
 *     the E9 LLM chokepoint and lets the EXISTING egress open a DRAFT PR — NEVER
 *     an auto-merge, NEVER an end-user mode, NEVER a `main` push. A failed or empty
 *     fix-gen degrades to "no patch" and the egress simply skips the PR.
 *
 * CORE-first: this engine lives in `core` and owns the `ReplayDispatch` port TYPE;
 * the cleo dispatch handler supplies the concrete adapter (dependency inversion —
 * `core` never imports the cleo-resident dispatcher). Import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/run-loop
 * @epic T11889
 * @task T11913
 */

import type { Logger } from 'pino';
import { type ExecutionEnvBackend, resolveExecutionEnv } from '../llm/pi/resolve-execution-env.js';
import { resolveOrCwd } from '../paths.js';
import { LeaseUnavailableError } from '../store/writer-lease.js';
import { createToolGuard, type ToolGuard } from '../tools/guard.js';
import {
  CircuitBreaker,
  type CircuitBreakerReason,
  type CircuitBreakerState,
  DEFAULT_BUDGET,
  resolveBudget,
  type SelfImproveBudget,
} from './budget.js';
import { createDhqAdapter, type DhqAdapter } from './dhq-adapter.js';
import { type CommandRunner, type DraftPrResult, openDraftPr } from './draft-pr.js';
import { computeQuestionHash, type DiffEntry, diffEnvelopes } from './envelope-diff.js';
import {
  createLlmFixGenerator,
  type FixGenerator,
  type FixGenResult,
  fixPatchPath,
  generateFixPatch,
} from './fix-gen.js';
import { type ReplayDispatch, replayScenario } from './replay.js';
import { type LoadedScenario, loadScenario } from './scenario.js';

/** Options for {@link runSelfImprove}. */
export interface RunSelfImproveOptions {
  /** The canned scenario name to replay (e.g. `'dhq-replay-find'`). */
  readonly scenario: string;
  /**
   * The injected dispatch port — the cleo handler supplies a closure over its
   * `Dispatcher`. CORE owns the TYPE; the impl is injected (dependency inversion).
   */
  readonly dispatch: ReplayDispatch;
  /**
   * When `true`, PERMIT mutation (the leased DHQ UPSERT) + egress (the draft PR).
   * DEFAULT `false`: the loop runs DRY-RUN (replay + diff + report only). This is
   * the hard default-OFF gate — nothing is written or pushed without it.
   *
   * @defaultValue false
   */
  readonly execute?: boolean;
  /** Project working directory for scope resolution + the fallback workspace root. */
  readonly cwd?: string;
  /**
   * The confinement backend the run prefers. Defaults to `'gondolin'` (degrades to
   * the in-process guarded env when the VM infra is absent — the CI path).
   *
   * @defaultValue 'gondolin'
   */
  readonly backend?: ExecutionEnvBackend;
  /** Disposable seeded-copy mount dir for a booted VM (never the live DBs). */
  readonly seededCopyDir?: string;
  /** Optional explicit budget overrides (PRs/worktrees always clamped to 1). */
  readonly budget?: Partial<SelfImproveBudget>;
  /**
   * A pre-flight architectural-gate signal. When this resolves `true` the
   * circuit-breaker trips with `gateRed` BEFORE any persist/egress (never propose
   * a fix that itself regresses a gate). Injected so the engine stays pure of the
   * `cleo check arch` shell-out (the cleo handler supplies it); omitted ⇒ assumed green.
   */
  readonly gateRedCheck?: () => Promise<boolean>;
  /** Test seam: inject a DHQ adapter (defaults to the real leased adapter). */
  readonly adapter?: DhqAdapter;
  /**
   * Test seam: inject the fix generator (the LLM dependency). Defaults to the real
   * {@link "./fix-gen.js".createLlmFixGenerator} backed by the E9 chokepoint — unit
   * tests inject a deterministic fake returning a canned patch so NO real LLM is
   * reached. The fix-gen stage only runs when BOTH `execute` is set AND the
   * Pi-runner gate (`CLEO_PI_RUNNER_ENABLED=1`) is on, unless `piRunnerEnabled` is
   * supplied (test seam) to override the env read.
   */
  readonly fixGenerator?: FixGenerator;
  /**
   * Test seam: override the `CLEO_PI_RUNNER_ENABLED` env gate that arms fix-gen.
   * Defaults to `process.env.CLEO_PI_RUNNER_ENABLED === '1'`. Supplied explicitly
   * by tests so the deterministic fake runs without mutating process env.
   */
  readonly piRunnerEnabled?: boolean;
  /**
   * Test seam: inject the draft-PR egress command runner (captures the git/gh
   * shell-out). Defaults to the real `execFileSync`-backed runner. Supplied by
   * tests so the capstone proves the egress WITHOUT a real `gh`/`git` invocation.
   */
  readonly draftPrRun?: CommandRunner;
  /** Test seam: inject the guard backing the in-process fallback env. */
  readonly guard?: ToolGuard;
  /** Test seam: inject the run id (defaults to a timestamped id). */
  readonly runId?: string;
  /** Test seam: inject a clock (defaults to {@link Date.now}). */
  readonly now?: () => number;
}

/** The terminal status of a self-improvement run. */
export type RunOutcome =
  /** Replay matched the golden — no regression, no DHQ, no PR. */
  | 'green'
  /** Regression found; in dry-run mode (no write / no PR). */
  | 'regression-dry-run'
  /** Regression found; DHQ written + draft PR opened (execute mode). */
  | 'regression-acted'
  /** The circuit-breaker halted the run. */
  | 'halted';

/** The structured result of one {@link runSelfImprove} call. */
export interface SelfImproveResult {
  /** The terminal outcome. */
  readonly outcome: RunOutcome;
  /** The scenario replayed. */
  readonly scenario: string;
  /** The run id (ties any DHQ row to this run). */
  readonly runId: string;
  /** Whether mutation/egress was permitted (`execute`). */
  readonly executed: boolean;
  /** The detected regressions (empty on a green run). */
  readonly regressions: readonly DiffEntry[];
  /** The idempotency `question_hash` for the regression set, or `null` when green. */
  readonly questionHash: string | null;
  /** The draft-PR egress result, or `null` when none fired (green / dry-run-no-egress). */
  readonly draftPr: DraftPrResult | null;
  /**
   * The fix-generation outcome (T11975), or `null` when the stage did not run
   * (green run, dry-run, gate off, or breaker tripped before persist). `'written'`
   * means a candidate patch was produced and the egress was armed; `'skipped'`
   * means fix-gen degraded gracefully (no patch ⇒ no PR).
   */
  readonly fixGen: FixGenResult | null;
  /** The final circuit-breaker state. */
  readonly breaker: CircuitBreakerState;
}

/**
 * Lazily-resolved module logger (import-time side-effect-free).
 */
let cachedLogger: Logger | undefined;
async function getModuleLogger(): Promise<Logger> {
  if (cachedLogger === undefined) {
    const { getLogger } = await import('../logger.js');
    cachedLogger = getLogger('selfimprove-run-loop');
  }
  return cachedLogger;
}

/**
 * Run ONE self-improvement loop iteration.
 *
 * Boots one sandbox, replays the scenario, diffs vs the golden, and — ONLY when
 * `opts.execute` is set AND a regression is found AND the circuit-breaker is closed —
 * emits one leased DHQ row and opens one draft PR. Honors the budget caps and the
 * circuit-breaker throughout (a tripped breaker short-circuits persist + egress to
 * a no-op report).
 *
 * @param opts - See {@link RunSelfImproveOptions}.
 * @returns The structured {@link SelfImproveResult}.
 *
 * @example
 * ```ts
 * // dry-run (default): replay + diff + report, no write, no PR
 * const res = await runSelfImprove({ scenario: 'dhq-replay-find', dispatch });
 * // execute: write a leased DHQ + open ONE draft PR on regression
 * const acted = await runSelfImprove({ scenario: 'dhq-replay-find', dispatch, execute: true });
 * ```
 */
export async function runSelfImprove(opts: RunSelfImproveOptions): Promise<SelfImproveResult> {
  const logger = await getModuleLogger();
  const execute = opts.execute === true;
  const backend = opts.backend ?? 'gondolin';
  const now = opts.now ?? (() => Date.now());
  const runId = opts.runId ?? `selfimprove-${now()}`;
  const budget = resolveBudget(opts.budget ?? {});
  const breaker = new CircuitBreaker(budget);
  const adapter = opts.adapter ?? createDhqAdapter({ cwd: opts.cwd, now });

  const halted = (
    scenario: string,
    regressions: readonly DiffEntry[],
    questionHash: string | null,
  ): SelfImproveResult => ({
    outcome: 'halted',
    scenario,
    runId,
    executed: execute,
    regressions,
    questionHash,
    draftPr: null,
    fixGen: null,
    breaker: breaker.state,
  });

  // ── 1. boot ONE sandbox (counts against maxWorktrees=1) ─────────────────────
  let loaded: LoadedScenario;
  try {
    breaker.chargeOrTrip({ worktrees: 1 });
    loaded = await loadScenario(opts.scenario);
  } catch (err) {
    return tripFromError(breaker, err, logger, opts.scenario, runId, execute);
  }

  const guard = opts.guard ?? createToolGuard({ mode: 'enforce' });
  const workspaceRoot = resolveOrCwd(opts.cwd);
  const env = await resolveExecutionEnv({
    backend,
    guard,
    workspaceRoot,
    ...(opts.seededCopyDir !== undefined ? { seededCopyDir: opts.seededCopyDir } : {}),
  });

  try {
    // ── 2. replay (query-only default — no mutate path fires) ─────────────────
    const replayed = await replayScenario(loaded.scenario, opts.dispatch);

    // ── 3. diff vs golden ─────────────────────────────────────────────────────
    const diff = diffEnvelopes(loaded.scenario.ops, replayed, loaded.golden.envelopes);
    if (diff.regressions.length === 0) {
      logger.debug({ scenario: opts.scenario, runId }, 'self-improve run green — no regression');
      return {
        outcome: 'green',
        scenario: opts.scenario,
        runId,
        executed: execute,
        regressions: [],
        questionHash: null,
        draftPr: null,
        fixGen: null,
        breaker: breaker.state,
      };
    }

    const questionHash = computeQuestionHash(diff);

    // Pre-flight gate check — never act on a fix that would itself regress a gate.
    if (opts.gateRedCheck !== undefined && (await opts.gateRedCheck())) {
      breaker.trip('gateRed', 'cleo check arch --strict reported RED before persist/egress');
      logger.warn(
        { scenario: opts.scenario, runId },
        'self-improve halted: architectural gate RED',
      );
      return halted(opts.scenario, diff.regressions, questionHash);
    }

    // ── default-OFF gate: no write / no PR without --execute ───────────────────
    if (!execute) {
      logger.info(
        { scenario: opts.scenario, runId, regressions: diff.regressions.length },
        'self-improve regression detected (DRY-RUN — no DHQ write, no PR; pass --execute to act)',
      );
      return {
        outcome: 'regression-dry-run',
        scenario: opts.scenario,
        runId,
        executed: false,
        regressions: diff.regressions,
        questionHash,
        draftPr: null,
        fixGen: null,
        breaker: breaker.state,
      };
    }

    // ── 4. emit ONE leased DHQ (require-mode lease throw ⇒ breaker trip) ────────
    const dhqId = `DHQ-${questionHash.slice(0, 8)}`;
    const dhqTitle = `selfimprove regression in '${opts.scenario}' (${diff.regressions.length} path(s))`;
    try {
      await adapter.upsertOpenDhq({
        dhqId,
        scenario: opts.scenario,
        questionHash,
        title: dhqTitle,
        regressionJson: JSON.stringify(diff),
        severity: null,
        runId,
      });
    } catch (err) {
      return tripFromError(
        breaker,
        err,
        logger,
        opts.scenario,
        runId,
        execute,
        diff.regressions,
        questionHash,
      );
    }

    // ── 4b. AUTONOMOUS FIX-GENERATION (T11975) — gated, DRAFT-PR-ONLY ───────────
    // Runs ONLY behind BOTH `execute` AND the Pi-runner gate. Produces a candidate
    // unified-diff patch via the E9 LLM chokepoint at the exact path the egress
    // below `existsSync`-checks. Degrades gracefully (no patch ⇒ the egress guard
    // skips the PR) and NEVER throws a rogue mutation. The outcome is folded back
    // onto the DHQ row (refresh-UPSERT — same leased, idempotent path).
    const piRunnerEnabled = opts.piRunnerEnabled ?? process.env.CLEO_PI_RUNNER_ENABLED === '1';
    let fixGen: FixGenResult | null = null;
    if (piRunnerEnabled) {
      const generator = opts.fixGenerator ?? createLlmFixGenerator({ projectRoot: workspaceRoot });
      fixGen = await generateFixPatch({
        request: {
          dhqId,
          scenario: opts.scenario,
          questionHash,
          regressions: diff.regressions,
          repoContext: {
            projectRoot: workspaceRoot,
            summary: loaded.scenario.description,
          },
        },
        generator,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        logger,
      });
      // Record the fix-gen outcome back onto the open DHQ row (leased, idempotent).
      // A throw here trips the breaker exactly like the initial emit (lease-denial).
      try {
        await adapter.upsertOpenDhq({
          dhqId,
          scenario: opts.scenario,
          questionHash,
          title: dhqTitle,
          regressionJson: JSON.stringify({ diff, fixGen }),
          severity: null,
          runId,
        });
      } catch (err) {
        return tripFromError(
          breaker,
          err,
          logger,
          opts.scenario,
          runId,
          execute,
          diff.regressions,
          questionHash,
        );
      }
    } else {
      logger.info(
        { scenario: opts.scenario, runId },
        'self-improve fix-gen SKIPPED (CLEO_PI_RUNNER_ENABLED!=1) — DHQ emitted, no patch generated',
      );
    }

    // ── 5. open ONE DRAFT PR (counts against maxPrs=1) + record url back ────────
    let draftPr: DraftPrResult | null = null;
    try {
      breaker.chargeOrTrip({ prs: 1 });
      draftPr = await openDraftPr({
        scenario: opts.scenario,
        // SAME path fix-gen writes to (sanitized, resolved against cwd) so the
        // egress `existsSync` guard finds exactly the file 4b produced.
        diffPath: fixPatchPath(opts.scenario, opts.cwd),
        title: `fix(selfimprove): ${opts.scenario} regression`,
        body: `Auto-detected regression in the \`${opts.scenario}\` dogfood scenario (run ${runId}).`,
        execute,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.draftPrRun !== undefined ? { run: opts.draftPrRun } : {}),
      });
      if (draftPr.kind === 'ok') {
        await adapter.recordPrUrl(questionHash, draftPr.prUrl);
      }
    } catch (err) {
      return tripFromError(
        breaker,
        err,
        logger,
        opts.scenario,
        runId,
        execute,
        diff.regressions,
        questionHash,
      );
    }

    return {
      outcome: 'regression-acted',
      scenario: opts.scenario,
      runId,
      executed: true,
      regressions: diff.regressions,
      questionHash,
      draftPr,
      fixGen,
      breaker: breaker.state,
    };
  } finally {
    await env.cleanup();
  }
}

/**
 * Trip the breaker from a thrown error, classifying the reason, and return a
 * `halted` result. A {@link LeaseUnavailableError} maps to `leaseUnavailable`; a
 * {@link "./budget.js".BudgetExceededError} (already self-trips) maps to
 * `budgetOverrun`; everything else from a write path maps to `dbError`.
 */
function tripFromError(
  breaker: CircuitBreaker,
  err: unknown,
  logger: Logger,
  scenario: string,
  runId: string,
  executed: boolean,
  regressions: readonly DiffEntry[] = [],
  questionHash: string | null = null,
): SelfImproveResult {
  let reason: CircuitBreakerReason = 'dbError';
  if (err instanceof LeaseUnavailableError) {
    reason = 'leaseUnavailable';
  } else if (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'E_SELFIMPROVE_BUDGET_EXCEEDED'
  ) {
    reason = 'budgetOverrun';
  }
  const detail = err instanceof Error ? err.message : String(err);
  breaker.trip(reason, detail);
  logger.warn({ scenario, runId, reason, detail }, 'self-improve circuit-breaker tripped');
  return {
    outcome: 'halted',
    scenario,
    runId,
    executed,
    regressions,
    questionHash,
    draftPr: null,
    fixGen: null,
    breaker: breaker.state,
  };
}

export { DEFAULT_BUDGET };
