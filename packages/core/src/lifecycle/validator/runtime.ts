/**
 * Validator Max-N Runtime — Lead↔Worker round-trip orchestration.
 *
 * Drives the canonical Lead → Worker → Validator loop defined by the
 * `cleo-validator` skill ({@link
 * ../../../../../.cleo/skills/cleo-validator/SKILL.md}). For one Worker
 * task, this runtime:
 *
 *  1. Spawns the Validator via the injected `spawnValidator` callback
 *     (T10511's `spawn.validator` SDK tool).
 *  2. Waits for the verdict (attest or reject) OR for an infra-fault to be
 *     emitted by `spawnValidator` / `awaitVerdict`.
 *  3. On `attest`: returns success.
 *  4. On `reject` (semantic fault: the Worker's code is wrong): increments
 *     the shared retry counter, re-spawns the Worker with rejection
 *     findings, then re-spawns the Validator.
 *  5. On infra-fault (timeout, conduit-drop, validator-OOM): increments
 *     the SHARED retry counter, applies the canonical Max-N row (retry
 *     count, backoff strategy, transient/permanent classification) and
 *     either re-spawns a FRESH Validator or escalates to Lead.
 *
 * ## Design contract
 *
 * The runtime is decoupled from T10511's concrete SDK-tool implementations
 * via the {@link ValidatorRuntimeDeps} injection contract — callers pass
 * functions that produce verdicts / fault classifications. Unit tests stub
 * those callbacks; production wiring (a follow-up task) supplies the real
 * `spawn.validator`, `validator.attest`, `validator.reject`, and
 * `validator.evidence-run` adapters.
 *
 * ## Shared retry-counter accounting (VAL-007 + Max-N table)
 *
 * Both semantic faults (REJECT) AND infra faults (timeout / conduit-drop /
 * validator-OOM) increment the SAME `validatorRetryAttempts` counter,
 * bounded by `validatorRetryMax` (default N=3). This prevents an
 * adversarial alternation where a Worker flips between fault families to
 * bypass the cap (e.g. REJECT → timeout → REJECT → timeout → ... forever).
 *
 * ## Audit trail
 *
 * Every retry attempt — semantic OR infra — appends ONE line to
 * `<projectRoot>/.cleo/audit/validator-retries.jsonl`. Each line is
 * standalone JSON ({@link ValidatorRetryAuditEntry}) and includes
 * `timestamp`, `taskId`, `attemptNumber`, `faultKind`, `classification`,
 * and `retryDecision`. The append-only convention matches
 * `force-bypass.jsonl` and `contract-violations.jsonl`.
 *
 * @module lifecycle/validator/runtime
 * @task T10512
 * @epic T10383
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ValidatorRejection, ValidatorVerdict } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { getProjectRoot } from '../../paths.js';

const log = getLogger('lifecycle:validator:runtime');

// =============================================================================
// CONSTANTS — canonical Max-N table rows (SKILL.md §Success Criteria)
// =============================================================================

/**
 * Default shared retry cap (semantic + infra). Configurable via the
 * `validatorRetryMax` option on {@link runValidatorMaxN}. Mirrors
 * `delegation.validatorRetryMax` from the SKILL.md.
 *
 * @task T10512
 */
export const DEFAULT_VALIDATOR_RETRY_MAX = 3;

/**
 * Default subagent timeout in milliseconds before a Validator spawn is
 * classified as an infra-fault `timeout`. Mirrors `subagentTimeoutSeconds`
 * (300 s) from the SKILL.md tier-1 default.
 *
 * @task T10512
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;

/**
 * Canonical Max-N row catalogue keyed by fault kind. Every fault produced
 * by `spawnValidator` / `awaitVerdict` resolves to ONE of these rows.
 *
 * `retryCount` is the per-row cap (not the shared cap); the shared cap
 * (`validatorRetryMax`) overrides per-row caps when reached first.
 *
 * `backoff` is the strategy applied BEFORE the next retry attempt:
 *  - `exponential(b, m)` — sleeps `b` then `m` (clamped by maxDelayMs)
 *  - `immediate` — zero delay
 *  - `immediate-downgrade` — zero delay PLUS model-tier downgrade
 *    (e.g. Sonnet → Haiku) requested via the spawn callback
 *
 * `classification`:
 *  - `transient` — retryable; continues consuming the shared counter
 *  - `permanent` — non-retryable; short-circuits to HITL on FIRST occurrence
 *
 * @task T10512
 */
