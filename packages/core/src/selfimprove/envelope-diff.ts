/**
 * Envelope normalization + structural diff vs a golden (T11889-B).
 *
 * The self-improvement loop replays a scenario (see {@link "./replay.js"}) and
 * diffs each captured envelope against the golden expected envelope. This module:
 *
 *   1. {@link normalizeEnvelope} — strips the VOLATILE `meta` fields so only
 *      deterministic structure is compared. Two classes are stripped:
 *      timing/trace fields (`timestamp`, `requestId`, `duration_ms` /
 *      `durationMs`) AND the per-run session-lineage UUIDs (`sessionId`,
 *      `originSessionId`, `executionSessionId`). The latter are non-deterministic:
 *      the live `Dispatcher` defaults `executionSessionId`/`originSessionId` to a
 *      fresh `randomUUID()` per request
 *      (`ensureRequestSessionLineage`), then stamps all three onto `response.meta`
 *      — so a real envelope carries UUIDs the hand-authored golden cannot know.
 *      Stripping them prevents a permanent phantom DHQ that self-fires on every
 *      clean run. (The runtime field is `meta` with snake_case `duration_ms`; the
 *      spec wording uses `_meta`/`durationMs`, so both spellings and both
 *      container keys are stripped defensively.)
 *   2. {@link diffEnvelopes} — structurally compares the normalized envelope set
 *      against the golden, producing `{ regressions: DiffEntry[] }`. Zero
 *      regressions on a golden match; N on injected divergence. The `meta`
 *      container is compared as a SUBSET (only golden-declared meta keys are
 *      asserted) so deterministic-but-golden-absent infra keys
 *      (`specVersion`, `schemaVersion`, `transport`, `mvi`, `contextVersion`,
 *      `strict`, `x-cleo-transport`, …) stamped by the runtime are NOT phantom
 *      regressions. The semantic payload (`data`/`error`) is still compared by
 *      full key-union — a missing or extra payload key IS a regression.
 *   3. {@link computeQuestionHash} — sha256 of the normalized regression
 *      signature (op coordinates + diff path set) so the SAME regression maps to
 *      the SAME open DHQ row (the idempotency partial-UNIQUE index in T11889-A).
 *
 * `extractFieldFromResult` from `@cleocode/lafs` is reused for targeted-field
 * asserts where a full structural compare would be too brittle.
 *
 * This module is PURE — no DB, no native handle, no `cleo` mutation.
 * Import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/envelope-diff
 * @epic T11889
 * @task T11912
 */

import { createHash } from 'node:crypto';
import { extractFieldFromResult } from '@cleocode/lafs';
import type { ReplayEnvelope } from './replay.js';
import type { GoldenEntry, ScenarioOp } from './scenario.js';

/**
 * Volatile envelope-meta field names stripped before diffing.
 *
 * Two classes, both non-deterministic per run:
 *
 *   - Timing / trace: `timestamp`, `requestId`, `duration_ms` (the runtime
 *     canonical, snake_case) and `durationMs` (the spec wording — stripped so a
 *     golden authored either way normalizes identically).
 *   - Session lineage: `sessionId`, `originSessionId`, `executionSessionId`. The
 *     live `Dispatcher` stamps these onto `response.meta`
 *     after defaulting `executionSessionId`/`originSessionId` to a fresh
 *     `randomUUID()` per request (`ensureRequestSessionLineage`). They are
 *     per-run UUIDs the hand-authored golden cannot encode; leaving them in would
 *     make every clean replay emit a phantom regression at
 *     `meta/executionSessionId` and `meta/originSessionId`, and because the
 *     regression signature hashes only `opCoord@path` (constant), the resulting
 *     `question_hash` would be STABLE — a permanent self-firing DHQ. Stripping
 *     them keeps an identical-but-for-lineage envelope a non-regression.
 */
const VOLATILE_META_FIELDS = [
  'timestamp',
  'requestId',
  'duration_ms',
  'durationMs',
  'sessionId',
  'originSessionId',
  'executionSessionId',
] as const;

