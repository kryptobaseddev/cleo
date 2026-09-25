/**
 * Verification-gate policy — the single resolver for WHICH verification gates
 * a task must have set to `true`, and whether that requirement is enforced.
 *
 * `cleo complete` and `cleo release plan` both consume this so the two can
 * never disagree about what "verified" means. Before T12359 the release plan
 * checked only that evidence atoms were PRESENT, and shipped fifteen tasks
 * whose `implemented` gate was `false`.
 *
 * @task T12359
 */

import type { VerificationGate } from '@cleocode/contracts';
import { getRawConfigValue, loadConfig } from '../config.js';

/**
 * Fallback gate list used only when the resolved config names no valid gate.
 * The normal cascade supplies `verification.requiredGates` from config
 * defaults, so this is reached only when a project config sets an empty or
 * wholly-invalid list.
 */
const DEFAULT_VERIFICATION_REQUIRED_GATES: readonly VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'securityPassed',
  'documented',
];

const VERIFICATION_GATES: ReadonlySet<string> = new Set<VerificationGate>([
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
]);

/**
 * Type guard: `true` when `value` names a canonical {@link VerificationGate}.
 *
 * @param value - Candidate gate name (typically from project config).
 * @returns Whether `value` is a known verification gate.
 */
export function isVerificationGate(value: string): value is VerificationGate {
  return VERIFICATION_GATES.has(value);
}

/**
 * Resolved verification-gate policy for a project.
 *
 * @task T12359
 */
export interface VerificationGatePolicy {
  /**
   * Whether verification gates are enforced. Mirrors `verification.enabled`
   * from the project config; under VITEST it defaults to `false` when the
   * project config does not set it explicitly.
   */
  enabled: boolean;
  /** Gates that must be `true` before a task counts as verified, in config order. */
  requiredGates: VerificationGate[];
}

/**
 * Resolve the project's verification-gate policy — the same policy
 * `cleo complete` enforces.
 *
 * @param cwd - Project root (defaults to the resolved project root).
 * @returns The enforcement flag and the required gate list.
 *
 * @task T12359
 */
export async function loadVerificationGatePolicy(cwd?: string): Promise<VerificationGatePolicy> {
  const isTest = !!process.env.VITEST;
  const config = await loadConfig(cwd);
  // Read only the project-level value (no DEFAULTS cascade) so the isTest
  // fallback activates when `verification.enabled` is not explicitly set.
  const rawEnabled = await getRawConfigValue('verification.enabled', cwd);
  const enabled = rawEnabled !== undefined ? Boolean(rawEnabled) : !isTest;
  const configured = (config.verification?.requiredGates ?? []).filter(isVerificationGate);
  const requiredGates =
    configured.length > 0 ? configured : [...DEFAULT_VERIFICATION_REQUIRED_GATES];
  return { enabled, requiredGates };
}

/**
 * Return the required gates that are not `true` on a verification record.
 *
 * @param gates - The task's `verification.gates` map (may be absent).
 * @param requiredGates - Gates the policy requires.
 * @returns Required gates whose value is anything other than `true`.
 *
 * @task T12359
 */
export function missingRequiredGates(
  gates: Partial<Record<VerificationGate, boolean | null>> | null | undefined,
  requiredGates: readonly VerificationGate[],
): VerificationGate[] {
  return requiredGates.filter((gate) => gates?.[gate] !== true);
}