export const MAX_N_ROWS = {
  // ────────────────────────────────────────────────────────────────────────
  // Semantic faults — Validator decided but couldn't reach a verdict
  // ────────────────────────────────────────────────────────────────────────
  'validator-rejected-no-acs': {
    family: 'semantic' as const,
    retryCount: 0,
    backoff: { kind: 'immediate' as const },
    classification: 'permanent' as const,
    escalationAtom: 'E_VALIDATOR_NO_ACS',
  },
  'validator-partial': {
    family: 'semantic' as const,
    retryCount: 1,
    backoff: { kind: 'immediate' as const },
    classification: 'transient' as const,
    escalationAtom: 'E_VALIDATOR_PARTIAL',
  },
  'validator-unreachable': {
    family: 'semantic' as const,
    retryCount: 2,
    backoff: { kind: 'exponential' as const, firstMs: 10_000, secondMs: 30_000 },
    classification: 'transient' as const,
    escalationAtom: 'E_VALIDATOR_UNREACHABLE',
  },
  'tool-not-resolved': {
    family: 'semantic' as const,
    retryCount: 0,
    backoff: { kind: 'immediate' as const },
    classification: 'permanent' as const,
    escalationAtom: 'E_TOOL_NOT_RESOLVED',
  },
  // ────────────────────────────────────────────────────────────────────────
  // Infra faults — Validator process / transport itself failed
  // ────────────────────────────────────────────────────────────────────────
  timeout: {
    family: 'infra' as const,
    retryCount: 2,
    backoff: { kind: 'exponential' as const, firstMs: 5_000, secondMs: 30_000 },
    classification: 'transient' as const,
    escalationAtom: 'E_VALIDATOR_TIMEOUT',
  },
  'conduit-drop': {
    family: 'infra' as const,
    retryCount: 3,
    backoff: { kind: 'immediate' as const },
    classification: 'transient' as const,
    escalationAtom: 'E_VALIDATOR_VERDICT_DROPPED',
  },
  'validator-OOM': {
    family: 'infra' as const,
    retryCount: 1,
    backoff: { kind: 'immediate-downgrade' as const },
    classification: 'transient-then-permanent' as const,
    escalationAtom: 'E_VALIDATOR_OOM',
  },
} as const;

/**
 * Canonical fault kinds — the keys of {@link MAX_N_ROWS}.
 *
 * @task T10512
 */
export type ValidatorFaultKind = keyof typeof MAX_N_ROWS;

/**
 * Canonical fault families. Semantic faults are decisions by the Validator
 * (or its tools); infra faults are process/transport failures.
 *
 * @task T10512
 */
export type ValidatorFaultFamily = 'semantic' | 'infra';

/**
 * Backoff strategy applied between retries.
 *
 *  - `immediate` — zero delay
 *  - `exponential` — `firstMs` before the first retry, `secondMs` before any
 *    subsequent retries within the same row
 *  - `immediate-downgrade` — zero delay AND the next spawn should request a
 *    smaller model tier (e.g. Sonnet → Haiku) to fit a tighter context
 *
 * @task T10512
 */
export type BackoffStrategy =
  | { kind: 'immediate' }
  | { kind: 'exponential'; firstMs: number; secondMs: number }
  | { kind: 'immediate-downgrade' };

// =============================================================================
// FAULT — uniform fault envelope returned by spawn / await callbacks
// =============================================================================

/**
 * Uniform fault envelope returned by {@link ValidatorRuntimeDeps.spawnValidator}
 * or {@link ValidatorRuntimeDeps.awaitVerdict} when something goes wrong.
 *
 * The runtime resolves `kind` against {@link MAX_N_ROWS} to pick the retry
 * policy.
 *
 * @task T10512
 */
export interface ValidatorFault {
  kind: ValidatorFaultKind;
  /** Free-form diagnostic from the failing callback. */
  message: string;
  /**
   * Optional structured detail — captured into the audit row's `detail`
   * field for post-mortem analysis.
   */
  detail?: Record<string, unknown>;
}

// =============================================================================
// DEPS — injectable contract that the runtime DRIVES
// =============================================================================