/**
 * Meta container keys whose volatile fields are stripped, and whose remaining
 * keys are compared as a SUBSET (see {@link diffEnvelopes}).
 *
 * Runtime envelopes use `meta`; `_meta` is stripped too for defensive parity with
 * the gateway envelope shape.
 */
const META_CONTAINER_KEYS = ['meta', '_meta'] as const;

/**
 * Top-level envelope keys whose value is a meta container.
 *
 * The structural diff treats these containers as a SUBSET compare (golden-declared
 * keys only) so deterministic-but-golden-absent infra keys the runtime stamps
 * (`specVersion`, `schemaVersion`, `transport`, `mvi`, `contextVersion`, `strict`,
 * `x-cleo-transport`, …) are not phantom regressions. Everything else (`data`,
 * `error`, …) keeps a full key-union compare.
 */
const SUBSET_COMPARE_KEYS = new Set<string>(META_CONTAINER_KEYS);

/**
 * A normalized envelope: the replayed envelope with volatile `meta` fields removed.
 *
 * Structurally identical to {@link ReplayEnvelope} except every volatile
 * meta field is absent. Stored as a plain JSON-serializable record so it can be
 * compared deeply and hashed deterministically.
 */
export type NormalizedEnvelope = Record<string, unknown>;

/**
 * A single structural difference between a normalized envelope and its golden.
 */
export interface DiffEntry {
  /** Zero-based index of the op in the scenario whose envelope diverged. */
  opIndex: number;
  /** The op coordinate (`domain.operation`) for the diverging op. */
  opCoord: string;
  /** JSON-pointer-ish path to the diverging value (e.g. `data/tasks/0/id`). */
  path: string;
  /** The value found in the replayed (actual) normalized envelope. */
  actual: unknown;
  /** The value found in the golden (expected) envelope. */
  expected: unknown;
}

/** The result of diffing a replayed envelope set against a golden. */
export interface EnvelopeDiffResult {
  /** All structural regressions; empty ⇒ the replay matched the golden. */
  regressions: DiffEntry[];
}

/**
 * Deep-clone a JSON-serializable value via structured round-trip.
 *
 * Replay envelopes are JSON-shaped (they round-trip through transports), so a
 * JSON clone is safe and avoids mutating the caller's object during normalization.
 *
 * @param value - The value to clone.
 * @returns A deep copy.
 */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Strip the volatile `meta`/`_meta` fields from an envelope.
 *
 * Returns a NEW object; the input is not mutated. The volatile timing/trace fields
 * AND the per-run session-lineage UUIDs (`sessionId`, `originSessionId`,
 * `executionSessionId`) are removed — see {@link VOLATILE_META_FIELDS}. The stable
 * meta remnant (`gateway`, `domain`, `operation`, `source`, …) is preserved so
 * structural identity (which operation produced the envelope) still compares.
 *
 * Note: deterministic-but-golden-absent infra meta keys (`specVersion`,
 * `transport`, …) are NOT stripped here — they are tolerated by the SUBSET compare
 * in {@link diffEnvelopes} instead, so the strip set stays exactly the volatile
 * fields and nothing semantic.
 *
 * @param envelope - The replayed envelope to normalize.
 * @returns The normalized envelope with volatile meta fields removed.
 *
 * @example
 * ```ts
 * const norm = normalizeEnvelope(envelope);
 * // norm.meta has no timestamp / requestId / duration_ms / *SessionId
 * ```
 */
export function normalizeEnvelope(envelope: ReplayEnvelope): NormalizedEnvelope {
  const cloned = jsonClone(envelope) as Record<string, unknown>;
  for (const containerKey of META_CONTAINER_KEYS) {
    const container = cloned[containerKey];
    if (container !== null && typeof container === 'object' && !Array.isArray(container)) {
      const meta = container as Record<string, unknown>;
      for (const field of VOLATILE_META_FIELDS) {
        delete meta[field];
      }
    }
  }
  return cloned;
}

