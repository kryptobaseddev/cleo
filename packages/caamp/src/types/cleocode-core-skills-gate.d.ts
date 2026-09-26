/**
 * Ambient declarations for the three `@cleocode/core` skills-gate modules the
 * install pipeline loads (T12384).
 *
 * Same reason and shape as `cleocode-core-tools-fs.d.ts`: caamp carries no
 * project reference to core (that is how the core↔caamp cycle is broken), so
 * `tsc -b` cannot see core's declarations when it checks caamp. The signatures
 * are reproduced from `packages/core/src/skills/*`; every type comes from
 * `@cleocode/contracts` (`skills/install-gate.ts`), which mirrors core's types
 * structurally, so nothing new is introduced and nothing core-owned leaks into
 * caamp's emitted declarations.
 *
 * Runtime resolution is unaffected — core's `package.json` exports
 * `./skills/*`, and `@cleocode/core` is a direct dependency of caamp.
 *
 * @task T12384
 */
declare module '@cleocode/core/skills/skills-guard.js' {
  import type { SkillGatePolicyDecision, SkillGateScanResult } from '@cleocode/contracts';

  /**
   * Scan a skill directory (or file) for threats.
   *
   * @param skillPath - Skill root directory or file.
   * @param source - Source identifier; drives the trust tier.
   * @returns The scan result.
   */
  export function scanSkill(skillPath: string, source?: string): SkillGateScanResult;

  /**
   * Apply the install policy to a scan.
   *
   * @param result - The scan result.
   * @param force - Operator override of a `block` decision.
   * @returns The policy decision.
   */
  export function shouldAllowInstall(
    result: SkillGateScanResult,
    force?: boolean,
  ): SkillGatePolicyDecision;
}

declare module '@cleocode/core/skills/federation-install-gate.js' {
  import type { SkillGateFederationInput, SkillGateFederationResult } from '@cleocode/contracts';

  /**
   * Evaluate the federation first-install and checksum gate.
   *
   * @param opts - Source, artefact path, expected checksum, approval.
   * @returns The gate result.
   */
  export function evaluateFederationInstallGate(
    opts: SkillGateFederationInput,
  ): SkillGateFederationResult;
}

declare module '@cleocode/core/skills/skills-guard-audit.js' {
  import type { SkillGateScanResult } from '@cleocode/contracts';

  /**
   * Append an operator bypass to the trust-bypass audit log.
   *
   * @param result - The scan that was bypassed.
   * @param reason - Operator-supplied reason.
   * @param cleoRoot - Project root override.
   * @returns The audit entry written (shape owned by core; not consumed here).
   */
  export function recordTrustBypass(
    result: SkillGateScanResult,
    reason?: string | null,
    cleoRoot?: string,
  ): object;
}