/**
 * Spawn-request envelope passed to {@link ValidatorRuntimeDeps.spawnValidator}.
 *
 * @task T10512
 */
export interface ValidatorSpawnRequest {
  /** Worker task being validated. */
  workerTaskId: string;
  /** Attempt number (1-based; resets to 1 on Worker re-spawn). */
  attemptNumber: number;
  /**
   * When true (set after a `validator-OOM` infra fault) the spawner SHOULD
   * downgrade the model tier (e.g. Sonnet → Haiku) for this attempt to
   * shrink the context window. The spawner is responsible for the actual
   * model selection; this flag is advisory.
   */
  downgradeModelTier?: boolean;
  /**
   * On Worker re-spawn after a REJECT, this carries the rejection envelope
   * the Worker should use to fix the failing ACs. Absent on Validator-only
   * spawns.
   */
  workerRespawnContext?: {
    rejection: ValidatorRejection;
  };
}

/**
 * Result envelope returned by {@link ValidatorRuntimeDeps.spawnValidator} or
 * {@link ValidatorRuntimeDeps.awaitVerdict}: either a verdict (success) or a
 * fault classification.
 *
 * @task T10512
 */
export type ValidatorRoundResult =
  | { ok: true; verdict: ValidatorVerdict }
  | { ok: false; fault: ValidatorFault };

/**
 * Worker re-spawn callback — invoked when the Validator returns a
 * REJECT verdict (semantic fault: the Worker's code is wrong, not an infra
 * failure). The callback is responsible for re-dispatching the Worker with
 * the rejection findings as feedback.
 *
 * Returns the new worker submission state OR a fault (e.g. the Worker
 * itself crashed during re-spawn).
 *
 * @task T10512
 */
export type WorkerRespawnFn = (
  workerTaskId: string,
  rejection: ValidatorRejection,
  attemptNumber: number,
) => Promise<{ ok: true } | { ok: false; fault: ValidatorFault }>;

/**
 * Injectable dependency contract for the validator Max-N runtime. Callers
 * (production wiring AND tests) supply functions that wrap the underlying
 * T10511 SDK tools. The runtime never imports T10511 directly.
 *
 * @task T10512
 */
export interface ValidatorRuntimeDeps {
  /**
   * Spawn a Validator subagent and return either the verdict OR a fault.
   * The implementer is responsible for the timeout budget — when the
   * subagent exceeds `subagentTimeoutSeconds` the implementer MUST return
   * `{ ok: false, fault: { kind: 'timeout', ... } }`.
   */
  spawnValidator(req: ValidatorSpawnRequest): Promise<ValidatorRoundResult>;
  /**
   * Re-spawn the Worker with rejection findings. The implementer is
   * responsible for re-dispatching the Worker and feeding the rejection
   * envelope into the Worker's spawn prompt.
   */
  respawnWorker: WorkerRespawnFn;
  /**
   * Sleep callback (injectable for deterministic tests). Receives the
   * backoff delay in ms; in tests this can be a no-op.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Clock callback (injectable for deterministic tests). Returns ISO
   * timestamps used in audit entries.
   */
  now?: () => string;
}

// =============================================================================
// OPTIONS — caller-facing options
// =============================================================================

/**
 * Options passed to {@link runValidatorMaxN}. All fields are optional with
 * canonical defaults.
 *
 * @task T10512
 */
export interface RunValidatorMaxNOptions {
  /**
   * Shared retry cap (semantic + infra combined). Defaults to
   * {@link DEFAULT_VALIDATOR_RETRY_MAX} (3).
   */
  validatorRetryMax?: number;
  /**
   * Project root used to write the audit JSONL. Defaults to the CLEO
   * project root resolved via `getProjectRoot()`. Tests should pass an
   * explicit temp dir.
   */
  projectRoot?: string;
  /**
   * When true, the audit appender is suppressed entirely (used by tests
   * that want to assert behaviour WITHOUT touching the filesystem).
   */
  suppressAudit?: boolean;
}

// =============================================================================
// RESULT — terminal outcome envelope
// =============================================================================

