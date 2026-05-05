/**
 * SdkTool contract — Category B harness-agnostic SDK utility.
 *
 * An SDK Tool is a harness-agnostic utility that every adapter, harness, and
 * orchestration pathway MUST consume. SDK Tools:
 *
 * - MUST have zero harness-specific imports.
 * - MUST expose a typed contract via `packages/contracts/src/`.
 * - MUST be consumed by ALL adapters that invoke the relevant operation.
 * - MUST be pure or side-effect-isolated (testable without running an agent).
 * - SHOULD be deterministic given identical inputs.
 *
 * Canonical location: `packages/core/src/tools/sdk/`
 *
 * Distinct from Category A (Agent Tool — LLM-callable primitive registered in
 * AgentToolRegistry) and Category C (Domain Utility — internal to a specific
 * domain, not required cross-harness).
 *
 * @arch See ADR-064 (SDK Tools taxonomy: Category A Agent Tool vs Category B SDK Tool)
 * @task T1815
 * @epic T1768
 */

/**
 * Identity metadata shared by all SDK Tools.
 *
 * Each SDK Tool MUST declare a stable `name` (used in diagnostics and audits),
 * a human-readable `description`, and the semver-compatible `version` of the
 * contract it exposes.
 */
export interface SdkToolIdentity {
  /** Stable machine-readable identifier (kebab-case, e.g. `worktree-isolation`). */
  name: string;
  /** Human-readable description of the tool's purpose. */
  description: string;
  /**
   * Contract version in `MAJOR.MINOR.PATCH` form.
   *
   * Increment MAJOR when the interface shape changes in a breaking way.
   * Callers may guard on this field to detect incompatible contract upgrades.
   */
  version: string;
}

/**
 * Base interface for all SDK Tools.
 *
 * Implementors extend this with operation-specific methods. The `identity`
 * field is the only required member — it gives diagnostics and audit layers
 * a stable handle on which SDK Tool is in play.
 *
 * @arch See ADR-064
 * @task T1815
 */
export interface SdkTool {
  /** Static identity metadata for this SDK Tool. */
  readonly identity: SdkToolIdentity;
}