/**
 * Recursively collect structural differences between two JSON values.
 *
 * Walks both trees in parallel, recording a `{ path, actual, expected }` for each
 * leaf-level divergence. Object key sets and array lengths are compared; the path
 * uses `/`-delimited segments.
 *
 * Key-set semantics depend on the container:
 *   - **Subset** (`subset === true`): only the EXPECTED (golden) object's keys are
 *     compared. Extra keys present in `actual` but absent from the golden are
 *     ignored. Applied to the `meta` container (see {@link SUBSET_COMPARE_KEYS}) so
 *     deterministic infra meta keys the runtime stamps but the golden omits are not
 *     phantom regressions.
 *   - **Full union** (`subset === false`, the default): keys from BOTH objects are
 *     compared, so an extra OR missing key is a regression. Applied to the semantic
 *     payload (`data`/`error`).
 *
 * A child whose top-level key is in {@link SUBSET_COMPARE_KEYS} (i.e. `meta`)
 * switches its subtree into subset mode.
 *
 * @param actual - The actual (normalized replay) value.
 * @param expected - The expected (golden) value.
 * @param path - Accumulated path prefix.
 * @param out - Mutable accumulator of `{ path, actual, expected }` tuples.
 * @param subset - When `true`, compare only the golden-declared keys at this node.
 */
function collectStructuralDiffs(
  actual: unknown,
  expected: unknown,
  path: string,
  out: { path: string; actual: unknown; expected: unknown }[],
  subset = false,
): void {
  if (actual === expected) return;

  const bothObjects =
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object' &&
    Array.isArray(actual) === Array.isArray(expected);

  if (!bothObjects) {
    out.push({ path, actual, expected });
    return;
  }

  const actualRec = actual as Record<string, unknown>;
  const expectedRec = expected as Record<string, unknown>;
  // Subset mode (meta container): compare ONLY the golden's keys, so extra
  // deterministic runtime meta keys are not regressions. Full mode: union both
  // key sets, so an extra OR missing payload key IS a regression.
  const keys = subset
    ? new Set<string>(Object.keys(expectedRec))
    : new Set<string>([...Object.keys(actualRec), ...Object.keys(expectedRec)]);
  for (const key of keys) {
    const childPath = path === '' ? key : `${path}/${key}`;
    // A `meta`/`_meta` container's subtree is compared as a subset; never widen
    // back to full-union once inside a subset container.
    const childSubset = subset || SUBSET_COMPARE_KEYS.has(key);
    collectStructuralDiffs(actualRec[key], expectedRec[key], childPath, out, childSubset);
  }
}

/**
 * Diff a set of replayed envelopes against the golden envelope set.
 *
 * Normalizes each replayed envelope (volatile meta stripped) and structurally
 * compares it against the positionally-aligned golden entry. The op coordinate
 * for each `DiffEntry` is taken from `ops[opIndex]`. Callers MUST pass aligned
 * arrays (`ops.length === replayed.length === golden.length`); the function
 * diffs up to the shortest length and reports an extra regression for any length
 * mismatch.
 *
 * The `meta` container is compared as a SUBSET (only golden-declared meta keys are
 * asserted) so deterministic-but-golden-absent infra keys the runtime stamps
 * (`specVersion`, `transport`, …) are not phantom regressions; the semantic
 * payload (`data`/`error`) keeps a full key-union compare where an extra or
 * missing key IS a regression. Together with the volatile-lineage strip in
 * {@link normalizeEnvelope}, a real live envelope that matches the golden body
 * yields ZERO regressions.
 *
 * @param ops - The scenario ops (for op-coordinate labelling).
 * @param replayed - The captured envelopes, one per op (replay order).
 * @param golden - The golden expected entries, positionally aligned with `ops`.
 * @returns `{ regressions }` — empty when the replay matches the golden.
 *
 * @example
 * ```ts
 * const { regressions } = diffEnvelopes(scenario.ops, replayed, golden.envelopes);
 * if (regressions.length === 0) { /* happy path — no DHQ, no PR *\/ }
 * ```
 */
