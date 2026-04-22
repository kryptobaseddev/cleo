/**
 * PeerIdentity — canonical type for CANT agent persona records.
 *
 * Introduced by T1210 (v2026.4.110 Wave 0.2) as the SDK-first contract
 * for agent identity. `packages/cant/src/native-loader.ts` produces
 * `PeerIdentity[]` from the canonical seed-agents path; dispatch and
 * CLI layers consume it to drive `cleo agents list` and spawn routing.
 *
 * Design constraints (ADR-055 / D028 boundary rules):
 *  - Lives in `packages/contracts/` — ZERO runtime dependencies.
 *  - Consumed by `packages/cant/` (loader) and `packages/cleo/` (CLI).
 *  - No cross-package relative imports.
 *
 * @module peer
 * @task T1210
 * @epic T1144
 */

// ============================================================================
// PeerKind taxonomy
// ============================================================================

/**
 * Classification of a peer agent's role in the orchestration hierarchy.
 *
 * Mirrors the three-tier model in {@link AgentSpawnCapability}:
 *  - `orchestrator` — coordinates multi-agent workflows; may spawn leads and workers
 *  - `lead`         — specialist; dispatches workers only
 *  - `worker`       — terminal; executes tasks, cannot spawn
 *  - `subagent`     — universal base role; resolved to a specific tier at spawn time
 */
export type PeerKind = 'orchestrator' | 'lead' | 'worker' | 'subagent';

// ============================================================================
// PeerIdentity
// ============================================================================

/**
 * Canonical identity record for a CANT-defined agent persona.
 *
 * Produced by `loadSeedAgentIdentities()` in `packages/cant/src/native-loader.ts`
 * and consumed by the dispatch layer + `cleo agents list`. Every field is
 * required — loaders MUST supply a value for each field, using empty strings
 * for absent optional content in the source `.cant` file.
 *
 * @example
 * ```ts
 * import type { PeerIdentity } from '@cleocode/contracts';
 *
 * const personas: PeerIdentity[] = loadSeedAgentIdentities();
 * for (const p of personas) {
 *   console.log(`${p.peerId} (${p.peerKind}): ${p.displayName}`);
 * }
 * ```
 *
 * @task T1210
 * @epic T1144
 */
export interface PeerIdentity {
  /**
   * Stable business identifier for the agent, matching the `agent <id>:` block
   * name in the `.cant` file and the `agents.agent_id` column in the registry.
   *
   * @example `"cleo-prime"`, `"cleo-dev"`, `"cleo-subagent"`
   */
  peerId: string;

  /**
   * Role classification derived from the `role:` field in the `.cant` agent
   * block. Determines spawn authority in the orchestration hierarchy.
   */
  peerKind: PeerKind;

  /**
   * Absolute path to the canonical `.cant` file that defines this persona.
   *
   * For seed-agents this is inside `packages/agents/seed-agents/` or
   * `packages/agents/cleo-subagent.cant` (universal base). For project-tier
   * personas it is inside `.cleo/cant/agents/`.
   */
  cantFile: string;

  /**
   * Human-readable name for the persona, derived from the `display_name:` or
   * `description:` field. Falls back to the `peerId` value when neither field
   * is present in the source `.cant`.
   */
  displayName: string;

  /**
   * Short description of the persona's purpose, taken from the `description:`
   * field in the `.cant` agent block. Empty string when absent.
   */
  description: string;
}

// ============================================================================
// Runtime validation
// ============================================================================

/**
 * Validate that an unknown value conforms to the {@link PeerIdentity} shape.
 *
 * Performs a lightweight structural check without Zod to keep `packages/contracts`
 * dependency-free at runtime. Callers that need schema-level validation
 * (e.g., test fixtures) can use {@link assertPeerIdentity}.
 *
 * @param value - Value to test.
 * @returns `true` when `value` is a valid {@link PeerIdentity}.
 *
 * @example
 * ```ts
 * if (isPeerIdentity(raw)) {
 *   console.log(raw.peerId);
 * }
 * ```
 */
export function isPeerIdentity(value: unknown): value is PeerIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['peerId'] === 'string' &&
    v['peerId'].length > 0 &&
    typeof v['peerKind'] === 'string' &&
    ['orchestrator', 'lead', 'worker', 'subagent'].includes(v['peerKind'] as string) &&
    typeof v['cantFile'] === 'string' &&
    v['cantFile'].length > 0 &&
    typeof v['displayName'] === 'string' &&
    typeof v['description'] === 'string'
  );
}

/**
 * Assert that a value is a valid {@link PeerIdentity}, throwing a descriptive
 * error when the shape does not conform.
 *
 * @param value - Value to assert.
 * @throws {TypeError} When the value does not satisfy {@link isPeerIdentity}.
 *
 * @example
 * ```ts
 * assertPeerIdentity(raw); // throws if invalid
 * console.log(raw.peerId); // safe
 * ```
 */
export function assertPeerIdentity(value: unknown): asserts value is PeerIdentity {
  if (!isPeerIdentity(value)) {
    throw new TypeError(
      `Expected PeerIdentity { peerId, peerKind, cantFile, displayName, description } — got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Validate and filter an array of unknown values to {@link PeerIdentity}[].
 *
 * Invalid entries are silently dropped. This is the safe variant for loading
 * from untrusted sources (e.g., the result of parsing a directory of `.cant`
 * files whose format may vary).
 *
 * @param values - Array of unknown values.
 * @returns Array containing only values that pass {@link isPeerIdentity}.
 */
export function filterPeerIdentities(values: unknown[]): PeerIdentity[] {
  return values.filter(isPeerIdentity);
}
