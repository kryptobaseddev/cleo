/**
 * LAFS envelope validator middleware (Phase 6).
 *
 * Every CLI envelope emitted by `cliOutput()` flows through this module
 * before hitting stdout. The middleware delegates to the canonical LAFS
 * validators where they exist and adds a thin shape check for the agent-
 * optimized **minimal envelope** format that the canonical schema does
 * not cover.
 *
 * **SSoT alignment** (post-review):
 *   - Full envelopes (`{$schema, _meta, success, result}`) are validated
 *     by `validateEnvelope()` from `@cleocode/lafs`, which uses the
 *     `lafs-napi` Rust binding (with AJV fallback) and the canonical
 *     schema at `packages/lafs/schemas/v1/envelope.schema.json`.
 *   - Minimal envelopes (`{ok, r, _m}`) are agent-optimized and not part
 *     of the public LAFS schema. We validate their shape locally with
 *     the lightweight invariant check below.
 *
 * Validation invariants enforced HERE (minimal envelopes only):
 *   - Envelope MUST be a JSON object (parseable from a string)
 *   - Envelope MUST have exactly one of {`ok`, `success`}
 *   - The success indicator MUST be a boolean
 *   - On success, `r` / `result` MUST exist (may be null)
 *   - On failure, `error` MUST exist with at least `code` and `message`
 *   - `_m` / `_meta` MUST be present in some form
 *
 * When a violation is detected, the validator:
 *   1. Wraps the malformed output in a valid error envelope
 *   2. Sets the process exit code to `ExitCode.LAFS_VIOLATION` (104)
 *   3. Emits the wrapped envelope to stderr for diagnostic tooling
 *
 * @task Phase 6 — LAFS formalization + schema consolidation
 * @see packages/lafs/src/validateEnvelope.ts — canonical full-envelope validator
 * @see packages/lafs/schemas/v1/envelope.schema.json — canonical full-envelope schema
 * @see crates/lafs-core — Rust embed of the canonical schema
 */

import { ExitCode } from '@cleocode/contracts';

/**
 * The minimum shape invariants for a LAFS envelope, compatible with both
 * minimal (`{ok, r, _m}`) and full (`{success, result, _meta}`) formats.
 */
export interface LafsShapeViolation {
  /** True iff the input is a well-formed JSON object. */
  isObject: boolean;
  /** True iff the envelope has exactly one success-indicator field. */
  hasSuccessField: boolean;
  /** True iff the success-indicator is a boolean. */
  successIsBoolean: boolean;
  /** True iff a metadata field (`_m` or `_meta`) is present. */
  hasMeta: boolean;
  /** True iff the result/error invariants hold for the indicated success value. */
  resultOrErrorValid: boolean;
  /** Human-readable reasons the envelope failed validation (empty = valid). */
  reasons: string[];
}

const ENVELOPE_OK_KEY_MINIMAL = 'ok';
const ENVELOPE_OK_KEY_FULL = 'success';
const ENVELOPE_RESULT_KEY_MINIMAL = 'r';
const ENVELOPE_RESULT_KEY_FULL = 'result';
const ENVELOPE_META_KEYS = ['_m', '_meta'] as const;

/**
 * Detect whether a parsed envelope is a "full" or "minimal" LAFS shape.
 *
 * Full shape uses {`success`, `result`, `_meta`}; minimal shape uses
 * {`ok`, `r`, `_m`}. Returns 'unknown' when neither indicator is present.
 */
function detectEnvelopeFlavor(obj: Record<string, unknown>): 'full' | 'minimal' | 'unknown' {
  if ('success' in obj || '_meta' in obj || '$schema' in obj) return 'full';
  if ('ok' in obj || '_m' in obj) return 'minimal';
  return 'unknown';
}

/**
 * Validate a LAFS envelope shape and report violations.
 *
 * Full envelopes are delegated to `@cleocode/lafs.validateEnvelope()` (which
 * uses the canonical schema via lafs-napi/AJV). Minimal envelopes are
 * checked against the lightweight invariants in this module.
 *
 * @param envelope - The candidate envelope (serialized string or object)
 * @returns A `LafsShapeViolation` report. `.reasons.length === 0` when valid.
 */