export function diffEnvelopes(
  ops: ScenarioOp[],
  replayed: ReplayEnvelope[],
  golden: GoldenEntry[],
): EnvelopeDiffResult {
  const regressions: DiffEntry[] = [];
  const n = Math.min(ops.length, replayed.length, golden.length);

  for (let i = 0; i < n; i++) {
    const op = ops[i];
    const replayEnvelope = replayed[i];
    const goldenEntry = golden[i];
    if (op === undefined || replayEnvelope === undefined || goldenEntry === undefined) continue;

    const opCoord = `${op.domain}.${op.operation}`;
    const normalized = normalizeEnvelope(replayEnvelope);

    const leafDiffs: { path: string; actual: unknown; expected: unknown }[] = [];
    collectStructuralDiffs(normalized, goldenEntry as Record<string, unknown>, '', leafDiffs);
    for (const d of leafDiffs) {
      regressions.push({
        opIndex: i,
        opCoord,
        path: d.path,
        actual: d.actual,
        expected: d.expected,
      });
    }
  }

  if (replayed.length !== golden.length) {
    regressions.push({
      opIndex: -1,
      opCoord: '<count>',
      path: 'envelopes/length',
      actual: replayed.length,
      expected: golden.length,
    });
  }

  return { regressions };
}

/**
 * Extract a targeted field from a normalized envelope's `data` payload.
 *
 * Reuses the LAFS `--field` extractor (`extractFieldFromResult`) for cases where
 * a full structural diff is too brittle and only a specific field's value matters
 * (e.g. assert `data.tasks[0].id` without comparing the whole envelope).
 *
 * @param normalized - A normalized envelope (from {@link normalizeEnvelope}).
 * @param field - The field name to extract from the envelope's `data` payload.
 * @returns The extracted value, or `undefined` when absent.
 *
 * @example
 * ```ts
 * const id = extractTargetedField(normalizeEnvelope(env), 'id');
 * ```
 */
export function extractTargetedField(normalized: NormalizedEnvelope, field: string): unknown {
  const data = normalized.data;
  if (data === undefined || data === null) return undefined;
  // The LAFS extractor operates on a result value (object | array | null); the
  // dispatch envelope's `data` is the equivalent payload.
  if (typeof data !== 'object') return undefined;
  return extractFieldFromResult(data as Record<string, unknown> | Record<string, unknown>[], field);
}

/**
 * Build the deterministic regression signature for a diff result.
 *
 * The signature is the SORTED set of `{ opCoord, path }` pairs from the
 * regressions — NOT the values. Two runs that diverge at the same op coordinates
 * on the same paths produce the same signature (and thus the same
 * {@link computeQuestionHash}), so a repeated regression maps to ONE open DHQ row
 * rather than spamming duplicates. Actual/expected values are intentionally
 * excluded so transient value noise does not fork the hash.
 *
 * @param regressions - The diff regressions.
 * @returns A stable, sorted signature string.
 */
function regressionSignature(regressions: DiffEntry[]): string {
  const pairs = regressions.map((r) => `${r.opCoord}@${r.path}`);
  pairs.sort();
  return pairs.join('\n');
}

/**
 * Compute the sha256 `question_hash` of a diff result's normalized signature.
 *
 * The hash is over the {@link regressionSignature} (op coordinates + diff path
 * set), so it is stable across runs of the SAME regression and feeds the
 * idempotency partial-UNIQUE index (`ux_selfimprove_dhq_open`, T11889-A): one
 * open DHQ row per `question_hash`. An empty regression set hashes the empty
 * signature deterministically (callers should not persist on the happy path).
 *
 * @param result - The diff result whose regressions are hashed.
 * @returns The lowercase hex sha256 of the regression signature.
 *
 * @example
 * ```ts
 * const hash = computeQuestionHash(diffEnvelopes(ops, replayed, golden));
 * ```
 */
export function computeQuestionHash(result: EnvelopeDiffResult): string {
  const signature = regressionSignature(result.regressions);
  return createHash('sha256').update(signature, 'utf-8').digest('hex');
}