/**
 * Terminal outcome of {@link runValidatorMaxN}. The runtime always reaches
 * ONE of three terminal states:
 *
 *  - `attest` — happy path; Validator returned an attestation
 *  - `escalate-hitl` — retry budget exhausted OR permanent fault; Lead must
 *    take over (file a HITL approval gate)
 *  - `escalate-permanent` — first-occurrence permanent fault (e.g. `no-acs`)
 *
 * The `attempts` array preserves the full audit trail in memory for the
 * caller (in addition to the on-disk JSONL).
 *
 * @task T10512
 */
export type ValidatorRuntimeResult =
  | {
      outcome: 'attest';
      taskId: string;
      verdict: ValidatorVerdict & { verdict: 'attest' };
      attempts: ValidatorRetryAuditEntry[];
    }
  | {
      outcome: 'escalate-hitl';
      taskId: string;
      reason: string;
      attempts: ValidatorRetryAuditEntry[];
    }
  | {
      outcome: 'escalate-permanent';
      taskId: string;
      fault: ValidatorFault;
      reason: string;
      attempts: ValidatorRetryAuditEntry[];
    };

// =============================================================================
// AUDIT — JSONL row shape
// =============================================================================

/**
 * Canonical path (relative to project root) for the validator-retry audit
 * log. Append-only JSONL — one row per retry attempt.
 *
 * @task T10512
 */
export const VALIDATOR_RETRIES_AUDIT_FILE = '.cleo/audit/validator-retries.jsonl';

/**
 * One row in `.cleo/audit/validator-retries.jsonl`. Append-only, one line
 * per retry attempt (semantic OR infra). Matches the
 * `force-bypass.jsonl` / `contract-violations.jsonl` append-only pattern.
 *
 * @task T10512
 */
export interface ValidatorRetryAuditEntry {
  /** ISO-8601 timestamp at which this row was written. */
  timestamp: string;
  /** Worker task ID under validation. */
  taskId: string;
  /**
   * 1-based attempt number against the SHARED retry counter. A run that
   * succeeds first try emits exactly one row with `attemptNumber: 1` and
   * `outcome: 'attest'`.
   */
  attemptNumber: number;
  /** Family of the fault that triggered this row, or `null` on success. */
  faultFamily: ValidatorFaultFamily | null;
  /** Canonical fault kind, or `null` on success. */
  faultKind: ValidatorFaultKind | null;
  /** Transient / permanent classification, or `null` on success. */
  classification: 'transient' | 'permanent' | 'transient-then-permanent' | null;
  /** Backoff applied BEFORE the next attempt, or `null` if no next attempt. */
  backoffMs: number | null;
  /**
   * Retry decision the runtime took at this row:
   *   - `retry-validator`     — re-spawn a fresh Validator
   *   - `retry-worker`        — Validator rejected; re-spawn Worker with findings
   *   - `escalate-hitl`       — counter exhausted; Lead takes over
   *   - `escalate-permanent`  — permanent fault; short-circuit to HITL
   *   - `attest`              — happy path; Validator returned attestation
   */
  retryDecision:
    | 'retry-validator'
    | 'retry-worker'
    | 'escalate-hitl'
    | 'escalate-permanent'
    | 'attest';
  /** Free-form diagnostic carried from the underlying fault. */
  message: string;
  /** Structured detail captured for post-mortem analysis. */
  detail?: Record<string, unknown>;
}

// =============================================================================
// PUBLIC API — runValidatorMaxN
// =============================================================================

