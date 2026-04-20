/**
 * Auto-tier selection for spawn prompts (T892).
 *
 * Provides a pure, deterministic function that maps a task + role to the
 * appropriate spawn-prompt tier (0=worker/minimal, 1=lead/standard,
 * 2=orchestrator/full). The algorithm applies a base matrix, then optional
 * size/type/label overrides that can bump the tier up by one step.
 *
 * ## Base matrix
 *
 * | Role         | Base tier |
 * |--------------|-----------|
 * | orchestrator | 2         |
 * | lead         | 1         |
 * | worker       | 0         |
 *
 * ## Override rules (applied after base tier)
 *
 * 1. `task.size === 'large'` OR `task.type === 'epic'` → +1 tier (cap 2).
 * 2. `task.labels` includes `'research'` or `'spec'` → +1 tier (cap 2).
 * 3. Explicit `--tier N` flag always wins (never mutated by this module).
 *
 * @module orchestration/tier-selector
 * @task T892 — Auto-tier selection
 * @epic T889 — Orchestration Coherence v3
 */

import type { AgentSpawnCapability } from '@cleocode/contracts';

// ============================================================================
// Types
// ============================================================================

/** Valid prompt tiers — 0=minimal, 1=standard, 2=full. */
export type SpawnTierValue = 0 | 1 | 2;

/**
 * Minimal task shape required by {@link selectTier}.
 *
 * Intentionally narrow — only the fields the algorithm inspects. Callers
 * pass a full {@link Task} record; TypeScript structural subtyping ensures
 * compatibility.
 */
export interface TierSelectInput {
  /** Task size axis (small / medium / large). @task T892 */
  size?: string | null;
  /** Task type (epic / task / subtask). @task T892 */
  type?: string | null;
  /** Task labels. @task T892 */
  labels?: string[] | null;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Base tier for a given role.
 *
 * - orchestrator → 2 (full prompt with skill excerpts)
 * - lead         → 1 (standard + CLEO-INJECTION embed)
 * - worker       → 0 (minimal — task + return-format only)
 *
 * @param role - Agent capability role.
 * @returns Base spawn tier.
 */
function baseTierForRole(role: AgentSpawnCapability): SpawnTierValue {
  if (role === 'orchestrator') return 2;
  if (role === 'lead') return 1;
  return 0;
}

/**
 * Cap a tier value at 2.
 *
 * @param tier - Raw tier after override application.
 * @returns Clamped value in [0, 2].
 */
function capTier(tier: number): SpawnTierValue {
  if (tier >= 2) return 2;
  if (tier <= 0) return 0;
  return tier as SpawnTierValue;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the canonical spawn-prompt tier for a task given its assigned role.
 *
 * The function is intentionally **pure** — it reads task metadata but does
 * NOT consult the filesystem, database, or any external state. All override
 * rules are applied deterministically from the inputs.
 *
 * Override application order:
 * 1. Start from `baseTierForRole(role)`.
 * 2. If `task.size === 'large'` OR `task.type === 'epic'` → bump +1 (cap 2).
 * 3. If `task.labels` includes `'research'` or `'spec'` → bump +1 (cap 2).
 * 4. Apply cap: result is always in {0, 1, 2}.
 *
 * Callers that want to override the auto-selection (e.g. the CLI `--tier N`
 * flag) should bypass this function entirely and pass the explicit tier
 * directly to the composer.
 *
 * @param task - Task metadata driving heuristic overrides.
 * @param role - Agent capability role assigned to the task.
 * @returns Resolved spawn tier (0 | 1 | 2).
 *
 * @example
 * ```ts
 * const tier = selectTier({ size: 'large', type: 'task', labels: [] }, 'worker');
 * // → 1  (worker base=0, size=large bumps +1)
 * ```
 *
 * @task T892
 */
export function selectTier(task: TierSelectInput, role: AgentSpawnCapability): SpawnTierValue {
  let tier: number = baseTierForRole(role);

  // Override 1 — large scope or epic type bumps +1.
  if (task.size === 'large' || task.type === 'epic') {
    tier += 1;
  }

  // Override 2 — research or spec label bumps +1.
  const labels = task.labels ?? [];
  if (labels.includes('research') || labels.includes('spec')) {
    tier += 1;
  }

  return capTier(tier);
}

/**
 * Resolve the effective tier to use for a spawn operation.
 *
 * When an explicit tier is supplied (e.g. from the CLI `--tier N` flag) it
 * wins unconditionally. When the caller passes `undefined` (or the sentinel
 * string `'auto'`), the function delegates to {@link selectTier}.
 *
 * @param task         - Task metadata.
 * @param role         - Agent capability role.
 * @param explicitTier - Caller-supplied override, or `undefined`/`'auto'`.
 * @returns Resolved spawn tier.
 *
 * @task T892
 */
export function resolveEffectiveTier(
  task: TierSelectInput,
  role: AgentSpawnCapability,
  explicitTier?: 0 | 1 | 2 | 'auto',
): SpawnTierValue {
  if (explicitTier !== undefined && explicitTier !== 'auto') {
    return explicitTier;
  }
  return selectTier(task, role);
}
