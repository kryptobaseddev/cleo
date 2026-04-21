/**
 * Verification gate extensions — Tier-3 `metricsImproved` gate.
 *
 * Adds the `metricsImproved` gate to the verification system. This gate
 * requires a `metrics-delta` evidence atom proving that an experiment's
 * after-metrics are equal-to or better than its before-metrics on all
 * tracked dimensions.
 *
 * ## When is `metricsImproved` required?
 *
 * The gate is required in two situations:
 *
 * 1. The task is a Tier-3 auto-merge experiment (detected via
 *    `meta.sentient.tier === 3` in the task metadata JSON).
 * 2. The caller explicitly requests the gate via `--gate metricsImproved`.
 *
 * For Tier-1 and Tier-2 tasks (or non-sentient tasks) the gate is never
 * injected into the `requiredGates` list automatically.
 *
 * ## Required evidence
 *
 * | Gate              | Required atom kinds |
 * |-------------------|---------------------|
 * | `metricsImproved` | `metrics-delta`     |
 *
 * @see packages/core/src/verification/evidence-atoms.ts
 * @task T1023
 */

// ---------------------------------------------------------------------------
// Gate name extension
// ---------------------------------------------------------------------------

/**
 * All gate names supported by the CLEO verification system.
 *
 * Extends the base set from `packages/core/src/validation/verification.ts`
 * with `metricsImproved` for Tier-3 merge-ritual enforcement.
 *
 * @task T1023
 */
export type ExtendedGateName =
  | 'implemented'
  | 'testsPassed'
  | 'qaPassed'
  | 'cleanupDone'
  | 'securityPassed'
  | 'documented'
  | 'metricsImproved';

/**
 * The ordered sequence of all gates, including `metricsImproved` appended
 * at the end of the standard chain.
 *
 * Standard order: implemented → testsPassed → qaPassed → cleanupDone →
 *   securityPassed → documented → **metricsImproved**
 *
 * @task T1023
 */
export const EXTENDED_GATE_ORDER: readonly ExtendedGateName[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
  'metricsImproved',
] as const;

// ---------------------------------------------------------------------------
// Required-atom minimums
// ---------------------------------------------------------------------------

/**
 * Minimum evidence required for the `metricsImproved` gate.
 *
 * At least one `metrics-delta` atom MUST be present. Alternative evidence
 * sets follow the same format as `GATE_EVIDENCE_MINIMUMS` in
 * `packages/core/src/tasks/evidence.ts`.
 *
 * @task T1023
 */
export const METRICS_IMPROVED_REQUIRED_ATOMS: ReadonlyArray<ReadonlyArray<string>> = [
  ['metrics-delta'],
] as const;

// ---------------------------------------------------------------------------
// Tier-3 detection
// ---------------------------------------------------------------------------

/**
 * Shape of the `meta.sentient` block expected on Tier-3 task metadata JSON.
 *
 * Only the `tier` field is required for gate injection; other fields are
 * ignored.
 */
interface SentientMeta {
  /** Sentient tier level: 1, 2, or 3. */
  tier: number;
}

/**
 * Shape of the task metadata object when parsed.
 *
 * We only extract the `sentient` sub-key; all other fields are irrelevant
 * to this module.
 */
interface TaskMetaJson {
  /** Optional sentient metadata block. */
  sentient?: SentientMeta;
}

/**
 * Determine whether a task requires the `metricsImproved` gate.
 *
 * Returns `true` when the task metadata JSON declares `sentient.tier === 3`,
 * indicating this is a Tier-3 auto-merge experiment task that must prove
 * metric improvements before the merge-ritual can complete.
 *
 * Non-Tier-3 tasks (Tier 1, Tier 2, or tasks with no sentient metadata)
 * never require this gate automatically. It can still be added manually via
 * `--gate metricsImproved`.
 *
 * @param metadataJson - The raw `metadata_json` column value from the task
 *   record (may be `null`, `undefined`, or a JSON string).
 * @returns `true` when the task is a Tier-3 experiment.
 *
 * @example
 * ```ts
 * const isT3 = isTier3Task('{"sentient":{"tier":3}}'); // true
 * const isT1 = isTier3Task('{"sentient":{"tier":1}}'); // false
 * const none = isTier3Task(null);                       // false
 * ```
 *
 * @task T1023
 */
export function isTier3Task(metadataJson: string | null | undefined): boolean {
  if (!metadataJson || typeof metadataJson !== 'string') return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) return false;

  const meta = parsed as TaskMetaJson;
  return meta.sentient?.tier === 3;
}

/**
 * Compute the list of required gates for a task, optionally injecting
 * `metricsImproved` for Tier-3 experiments.
 *
 * This function is intended as a helper for callers who need to build the
 * full required-gates list dynamically (e.g. `cleo complete`, verification
 * UI, IVTR merge ritual).
 *
 * @param baseRequiredGates - The default required gates from project config
 *   (typically `['implemented', 'testsPassed', 'qaPassed', 'securityPassed',
 *   'documented']`).
 * @param metadataJson - Task metadata JSON (used for Tier-3 detection).
 * @param explicitGates - Any gates explicitly requested by the caller via
 *   `--gate metricsImproved` or similar CLI flags.
 * @returns A deduplicated list of required gate names including any Tier-3
 *   injected gates.
 *
 * @example
 * ```ts
 * const gates = computeRequiredGates(
 *   ['implemented', 'testsPassed'],
 *   '{"sentient":{"tier":3}}',
 *   [],
 * );
 * // gates includes 'metricsImproved'
 * ```
 *
 * @task T1023
 */
export function computeRequiredGates(
  baseRequiredGates: string[],
  metadataJson: string | null | undefined,
  explicitGates: string[] = [],
): ExtendedGateName[] {
  const result = new Set<ExtendedGateName>();

  // Add base gates (filter to known gate names).
  for (const gate of baseRequiredGates) {
    if (isExtendedGateName(gate)) {
      result.add(gate);
    }
  }

  // Add explicit gates.
  for (const gate of explicitGates) {
    if (isExtendedGateName(gate)) {
      result.add(gate);
    }
  }

  // Inject metricsImproved for Tier-3 tasks.
  if (isTier3Task(metadataJson)) {
    result.add('metricsImproved');
  }

  // Return in canonical gate order.
  return EXTENDED_GATE_ORDER.filter((g) => result.has(g));
}

// ---------------------------------------------------------------------------
// Gate name guard
// ---------------------------------------------------------------------------

/**
 * Type guard: returns `true` when `name` is a valid {@link ExtendedGateName}.
 *
 * @param name - String to test.
 *
 * @task T1023
 */
export function isExtendedGateName(name: string): name is ExtendedGateName {
  return (EXTENDED_GATE_ORDER as readonly string[]).includes(name);
}