/**
 * Run the Lead↔Worker↔Validator Max-N retry loop for one Worker task.
 *
 * @remarks
 * Drives the canonical state machine documented in the `cleo-validator`
 * SKILL.md "Execution Flow" + "Max-N infra-fault row catalogue" sections.
 *
 * The shared counter (`validatorRetryAttempts`) advances on EVERY fault
 * regardless of family — this is the documented defence against
 * adversarial fault-kind alternation (a Worker / Validator pairing that
 * flips between REJECT and `timeout` would otherwise bypass the cap).
 *
 * The runtime is purely orchestration — it never calls `cleo verify`,
 * never mutates the Worker's gate ledger, never modifies the worktree.
 * All side effects flow through the injected {@link ValidatorRuntimeDeps}.
 *
 * @example
 * ```ts
 * import { runValidatorMaxN } from '@cleocode/core/lifecycle/validator/runtime';
 *
 * const result = await runValidatorMaxN('T1234', {
 *   spawnValidator: async (req) => {
 *     // Production: call spawn.validator from T10511 SDK tools.
 *     return await sdk.spawn.validator(req);
 *   },
 *   respawnWorker: async (taskId, rejection, attemptNumber) => {
 *     // Production: dispatch worker with rejection envelope.
 *     return await sdk.spawn.worker({ taskId, rejection, attemptNumber });
 *   },
 * });
 *
 * if (result.outcome === 'attest') {
 *   // Happy path — Lead can mark the task done.
 * } else if (result.outcome === 'escalate-hitl') {
 *   // Lead opens a HITL approval gate.
 * } else {
 *   // Permanent fault — Lead routes to AC-backfill or infra team.
 * }
 * ```
 *
 * @param workerTaskId - Worker task ID (e.g. `'T1234'`).
 * @param deps - Injectable runtime dependencies (spawn / respawn / sleep / now).
 * @param opts - Optional caller overrides (retry cap, audit path, etc.).
 * @returns The terminal outcome envelope + in-memory audit trail.
 *
 * @task T10512
 */
