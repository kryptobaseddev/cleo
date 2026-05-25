/**
 * Validator role contracts — types consumed by the SDK tools (T10511) and the
 * Max-N runtime (T10512) to express the verdict a Validator agent returns
 * after reviewing a Worker submission against a task's acceptance criteria.
 *
 * The Validator is a NEW canonical role in the orchestration hierarchy,
 * orthogonal to the existing Orchestrator → Lead → Worker triad. A Validator
 * does NOT execute work and does NOT spawn other agents — it ONLY attests or
 * rejects work claimed-done by another agent, per-AC.
 *
 * Identity triad:
 *  - `agentId` follows the pattern `validator-<discriminator>` (e.g.
 *    `validator-prime`, `validator-sec-001`).
 *  - `role` is `'validator'` (see {@link AgentRole}).
 *  - `sigilCard` is reused as-is from the existing peer/memory layer when
 *    the Validator is registered as a CANT-defined persona.
 *
 * Design constraints (ADR-055 / D028 boundary rules):
 *  - Lives in `packages/contracts/` — ZERO runtime dependencies (Zod only).
 *  - Consumed by `packages/cleo-sdk-tools/` (T10511) and `packages/core/` (T10512).
 *  - No cross-package relative imports.
 *
 * @module validator
 * @task T10510
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { z } from 'zod';

// ============================================================================
// AgentRole — canonical role enum with Validator extension
// ============================================================================

/**
 * Canonical agent role classification across the CLEO orchestration hierarchy.
 *
 * Mirrors the three-tier model in {@link PeerKind} / {@link AgentSpawnCapability}
 * with an additional `validator` tier introduced by Saga T10377
 * SG-IVTR-AC-BINDING:
 *
 *  - `orchestrator` — coordinates multi-agent workflows; may spawn leads and workers
 *  - `lead`         — specialist; dispatches workers only
 *  - `worker`       — terminal executor; may not spawn
 *  - `validator`    — terminal reviewer; attests or rejects another agent's
 *                     work against the task's acceptance criteria. Does NOT
 *                     execute work and does NOT spawn other agents.
 *
 * This type is ADDITIVE to the existing per-file role unions
 * (`PeerKind` in `peer.ts`, `AgentSpawnCapability` in `agent-registry-v3.ts`,
 * `CLEO_AGENT_ROLE` in `branch-lock.ts`, etc.). Existing unions are
 * intentionally UNCHANGED — call sites that need the Validator role
 * import {@link AgentRole} from this module.
 *
 * @task T10510
 * @epic T10383
 */
export type AgentRole = 'orchestrator' | 'lead' | 'worker' | 'validator';

/**
 * Frozen list of canonical {@link AgentRole} values for runtime iteration
 * (e.g. CLI flag validation, registry seeding).
 *
 * @task T10510
 * @epic T10383
 */
export const AGENT_ROLES = ['orchestrator', 'lead', 'worker', 'validator'] as const;

/**
 * Type guard for {@link AgentRole}. Returns `true` when `value` is one of the
 * four canonical role strings.
 *
 * @task T10510
 */
export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value);
}

// ============================================================================
// ValidatorFinding — per-AC reasoning row
// ============================================================================

/**
 * Status of a single Validator finding against one acceptance criterion.
 *
 *  - `pass`         — the AC is satisfied by the Worker's submission
 *  - `fail`         — the AC is NOT satisfied; the Validator rejects this AC
 *  - `inconclusive` — the Validator cannot determine pass/fail from the
 *                     evidence presented (e.g. missing artifact, ambiguous
 *                     wording). A Verdict containing any `inconclusive`
 *                     finding is treated as a {@link ValidatorRejection} —
 *                     the Worker MUST clarify and re-submit.
 *
 * @task T10510
 */
export type ValidatorFindingStatus = 'pass' | 'fail' | 'inconclusive';

/**
 * Single Validator finding scoped to one acceptance criterion.
 *
 * Produced per-AC during validator review and aggregated into either a
 * {@link ValidatorAttestation} (all pass) or {@link ValidatorRejection}
 * (any fail or inconclusive). Each finding carries the AC's stable UUID
 * (matching `task_acceptance_criteria.id` — see {@link AcRow}) so downstream
 * persistence (T10503 / T10509 AC-bindings) can join findings to ACs
 * without depending on ordinal position.
 *
 * @task T10510
 * @epic T10383
 */
