/**
 * Verification evidence-atom extensions.
 *
 * This module extends the base evidence-atom vocabulary (defined in
 * `@cleocode/contracts`) with additional atom kinds:
 *
 * ### `metrics-delta` (Tier-3 auto-merge experiments — T1023)
 *
 * Proves that a Tier-3 auto-merge experiment produced measurable metric
 * improvements relative to a signed baseline.
 *
 * Format: `metrics-delta:<beforeReceiptId>:<afterReceiptId>`
 *
 * Both receipt IDs must correspond to `kind:"baseline"` events in the
 * project's sentient event log (`.cleo/audit/sentient-events.jsonl`).
 *
 * ### `loc-drop` (engine-migration tasks — T1604)
 *
 * Proves that a migrated engine shed ≥ a configured percentage of lines.
 * Required for the `implemented` gate whenever the task carries the
 * `engine-migration` label.
 *
 * Format: `loc-drop:<fromLines>:<toLines>` (both non-negative integers)
 *
 * ### `callsite-coverage` (production-callsite gate — T1605)
 *
 * Proves that an exported symbol has ≥1 production callsite outside its own
 * source file, test files, and dist directories.  Required for the
 * `implemented` gate whenever the task carries the `callsite-coverage` label.
 * Catches the T1601 pattern where a function is shipped but never wired to
 * any production callsite.
 *
 * Format: `callsite-coverage:<symbolName>:<relativeSourcePath>`
 *
 * @see packages/core/src/verification/gates.ts — `metricsImproved` gate
 * @task T1023
 * @task T1604
 * @task T1605
 */

import type { BaselineEvent, SentientEvent } from '../sentient/events.js';
import { querySentientEvents, verifySentientEventSignature } from '../sentient/events.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A parsed `metrics-delta` evidence atom before validation.
 */
export interface ParsedMetricsDeltaAtom {
  /** Discriminant — always `'metrics-delta'`. */
  kind: 'metrics-delta';
  /** Receipt ID of the "before" baseline event. */
  beforeReceiptId: string;
  /** Receipt ID of the "after" baseline event. */
  afterReceiptId: string;
}

/**
 * A validated `metrics-delta` evidence atom, populated with the resolved
 * metrics from both baseline events.
 */
export interface ValidatedMetricsDeltaAtom {
  /** Discriminant — always `'metrics-delta'`. */
  kind: 'metrics-delta';
  /** Receipt ID of the "before" baseline event. */
  beforeReceiptId: string;
  /** Receipt ID of the "after" baseline event. */
  afterReceiptId: string;
  /** Parsed metrics from the before baseline. */
  beforeMetrics: Record<string, number>;
  /** Parsed metrics from the after baseline. */
  afterMetrics: Record<string, number>;
  /** ISO-8601 timestamp of the before baseline event. */
  beforeTimestamp: string;
  /** ISO-8601 timestamp of the after baseline event. */
  afterTimestamp: string;
}

/**
 * Result of validating a `metrics-delta` atom.
 */
export type MetricsDeltaValidation =
  | { ok: true; atom: ValidatedMetricsDeltaAtom }
  | { ok: false; reason: string; codeName: string };

// ---------------------------------------------------------------------------
// Metric improvement direction
// ---------------------------------------------------------------------------

/**
 * Metric key names that improve by going **lower** (smaller is better).
 *
 * All other numeric metrics are assumed to improve by going higher.
 */
const LOWER_IS_BETTER_KEYS: ReadonlySet<string> = new Set(['bundleSizeKb', 'bundleSize']);

/**
 * Determine whether an `after` value represents an improvement over `before`
 * for a given metric key.
 *
 * @param key - Metric name.
 * @param before - Baseline value.
 * @param after - Experiment value.
 * @returns `true` when after is equal to or better than before.
 */