export async function runValidatorMaxN(
  workerTaskId: string,
  deps: ValidatorRuntimeDeps,
  opts: RunValidatorMaxNOptions = {},
): Promise<ValidatorRuntimeResult> {
  const validatorRetryMax = opts.validatorRetryMax ?? DEFAULT_VALIDATOR_RETRY_MAX;
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? defaultSleep;
  const attempts: ValidatorRetryAuditEntry[] = [];

  // Counter increments on EVERY fault. Shared between semantic + infra
  // families per Saga T10377 VAL-007 + SKILL.md Max-N table footnote.
  let validatorRetryAttempts = 0;

  // OOM-downgrade state — set to true after the first validator-OOM fault
  // so the NEXT spawn requests a smaller model tier.
  let downgradeNext = false;

  // Per-row attempt counts — each row's own `retryCount` is the cap
  // INSIDE the row. The shared counter is the OUTER cap.
  const perRowAttempts: Partial<Record<ValidatorFaultKind, number>> = {};

  while (true) {
    const attemptNumber = validatorRetryAttempts + 1;

    // 1. Spawn validator (single round).
    const spawnReq: ValidatorSpawnRequest = {
      workerTaskId,
      attemptNumber,
      ...(downgradeNext ? { downgradeModelTier: true } : {}),
    };
    downgradeNext = false; // consume the downgrade flag

    let round: ValidatorRoundResult;
    try {
      round = await deps.spawnValidator(spawnReq);
    } catch (err) {
      // A throw from spawnValidator is treated as a `timeout` infra-fault —
      // the implementer is supposed to translate timeouts into a fault
      // envelope, but defence-in-depth handles thrown errors uniformly.
      round = {
        ok: false,
        fault: {
          kind: 'timeout',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // 2a. ATTEST — happy path; emit success audit row and return.
    if (round.ok && round.verdict.verdict === 'attest') {
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: null,
        faultKind: null,
        classification: null,
        backoffMs: null,
        retryDecision: 'attest',
        message: 'Validator attested all ACs',
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);
      return {
        outcome: 'attest',
        taskId: workerTaskId,
        verdict: round.verdict,
        attempts,
      };
    }

    // 2b. REJECT — semantic fault; loop back to Worker.
    if (round.ok && round.verdict.verdict === 'reject') {
      validatorRetryAttempts += 1;

      // Check shared counter cap BEFORE re-spawning Worker.
      if (validatorRetryAttempts >= validatorRetryMax) {
        const entry: ValidatorRetryAuditEntry = {
          timestamp: now(),
          taskId: workerTaskId,
          attemptNumber,
          faultFamily: 'semantic',
          faultKind: 'validator-partial', // closest canonical kind for a REJECT
          classification: 'transient',
          backoffMs: null,
          retryDecision: 'escalate-hitl',
          message: `Validator REJECT — shared retry cap (${validatorRetryMax}) reached`,
          detail: { summary: round.verdict.summary },
        };
        attempts.push(entry);
        writeAuditEntry(entry, opts);
        return {
          outcome: 'escalate-hitl',
          taskId: workerTaskId,
          reason: `Validator rejected after ${validatorRetryAttempts} attempt(s); shared retry cap reached. Last summary: ${round.verdict.summary}`,
          attempts,
        };
      }

      // Under cap — emit audit row, re-spawn Worker, loop.
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: 'semantic',
        faultKind: 'validator-partial',
        classification: 'transient',
        backoffMs: 0,
        retryDecision: 'retry-worker',
        message: `Validator REJECT — re-spawning Worker with rejection findings`,
        detail: { summary: round.verdict.summary },
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);

      const respawn = await safeRespawnWorker(
        deps.respawnWorker,
        workerTaskId,
        round.verdict,
        attemptNumber,
      );
      if (!respawn.ok) {
        // Worker re-spawn failed — treat as an infra fault on the worker side.
        return classifyAndEscalateRespawnFailure(
          workerTaskId,
          respawn.fault,
          attemptNumber,
          attempts,
          opts,
          now,
        );
      }
      // Continue loop; next iteration spawns a fresh Validator.
      continue;
    }

    // 2c. INFRA / SEMANTIC fault from the Validator side.
    const fault = round.ok ? null : round.fault;
    if (!fault) {
      // Defensive — round.ok===false MUST yield a fault; safety net.
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: 'infra',
        faultKind: 'timeout',
        classification: 'transient',
        backoffMs: null,
        retryDecision: 'escalate-hitl',
        message: 'spawnValidator returned ok=false with no fault envelope',
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);
      return {
        outcome: 'escalate-hitl',
        taskId: workerTaskId,
        reason: 'spawnValidator returned ok=false with no fault envelope',
        attempts,
      };
    }

    const row = MAX_N_ROWS[fault.kind];
    perRowAttempts[fault.kind] = (perRowAttempts[fault.kind] ?? 0) + 1;
    validatorRetryAttempts += 1;

    // 2c-i. PERMANENT classification — short-circuit on first occurrence.
    // For `transient-then-permanent`, the FIRST occurrence is still
    // transient (we retry once with downgrade); the SECOND becomes permanent.
    const isPermanentNow =
      row.classification === 'permanent' ||
      (row.classification === 'transient-then-permanent' &&
        (perRowAttempts[fault.kind] ?? 0) > row.retryCount);

    if (isPermanentNow) {
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: row.family,
        faultKind: fault.kind,
        classification: row.classification,
        backoffMs: null,
        retryDecision: 'escalate-permanent',
        message: `Permanent fault (${row.escalationAtom}) — ${fault.message}`,
        ...(fault.detail ? { detail: fault.detail } : {}),
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);
      return {
        outcome: 'escalate-permanent',
        taskId: workerTaskId,
        fault,
        reason: `Permanent fault: ${row.escalationAtom} — ${fault.message}`,
        attempts,
      };
    }

    // 2c-ii. Shared retry cap reached — escalate to HITL.
    if (validatorRetryAttempts >= validatorRetryMax) {
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: row.family,
        faultKind: fault.kind,
        classification: row.classification,
        backoffMs: null,
        retryDecision: 'escalate-hitl',
        message: `${fault.kind} — shared retry cap (${validatorRetryMax}) reached. ${fault.message}`,
        ...(fault.detail ? { detail: fault.detail } : {}),
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);
      return {
        outcome: 'escalate-hitl',
        taskId: workerTaskId,
        reason: `Shared retry cap reached after ${row.escalationAtom}: ${fault.message}`,
        attempts,
      };
    }

    // 2c-iii. Per-row cap reached (but shared cap not) — also escalate.
    // This handles the case where ONLY this fault kind keeps recurring.
    if ((perRowAttempts[fault.kind] ?? 0) > row.retryCount) {
      const entry: ValidatorRetryAuditEntry = {
        timestamp: now(),
        taskId: workerTaskId,
        attemptNumber,
        faultFamily: row.family,
        faultKind: fault.kind,
        classification: row.classification,
        backoffMs: null,
        retryDecision: 'escalate-hitl',
        message: `${fault.kind} — per-row retry cap (${row.retryCount}) reached. ${fault.message}`,
        ...(fault.detail ? { detail: fault.detail } : {}),
      };
      attempts.push(entry);
      writeAuditEntry(entry, opts);
      return {
        outcome: 'escalate-hitl',
        taskId: workerTaskId,
        reason: `Per-row retry cap reached for ${row.escalationAtom}: ${fault.message}`,
        attempts,
      };
    }

    // 2c-iv. Retry — compute backoff, set downgrade flag for OOM, emit audit, sleep.
    const backoffMs = resolveBackoffMs(row.backoff, perRowAttempts[fault.kind] ?? 1);
    if (row.backoff.kind === 'immediate-downgrade') {
      downgradeNext = true;
    }

    const entry: ValidatorRetryAuditEntry = {
      timestamp: now(),
      taskId: workerTaskId,
      attemptNumber,
      faultFamily: row.family,
      faultKind: fault.kind,
      classification: row.classification,
      backoffMs,
      retryDecision: 'retry-validator',
      message: fault.message,
      ...(fault.detail ? { detail: fault.detail } : {}),
    };
    attempts.push(entry);
    writeAuditEntry(entry, opts);

    if (backoffMs > 0) {
      await sleep(backoffMs);
    }
    // Loop continues — next iteration spawns a fresh Validator.
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Resolve the delay in milliseconds for a given backoff strategy and the
 * 1-based per-row attempt number (1 = first retry, 2 = second retry, ...).
 *
 * Internal — exported for unit testing only.
 *
 * @task T10512
 */