export interface ValidatorFinding {
  /**
   * Stable AC identifier (UUIDv4) matching
   * `task_acceptance_criteria.id`. See {@link AcRow.id}.
   */
  acId: string;
  /** Pass / fail / inconclusive verdict for this AC. */
  status: ValidatorFindingStatus;
  /**
   * Free-text reasoning explaining the verdict. Required for `fail` and
   * `inconclusive`; recommended (but optional via the runtime guard) for
   * `pass` so reviewers can audit the chain-of-thought later.
   */
  reasoning: string;
  /**
   * Optional evidence references that backed this finding — e.g. test
   * file paths, commit shas, doc URLs. Free-form strings; the schema
   * intentionally does NOT validate format here so the SDK tools layer
   * (T10511) can shape its own evidence-atom narrowing.
   */
  evidenceRefs?: string[];
  /** ISO-8601 timestamp at which this finding was recorded. */
  checkedAt: string;
}

// ============================================================================
// ValidatorAttestation — accept verdict envelope
// ============================================================================

/**
 * Envelope returned by a Validator when the Worker's submission passes
 * EVERY acceptance criterion on the task.
 *
 * Discriminated by `verdict: 'attest'`. When at least one finding has
 * status `'fail'` or `'inconclusive'`, the Validator MUST emit a
 * {@link ValidatorRejection} instead — never a partial-pass attestation.
 *
 * @task T10510
 * @epic T10383
 */
export interface ValidatorAttestation {
  /** Discriminant — always `'attest'`. */
  verdict: 'attest';
  /** Task being attested. Matches `tasks.id`. */
  taskId: string;
  /**
   * Stable Validator agent identifier following the pattern
   * `validator-<discriminator>` (e.g. `validator-prime`).
   */
  validatorId: string;
  /**
   * Per-AC findings. MUST contain one entry per AC on the task; EVERY
   * entry MUST have `status: 'pass'`. The runtime validator
   * ({@link isValidatorAttestation}) enforces this invariant.
   */
  findings: ValidatorFinding[];
  /**
   * Optional summary paragraph the Validator may include to capture
   * holistic observations (e.g. "all 5 ACs pass; the implementation
   * also tightened the error message in foo.ts which I checked").
   */
  summary?: string;
  /** ISO-8601 timestamp at which the verdict was finalized. */
  attestedAt: string;
  /**
   * Schema version for forward-compatible evolution. Pin to `'1'` for
   * the initial T10510 contract.
   */
  schemaVersion: '1';
}

// ============================================================================
// ValidatorRejection — refuse verdict envelope
// ============================================================================

/**
 * Envelope returned by a Validator when at least one acceptance criterion
 * fails or is inconclusive.
 *
 * Discriminated by `verdict: 'reject'`. The `findings` array MUST contain
 * AT LEAST ONE entry with status `'fail'` or `'inconclusive'`; otherwise
 * the Validator should have emitted a {@link ValidatorAttestation}.
 *
 * @task T10510
 * @epic T10383
 */
export interface ValidatorRejection {
  /** Discriminant — always `'reject'`. */
  verdict: 'reject';
  /** Task being rejected. Matches `tasks.id`. */
  taskId: string;
  /**
   * Stable Validator agent identifier following the pattern
   * `validator-<discriminator>` (e.g. `validator-prime`).
   */
  validatorId: string;
  /**
   * Per-AC findings. MUST contain one entry per AC on the task; AT
   * LEAST ONE entry MUST have `status: 'fail'` or `'inconclusive'`.
   */
  findings: ValidatorFinding[];
  /**
   * Required summary paragraph describing the high-level reason for
   * rejection. Distinct from per-AC `reasoning` — this is the
   * human-facing message shown when the Worker is told to revise.
   */
  summary: string;
  /**
   * Suggested remediation steps. Free-form list of strings — the SDK
   * tools layer (T10511) is responsible for any structured shape.
   */
  remediationHints?: string[];
  /** ISO-8601 timestamp at which the verdict was finalized. */
  rejectedAt: string;
  /**
   * Schema version for forward-compatible evolution. Pin to `'1'` for
   * the initial T10510 contract.
   */
  schemaVersion: '1';
}

// ============================================================================
// ValidatorVerdict — discriminated union
// ============================================================================

/**
 * Discriminated union over the two Validator outcomes. Narrow via the
 * `verdict` discriminant:
 *
 * ```ts
 * function handle(v: ValidatorVerdict) {
 *   if (v.verdict === 'attest') {
 *     // v is ValidatorAttestation — every finding passes
 *   } else {
 *     // v is ValidatorRejection — summary + remediationHints available
 *   }
 * }
 * ```
 *
 * @task T10510
 * @epic T10383
 */
export type ValidatorVerdict = ValidatorAttestation | ValidatorRejection;

// ============================================================================
// Zod schemas — runtime validation
// ============================================================================

