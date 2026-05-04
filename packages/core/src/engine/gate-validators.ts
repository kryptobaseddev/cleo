/**
 * IVTR Breaking-Change Gate validators — extends the verification system with
 * the `nexusImpact` acceptance gate (EP3-T8 / T1073).
 *
 * This module is the canonical entry point for the `nexusImpact` gate. It
 * re-exports from `packages/core/src/tasks/nexus-impact-gate.ts` (where the
 * implementation lives per package-boundary rules) and exposes the public API
 * under the path `packages/core/src/engine/gate-validators` as specified by
 * the acceptance criteria.
 *
 * ## Gate: `nexusImpact`
 *
 * Before completing any task, this gate:
 *
 * 1. Reads the task's `files` array.
 * 2. Queries the nexus DB for all symbols in those files.
 * 3. Calls `reasonImpactOfChange()` for each symbol.
 * 4. Fails (BLOCKED) if any symbol returns `mergedRiskScore === 'CRITICAL'`.
 *
 * ## Opt-in
 *
 * The gate is disabled by default to prevent surprise breakage on existing
 * projects. Enable via `CLEO_NEXUS_IMPACT_GATE=1`.
 *
 * ## Bypass
 *
 * If the gate fails and the operator has reviewed the risk, pass
 * `--acknowledge-risk "<reason>"` to `cleo complete`. The acknowledgment is
 * audited to `.cleo/audit/nexus-risk-ack.jsonl`.
 *
 * ## Evidence
 *
 * The gate is verified with `tool:nexus-impact-full` which runs the full
 * impact analysis and is registered as a valid `cleo verify` evidence atom.
 *
 * @example
 * ```bash
 * # Verify (runs the impact analysis):
 * cleo verify T### --gate nexusImpact --evidence 'tool:nexus-impact-full'
 *
 * # Complete (blocks on CRITICAL risk unless acknowledged):
 * cleo complete T###
 *
 * # Bypass with acknowledgment:
 * cleo complete T### --acknowledge-risk "breaking change reviewed by team lead"
 * ```
 *
 * @see packages/core/src/tasks/nexus-impact-gate.ts — implementation
 * @see packages/core/src/tasks/nexus-risk-audit.ts — acknowledgment audit trail
 * @see packages/core/src/tasks/complete.ts — integration with `cleo complete`
 * @task T1073
 * @epic T1042
 * @adr ADR-051
 */

export type { NexusImpactGateResult } from '../tasks/nexus-impact-gate.js';

export { validateNexusImpactGate } from '../tasks/nexus-impact-gate.js';

export type { NexusRiskAckEntry } from '../tasks/nexus-risk-audit.js';

export { appendNexusRiskAck } from '../tasks/nexus-risk-audit.js';

// ---------------------------------------------------------------------------
// Gate name constant
// ---------------------------------------------------------------------------

/**
 * The canonical gate name for the IVTR Breaking-Change Gate.
 *
 * Used as `--gate nexusImpact` in `cleo verify` and as a key in the
 * `VerificationGate` union type.
 *
 * @task T1073
 */
export const NEXUS_IMPACT_GATE_NAME = 'nexusImpact' as const;

/**
 * Environment variable that enables the nexusImpact gate.
 *
 * Set to `'1'` to enable. Default is disabled to prevent surprise breakage
 * on projects that have not opted in.
 *
 * @example
 * ```bash
 * CLEO_NEXUS_IMPACT_GATE=1 cleo complete T###
 * ```
 *
 * @task T1073
 */
export const NEXUS_IMPACT_GATE_ENV_VAR = 'CLEO_NEXUS_IMPACT_GATE' as const;

/**
 * Returns `true` when the nexusImpact gate is enabled via the environment.
 *
 * Checks `process.env.CLEO_NEXUS_IMPACT_GATE === '1'`.
 *
 * @returns `true` when the gate is enabled.
 *
 * @example
 * ```ts
 * if (isNexusImpactGateEnabled()) {
 *   const result = await validateNexusImpactGate(task, projectRoot);
 * }
 * ```
 *
 * @task T1073
 */
export function isNexusImpactGateEnabled(): boolean {
  return process.env[NEXUS_IMPACT_GATE_ENV_VAR] === '1';
}