export function resolveBackoffMs(strategy: BackoffStrategy, perRowAttempt: number): number {
  if (strategy.kind === 'immediate' || strategy.kind === 'immediate-downgrade') return 0;
  // exponential — first retry uses firstMs; any subsequent retry uses secondMs
  return perRowAttempt <= 1 ? strategy.firstMs : strategy.secondMs;
}

/**
 * Wrap the user-supplied `respawnWorker` callback in try/catch — a thrown
 * error becomes a uniform `timeout` fault envelope so the runtime never
 * propagates unhandled rejections.
 */
async function safeRespawnWorker(
  fn: WorkerRespawnFn,
  workerTaskId: string,
  rejection: ValidatorRejection,
  attemptNumber: number,
): Promise<{ ok: true } | { ok: false; fault: ValidatorFault }> {
  try {
    return await fn(workerTaskId, rejection, attemptNumber);
  } catch (err) {
    return {
      ok: false,
      fault: {
        kind: 'timeout',
        message: `Worker respawn threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Convert a Worker re-spawn failure into a terminal `escalate-hitl`
 * outcome. The Worker side isn't subject to the same Max-N row catalogue
 * (those are Validator-side failures); treat any Worker re-spawn failure
 * as immediate HITL.
 */
function classifyAndEscalateRespawnFailure(
  workerTaskId: string,
  fault: ValidatorFault,
  attemptNumber: number,
  attempts: ValidatorRetryAuditEntry[],
  opts: RunValidatorMaxNOptions,
  now: () => string,
): ValidatorRuntimeResult {
  const entry: ValidatorRetryAuditEntry = {
    timestamp: now(),
    taskId: workerTaskId,
    attemptNumber,
    faultFamily: 'infra',
    faultKind: fault.kind,
    classification: 'transient',
    backoffMs: null,
    retryDecision: 'escalate-hitl',
    message: `Worker respawn failed: ${fault.message}`,
    ...(fault.detail ? { detail: fault.detail } : {}),
  };
  attempts.push(entry);
  writeAuditEntry(entry, opts);
  return {
    outcome: 'escalate-hitl',
    taskId: workerTaskId,
    reason: `Worker re-spawn failed: ${fault.message}`,
    attempts,
  };
}

/**
 * Append one entry to the audit JSONL. Best-effort — errors are logged but
 * swallowed so audit writes never block the orchestration loop.
 *
 * Matches the append-only convention used by
 * {@link appendContractViolation} and the legacy `force-bypass.jsonl`
 * writer.
 */
function writeAuditEntry(entry: ValidatorRetryAuditEntry, opts: RunValidatorMaxNOptions): void {
  if (opts.suppressAudit === true) return;
  try {
    const root = opts.projectRoot ?? getProjectRoot();
    const filePath = join(root, VALIDATOR_RETRIES_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch (err) {
    log.warn({ err }, 'Failed to append validator-retries audit entry');
  }
}

/**
 * Default sleep implementation — promisified `setTimeout`.
 *
 * Internal — overridable via {@link ValidatorRuntimeDeps.sleep} for tests.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