/**
 * Regex validating the canonical Validator agentId pattern
 * `validator-<discriminator>`. The discriminator is `[a-z0-9][a-z0-9-]*`
 * (lowercase alphanumeric + hyphens, must start with alphanum).
 *
 * Examples that MATCH: `validator-prime`, `validator-sec-001`, `validator-a`.
 * Examples that DO NOT match: `validator-`, `Validator-prime`, `validator--x`.
 *
 * @task T10510
 */
export const VALIDATOR_ID_REGEX = /^validator-[a-z0-9][a-z0-9-]*$/;

/**
 * Zod schema for {@link ValidatorFinding}. Enforces the AC-id presence,
 * status enum, non-empty reasoning, and ISO-8601 timestamp shape.
 *
 * @task T10510
 */
export const validatorFindingSchema = z.object({
  acId: z.string().min(1, 'acId must be non-empty'),
  status: z.enum(['pass', 'fail', 'inconclusive']),
  reasoning: z.string().min(1, 'reasoning must be non-empty'),
  evidenceRefs: z.array(z.string()).optional(),
  checkedAt: z.string().min(1, 'checkedAt must be a non-empty ISO-8601 string'),
});

/**
 * Zod schema for {@link ValidatorAttestation}. Enforces:
 *  - `verdict === 'attest'`
 *  - `validatorId` matches {@link VALIDATOR_ID_REGEX}
 *  - `findings` non-empty AND every entry has `status === 'pass'`
 *  - `schemaVersion === '1'`
 *
 * @task T10510
 */
export const validatorAttestationSchema = z.object({
  verdict: z.literal('attest'),
  taskId: z.string().min(1),
  validatorId: z
    .string()
    .regex(VALIDATOR_ID_REGEX, 'validatorId must match the pattern validator-<discriminator>'),
  findings: z
    .array(validatorFindingSchema)
    .min(1, 'attestation must contain at least one finding')
    .refine(
      (findings) => findings.every((f) => f.status === 'pass'),
      'attestation requires every finding to have status="pass"',
    ),
  summary: z.string().optional(),
  attestedAt: z.string().min(1),
  schemaVersion: z.literal('1'),
});

/**
 * Zod schema for {@link ValidatorRejection}. Enforces:
 *  - `verdict === 'reject'`
 *  - `validatorId` matches {@link VALIDATOR_ID_REGEX}
 *  - `findings` non-empty AND at least one entry has `status !== 'pass'`
 *  - `summary` non-empty (rejection rationale is mandatory)
 *  - `schemaVersion === '1'`
 *
 * @task T10510
 */
export const validatorRejectionSchema = z.object({
  verdict: z.literal('reject'),
  taskId: z.string().min(1),
  validatorId: z
    .string()
    .regex(VALIDATOR_ID_REGEX, 'validatorId must match the pattern validator-<discriminator>'),
  findings: z
    .array(validatorFindingSchema)
    .min(1, 'rejection must contain at least one finding')
    .refine(
      (findings) => findings.some((f) => f.status !== 'pass'),
      'rejection requires at least one finding with status "fail" or "inconclusive"',
    ),
  summary: z.string().min(1, 'rejection summary must be non-empty'),
  remediationHints: z.array(z.string()).optional(),
  rejectedAt: z.string().min(1),
  schemaVersion: z.literal('1'),
});

/**
 * Zod schema for the {@link ValidatorVerdict} discriminated union.
 * Routes parsing through the `verdict` discriminant.
 *
 * @task T10510
 */
export const validatorVerdictSchema = z.discriminatedUnion('verdict', [
  validatorAttestationSchema,
  validatorRejectionSchema,
]);

// ============================================================================
// Type guards
// ============================================================================

/**
 * Type guard validating that `value` conforms to {@link ValidatorAttestation}.
 * Internally uses {@link validatorAttestationSchema}.
 *
 * @task T10510
 */
export function isValidatorAttestation(value: unknown): value is ValidatorAttestation {
  return validatorAttestationSchema.safeParse(value).success;
}

/**
 * Type guard validating that `value` conforms to {@link ValidatorRejection}.
 * Internally uses {@link validatorRejectionSchema}.
 *
 * @task T10510
 */
export function isValidatorRejection(value: unknown): value is ValidatorRejection {
  return validatorRejectionSchema.safeParse(value).success;
}

/**
 * Type guard validating that `value` conforms to {@link ValidatorVerdict}
 * (either an attestation or a rejection). Internally uses
 * {@link validatorVerdictSchema}.
 *
 * @task T10510
 */
export function isValidatorVerdict(value: unknown): value is ValidatorVerdict {
  return validatorVerdictSchema.safeParse(value).success;
}
