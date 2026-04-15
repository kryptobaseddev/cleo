/**
 * Plasticity class and stability score utilities for STDP and Hebbian plasticity.
 *
 * Manages the plasticity_class column which governs which algorithms write to an edge:
 * - 'static': Non-plastic (structural, semantic). Immune to decay.
 * - 'hebbian': Written by strengthenCoRetrievedEdges. Subject to decay.
 * - 'stdp': Written or refined by applyStdpPlasticity. Subject to decay + LTD.
 *
 * Also computes stability_score for decay filtering and plasticity event ordering.
 *
 * @task T693
 * @epic T673
 */

/**
 * Upgrade plasticity class to the most plastic variant that has touched it.
 *
 * Decision logic (T693 / synthesis decision #12):
 * - If current = 'static' and event = 'hebbian' → 'hebbian' (first plasticity touch)
 * - If current = 'static' and event = 'stdp' → 'stdp' (STDP direct touch)
 * - If current = 'hebbian' and event = 'stdp' → 'stdp' (upgrade via STDP)
 * - If current = 'stdp' → stays 'stdp' (no downgrade)
 * - Otherwise return current unchanged
 *
 * @param currentClass - Current plasticity class value ('static', 'hebbian', 'stdp')
 * @param event - Event type triggering upgrade ('hebbian' or 'stdp')
 * @returns Upgraded plasticity class
 */
export function upgradePlasticityClass(
  currentClass: string | null | undefined,
  event: 'hebbian' | 'stdp',
): string {
  const current = currentClass ?? 'static';

  // If already 'stdp', no upgrade possible
  if (current === 'stdp') return 'stdp';

  // STDP always upgrades anything to 'stdp'
  if (event === 'stdp') return 'stdp';

  // Hebbian upgrades 'static' to 'hebbian', otherwise no change
  if (event === 'hebbian') {
    return current === 'static' ? 'hebbian' : current;
  }

  return current;
}

/**
 * Compute biological stability score for an edge based on reinforcement history.
 *
 * Formula (T673 spec §1 decision #13):
 *   stability = tanh(reinforcement_count / 10) × exp(-(days_since_reinforced / 30))
 *
 * Parameters:
 * - reinforcement_count: Number of LTP events applied lifetime (integer ≥ 0)
 * - lastReinforcedAt: ISO 8601 timestamp of last LTP event, or null if never
 *
 * Returns: 0.0–1.0, or null if no history to compute from
 *
 * Examples:
 * - rc=10, days=0 → tanh(1.0) × 1.0 ≈ 0.762
 * - rc=5, days=0  → tanh(0.5) × 1.0 ≈ 0.462
 * - rc=10, days=30 → tanh(1.0) × exp(-1) ≈ 0.280
 * - rc=0, days=any → tanh(0) × ... = 0.0 (new edges)
 *
 * @param reinforcementCount - Lifetime count of LTP events applied to edge
 * @param lastReinforcedAt - ISO 8601 timestamp of last LTP event, or null
 * @param now - Current timestamp (epoch ms, for testing). Defaults to Date.now()
 * @returns Stability score 0.0–1.0, or null if edge has no reinforcement history
 */
export function computeStabilityScore(
  reinforcementCount: number,
  lastReinforcedAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  // No reinforcements → no stability history yet
  if (!reinforcementCount || reinforcementCount <= 0) return null;
  if (!lastReinforcedAt) return null;

  // Compute tanh(rc / 10)
  const rcTerm = Math.tanh(reinforcementCount / 10);

  // Compute exp(-(days / 30))
  const lastReinforcedMs = new Date(lastReinforcedAt).getTime();
  const ageMs = now - lastReinforcedMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const decayTerm = Math.exp(-ageDays / 30);

  const stability = rcTerm * decayTerm;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, stability));
}