export function isMetricImproved(key: string, before: number, after: number): boolean {
  if (LOWER_IS_BETTER_KEYS.has(key)) {
    return after <= before;
  }
  return after >= before;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw `metrics-delta` atom string into its components.
 *
 * The format is: `metrics-delta:<beforeReceiptId>:<afterReceiptId>`
 *
 * @param payload - Everything after the `metrics-delta:` prefix.
 * @returns Parsed atom or an error result.
 *
 * @example
 * ```ts
 * parseMetricsDeltaAtom('ABCdef12345678901234X:XYZghi12345678901234A');
 * ```
 */
export function parseMetricsDeltaAtom(
  payload: string,
): { ok: true; atom: ParsedMetricsDeltaAtom } | { ok: false; reason: string } {
  const colonIdx = payload.indexOf(':');
  if (colonIdx < 1 || colonIdx === payload.length - 1) {
    return {
      ok: false,
      reason:
        `metrics-delta atom requires format "<beforeReceiptId>:<afterReceiptId>". ` +
        `Got: "${payload}"`,
    };
  }

  const beforeReceiptId = payload.slice(0, colonIdx).trim();
  const afterReceiptId = payload.slice(colonIdx + 1).trim();

  if (!beforeReceiptId || !afterReceiptId) {
    return {
      ok: false,
      reason:
        `metrics-delta: both beforeReceiptId and afterReceiptId must be non-empty. ` +
        `Got: before="${beforeReceiptId}", after="${afterReceiptId}"`,
    };
  }

  return {
    ok: true,
    atom: { kind: 'metrics-delta', beforeReceiptId, afterReceiptId },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a `metrics-delta` atom against the sentient event log.
 *
 * Steps:
 * 1. Load both `baseline` events by their `receiptId` from the event log.
 * 2. Verify the Ed25519 signature on both events.
 * 3. Check that the after event's timestamp is strictly later than the before
 *    event's timestamp (anti-gaming: prevents passing a "future" baseline as
 *    the before event and a "past" baseline as the after event).
 * 4. Parse `payload.metricsJson` from both events into numeric records.
 * 5. For every numeric key that appears in the after metrics, check the
 *    improvement direction using {@link isMetricImproved}.
 * 6. Return a `ValidatedMetricsDeltaAtom` on success, or an error with
 *    `E_EVIDENCE_TAMPERED` / `E_EVIDENCE_INSUFFICIENT` on failure.
 *
 * @param parsed - Parsed metrics-delta atom (from {@link parseMetricsDeltaAtom}).
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Validation result.
 *
 * @task T1023
 */
export async function validateMetricsDeltaAtom(
  parsed: ParsedMetricsDeltaAtom,
  projectRoot: string,
): Promise<MetricsDeltaValidation> {
  // 1. Load ALL baseline events from the log, then find by receiptId.
  const allEvents = await querySentientEvents(projectRoot, { kind: 'baseline' });

  const beforeEvent = findBaselineByReceiptId(allEvents, parsed.beforeReceiptId);
  if (!beforeEvent) {
    return {
      ok: false,
      reason:
        `metrics-delta: no baseline event found with receiptId "${parsed.beforeReceiptId}". ` +
        `Ensure captureBaseline was run and the event log exists.`,
      codeName: 'E_EVIDENCE_MISSING',
    };
  }

  const afterEvent = findBaselineByReceiptId(allEvents, parsed.afterReceiptId);
  if (!afterEvent) {
    return {
      ok: false,
      reason:
        `metrics-delta: no baseline event found with receiptId "${parsed.afterReceiptId}". ` +
        `Ensure the post-experiment baseline was captured before verifying.`,
      codeName: 'E_EVIDENCE_MISSING',
    };
  }

  // 2. Verify signatures on both events.
  const beforeSigValid = await verifySentientEventSignature(beforeEvent);
  if (!beforeSigValid) {
    return {
      ok: false,
      reason:
        `metrics-delta: Ed25519 signature on before baseline (receiptId: ${parsed.beforeReceiptId}) ` +
        `is invalid. Event may have been tampered with.`,
      codeName: 'E_EVIDENCE_TAMPERED',
    };
  }

  const afterSigValid = await verifySentientEventSignature(afterEvent);
  if (!afterSigValid) {
    return {
      ok: false,
      reason:
        `metrics-delta: Ed25519 signature on after baseline (receiptId: ${parsed.afterReceiptId}) ` +
        `is invalid. Event may have been tampered with.`,
      codeName: 'E_EVIDENCE_TAMPERED',
    };
  }

  // 3. Timestamp order check: after must be strictly later than before.
  if (afterEvent.timestamp <= beforeEvent.timestamp) {
    return {
      ok: false,
      reason:
        `metrics-delta: after baseline timestamp (${afterEvent.timestamp}) must be strictly ` +
        `later than before baseline timestamp (${beforeEvent.timestamp}). ` +
        `This may indicate an attempt to game the comparison order.`,
      codeName: 'E_EVIDENCE_TAMPERED',
    };
  }

  // 4. Parse metricsJson from both events.
  const beforeMetrics = parseMetricsJson(beforeEvent.payload.metricsJson, 'before');
  if ('error' in beforeMetrics) {
    return {
      ok: false,
      reason: `metrics-delta: ${beforeMetrics.error}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  const afterMetrics = parseMetricsJson(afterEvent.payload.metricsJson, 'after');
  if ('error' in afterMetrics) {
    return {
      ok: false,
      reason: `metrics-delta: ${afterMetrics.error}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  // 5. Check that all numeric fields present in afterMetrics satisfy improvement direction.
  const regressions: string[] = [];
  for (const [key, afterVal] of Object.entries(afterMetrics.metrics)) {
    const beforeVal = beforeMetrics.metrics[key];
    if (beforeVal === undefined) {
      // Key not in before — no comparison possible, skip.
      continue;
    }
    if (!isMetricImproved(key, beforeVal, afterVal)) {
      regressions.push(
        `"${key}": before=${beforeVal}, after=${afterVal} ` +
          `(${LOWER_IS_BETTER_KEYS.has(key) ? 'lower is better — must be ≤' : 'higher is better — must be ≥'})`,
      );
    }
  }

  if (regressions.length > 0) {
    return {
      ok: false,
      reason:
        `metrics-delta: experiment introduced metric regressions:\n  ` + regressions.join('\n  '),
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }

  // 6. Return validated atom.
  return {
    ok: true,
    atom: {
      kind: 'metrics-delta',
      beforeReceiptId: parsed.beforeReceiptId,
      afterReceiptId: parsed.afterReceiptId,
      beforeMetrics: beforeMetrics.metrics,
      afterMetrics: afterMetrics.metrics,
      beforeTimestamp: beforeEvent.timestamp,
      afterTimestamp: afterEvent.timestamp,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the first `baseline` event in `events` whose `receiptId` matches.
 *
 * @internal
 */
function findBaselineByReceiptId(
  events: SentientEvent[],
  receiptId: string,
): BaselineEvent | undefined {
  for (const event of events) {
    if (event.kind === 'baseline' && event.receiptId === receiptId) {
      return event as BaselineEvent;
    }
  }
  return undefined;
}

/**
 * Parse a `metricsJson` string into a `Record<string, number>`.
 *
 * Rejects non-object JSON, non-string payloads, or entries with non-numeric
 * values.
 *
 * @param raw - Raw `metricsJson` string from `BaselinePayload`.
 * @param label - `'before'` or `'after'` for error messages.
 * @returns `{ metrics }` on success or `{ error }` on failure.
 *
 * @internal
 */
function parseMetricsJson(
  raw: string,
  label: 'before' | 'after',
): { metrics: Record<string, number> } | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: `${label} baseline has empty or non-string metricsJson` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${label} baseline metricsJson is not valid JSON: ${msg}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `${label} baseline metricsJson must be a JSON object` };
  }

  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        error: `${label} baseline metricsJson key "${key}" has non-numeric value: ${JSON.stringify(value)}`,
      };
    }
    metrics[key] = value;
  }

  return { metrics };
}

// ---------------------------------------------------------------------------
// LOC-drop gate helpers (T1604)
// ---------------------------------------------------------------------------

/**
 * The canonical label that triggers LOC-drop gate enforcement.
 *
 * When a task carries this label the `implemented` gate MUST be accompanied
 * by a `loc-drop` evidence atom proving the migrated engine shed lines.
 *
 * @task T1604
 */
export const ENGINE_MIGRATION_LABEL = 'engine-migration';

/**
 * Determine whether a task's labels include `engine-migration`.
 *
 * Accepts a `string[]` (from `task.labels`) or `null`/`undefined` for tasks
 * without labels.  Returns `false` for any non-array value so callers can
 * pass the raw DB field without pre-checking.
 *
 * @param labels - Task labels array (from `task.labels`).
 * @returns `true` when the `engine-migration` label is present.
 *
 * @example
 * ```ts
 * hasEngineMigrationLabel(['foundation', 'engine-migration']); // true
 * hasEngineMigrationLabel(['foundation']);                      // false
 * hasEngineMigrationLabel(null);                               // false
 * ```
 *
 * @task T1604
 */
export function hasEngineMigrationLabel(labels: string[] | null | undefined): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.includes(ENGINE_MIGRATION_LABEL);
}

// ---------------------------------------------------------------------------
// Callsite-coverage label helpers (T1605)
// ---------------------------------------------------------------------------

/**
 * The canonical label that triggers callsite-coverage gate enforcement.
 *
 * When a task carries this label the `implemented` gate MUST be accompanied
 * by a `callsite-coverage` evidence atom proving the exported symbol is
 * referenced from at least one production callsite outside its definition
 * file, test files, and dist directories.
 *
 * @task T1605
 */
export const CALLSITE_COVERAGE_GATE_LABEL = 'callsite-coverage';

/**
 * Determine whether a task's labels include `callsite-coverage`.
 *
 * Accepts a `string[]` (from `task.labels`) or `null`/`undefined` for tasks
 * without labels.  Returns `false` for any non-array value so callers can
 * pass the raw DB field without pre-checking.
 *
 * @param labels - Task labels array (from `task.labels`).
 * @returns `true` when the `callsite-coverage` label is present.
 *
 * @example
 * ```ts
 * hasCallsiteCoverageLabel(['foundation', 'callsite-coverage']); // true
 * hasCallsiteCoverageLabel(['foundation']);                       // false
 * hasCallsiteCoverageLabel(null);                                // false
 * ```
 *
 * @task T1605
 */
export function hasCallsiteCoverageLabel(labels: string[] | null | undefined): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.includes(CALLSITE_COVERAGE_GATE_LABEL);
}