export function validateLafsShape(envelope: unknown): LafsShapeViolation {
  const report: LafsShapeViolation = {
    isObject: false,
    hasSuccessField: false,
    successIsBoolean: false,
    hasMeta: false,
    resultOrErrorValid: false,
    reasons: [],
  };

  // Allow callers to pass either a serialized envelope or a parsed one
  let parsed: unknown = envelope;
  if (typeof envelope === 'string') {
    try {
      parsed = JSON.parse(envelope);
    } catch {
      report.reasons.push('Envelope is not valid JSON');
      return report;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    report.reasons.push('Envelope is not a JSON object');
    return report;
  }
  report.isObject = true;

  const obj = parsed as Record<string, unknown>;

  // SSoT delegation: full envelopes go through @cleocode/lafs.validateEnvelope
  // which validates against the canonical packages/lafs/schemas/v1/envelope.schema.json
  // (via the lafs-napi Rust binding when available, AJV fallback otherwise).
  // We only inspect minimal envelopes locally because they're an internal
  // agent-optimized format that the canonical schema does not cover.
  const flavor = detectEnvelopeFlavor(obj);
  if (flavor === 'full') {
    try {
      // Lazy require to avoid pulling lafs into the cli bundle's hot path.
      // The package exports validateEnvelope() at the package root.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import shape
      const lafs = require('@cleocode/lafs') as {
        validateEnvelope: (input: unknown) => {
          valid: boolean;
          errors: string[];
        };
      };
      const result = lafs.validateEnvelope(obj);
      report.hasSuccessField = true;
      report.successIsBoolean = true;
      report.hasMeta = true;
      report.resultOrErrorValid = result.valid;
      if (!result.valid) {
        for (const err of result.errors) {
          report.reasons.push(`canonical validator: ${err}`);
        }
      }
      return report;
    } catch (loadErr) {
      // Fall through to the local minimal-shape check if @cleocode/lafs
      // can't be loaded for any reason — better than failing closed.
      report.reasons.push(
        `Could not load canonical LAFS validator (${loadErr instanceof Error ? loadErr.message : String(loadErr)}); falling back to local shape check`,
      );
      // continue to the minimal-shape path below
    }
  }

  // Success-indicator field presence
  const hasMinimal = ENVELOPE_OK_KEY_MINIMAL in obj;
  const hasFull = ENVELOPE_OK_KEY_FULL in obj;
  if (!hasMinimal && !hasFull) {
    report.reasons.push(
      `Envelope missing success indicator — expected one of: ${ENVELOPE_OK_KEY_MINIMAL}, ${ENVELOPE_OK_KEY_FULL}`,
    );
    return report;
  }
  report.hasSuccessField = true;

  const successValue = hasMinimal ? obj[ENVELOPE_OK_KEY_MINIMAL] : obj[ENVELOPE_OK_KEY_FULL];
  if (typeof successValue !== 'boolean') {
    report.reasons.push(`Envelope success field must be boolean, got ${typeof successValue}`);
    return report;
  }
  report.successIsBoolean = true;

  // Metadata presence
  report.hasMeta = ENVELOPE_META_KEYS.some((key) => key in obj);
  if (!report.hasMeta) {
    report.reasons.push(
      `Envelope missing metadata — expected one of: ${ENVELOPE_META_KEYS.join(', ')}`,
    );
  }

  // Success / error invariants
  if (successValue === true) {
    const hasResult = ENVELOPE_RESULT_KEY_MINIMAL in obj || ENVELOPE_RESULT_KEY_FULL in obj;
    if (!hasResult) {
      report.reasons.push(
        `Successful envelope missing result field (${ENVELOPE_RESULT_KEY_MINIMAL} | ${ENVELOPE_RESULT_KEY_FULL})`,
      );
    } else {
      report.resultOrErrorValid = true;
    }
  } else {
    const errorField = obj['error'];
    if (typeof errorField !== 'object' || errorField === null) {
      report.reasons.push('Failed envelope missing error object');
    } else {
      const err = errorField as Record<string, unknown>;
      const hasCode = 'code' in err;
      const hasMessage = 'message' in err && typeof err['message'] === 'string';
      if (!hasCode || !hasMessage) {
        report.reasons.push('Failed envelope error object must contain code and message (string)');
      } else {
        report.resultOrErrorValid = true;
      }
    }
  }

  return report;
}

/**
 * Assert that a LAFS envelope conforms to the shape contract, throwing
 * an error with a LAFS-shaped diagnostic if it does not.
 *
 * Used by the renderer middleware to fail LOUDLY when CLEO itself emits
 * a malformed envelope — this is a developer bug, not an operator issue.
 *
 * @param envelope - The candidate envelope
 * @throws `LafsViolationError` if the envelope fails any shape invariant
 */
export function assertLafsShape(envelope: unknown): void {
  const report = validateLafsShape(envelope);
  if (report.reasons.length > 0) {
    throw new LafsViolationError(
      `LAFS envelope shape violation: ${report.reasons.join('; ')}`,
      report,
    );
  }
}

/**
 * Error thrown by `assertLafsShape` when an envelope fails validation.
 *
 * Carries the full `LafsShapeViolation` report so diagnostic tooling can
 * report which specific invariants were violated.
 */
export class LafsViolationError extends Error {
  readonly code = ExitCode.LAFS_VIOLATION;
  readonly report: LafsShapeViolation;

  constructor(message: string, report: LafsShapeViolation) {
    super(message);
    this.name = 'LafsViolationError';
    this.report = report;
  }
}

/**
 * Emit a LAFS-shaped error envelope describing a validation failure and
 * set `process.exitCode` to `ExitCode.LAFS_VIOLATION`.
 *
 * Called by the renderer middleware as a recovery path when a previously-
 * emitted envelope turns out to be malformed.
 */
export function emitLafsViolation(err: LafsViolationError): void {
  const envelope = {
    ok: false,
    error: {
      code: 'E_LAFS_VIOLATION',
      message: err.message,
      category: 'internal',
      details: {
        exitCode: ExitCode.LAFS_VIOLATION,
        report: err.report,
      },
    },
    _m: {
      op: 'cli.lafs-validator',
      rid: 'lafs-validator-emit',
    },
  };
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = ExitCode.LAFS_VIOLATION;
}
