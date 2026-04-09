/**
 * CLI envelope validator middleware (Phase 6 / ADR-039 update).
 *
 * Every CLI envelope emitted by `cliOutput()` flows through this module
 * before hitting stdout. Validates the **canonical CLI envelope** shape
 * (`{success, data?, error?, meta, page?}`) as defined in ADR-039.
 *
 * The canonical shape replaces the three legacy shapes:
 *   - `{ok, r, _m}` (minimal MVI — removed)
 *   - `{$schema, _meta, success, result}` (full LAFS — migrated)
 *   - `{success, result}` (observe command — migrated)
 *
 * Validation invariants:
 *   - Envelope MUST be a JSON object
 *   - `success` MUST be present and boolean
 *   - On success, `data` MUST exist (may be null)
 *   - On failure, `error` MUST exist with at least `code` and `message`
 *   - `meta` MUST be present (always — success and failure)
 *
 * When a violation is detected, the validator:
 *   1. Wraps the malformed output in a valid error envelope
 *   2. Sets the process exit code to `ExitCode.LAFS_VIOLATION` (104)
 *   3. Emits the wrapped envelope to stderr for diagnostic tooling
 *
 * @task Phase 6 — LAFS formalization + schema consolidation
 * @task T338 — ADR-039 canonical envelope unification
 */

import { ExitCode } from '@cleocode/contracts';

/**
 * Shape violation report for a canonical CLI envelope.
 *
 * Carries the individual invariant results so diagnostic tooling can
 * report exactly which invariants were violated.
 */
export interface LafsShapeViolation {
  /** True iff the input is a well-formed JSON object. */
  isObject: boolean;
  /** True iff `success` is present. */
  hasSuccessField: boolean;
  /** True iff `success` is a boolean. */
  successIsBoolean: boolean;
  /** True iff `meta` is present (always required — ADR-039). */
  hasMeta: boolean;
  /** True iff the data/error invariants hold for the indicated success value. */
  resultOrErrorValid: boolean;
  /** Human-readable reasons the envelope failed validation (empty = valid). */
  reasons: string[];
}

const ENVELOPE_SUCCESS_KEY = 'success';
const ENVELOPE_DATA_KEY = 'data';
const ENVELOPE_META_KEY = 'meta';

/**
 * Validate a canonical CLI envelope shape and report violations.
 *
 * Validates the unified `{success, data?, error?, meta, page?}` shape
 * defined in ADR-039. All three legacy shapes (`{ok,r,_m}`,
 * `{$schema,_meta,success,result}`, `{success,result}`) are now invalid
 * and will produce violation reports.
 *
 * @param envelope - The candidate envelope (serialized string or parsed object).
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

  // Success-indicator field presence (`success`, not legacy `ok`)
  if (!(ENVELOPE_SUCCESS_KEY in obj)) {
    report.reasons.push(`Envelope missing success indicator — expected: "${ENVELOPE_SUCCESS_KEY}"`);
    return report;
  }
  report.hasSuccessField = true;

  const successValue = obj[ENVELOPE_SUCCESS_KEY];
  if (typeof successValue !== 'boolean') {
    report.reasons.push(
      `Envelope "${ENVELOPE_SUCCESS_KEY}" field must be boolean, got ${typeof successValue}`,
    );
    return report;
  }
  report.successIsBoolean = true;

  // `meta` MUST be present and an object on every envelope (ADR-039)
  report.hasMeta = ENVELOPE_META_KEY in obj && typeof obj[ENVELOPE_META_KEY] === 'object';
  if (!report.hasMeta) {
    report.reasons.push(
      `Envelope missing required "${ENVELOPE_META_KEY}" object (ADR-039 — every envelope must carry meta)`,
    );
  }

  // Success / error invariants
  if (successValue === true) {
    // Successful envelopes carry `data` (not legacy `result` or `r`)
    const hasData = ENVELOPE_DATA_KEY in obj;
    if (!hasData) {
      report.reasons.push(
        `Successful envelope missing "${ENVELOPE_DATA_KEY}" field (legacy "result" / "r" are no longer valid — ADR-039)`,
      );
    } else {
      report.resultOrErrorValid = true;
    }
  } else {
    const errorField = obj['error'];
    if (typeof errorField !== 'object' || errorField === null) {
      report.reasons.push('Failed envelope missing "error" object');
    } else {
      const err = errorField as Record<string, unknown>;
      const hasCode = 'code' in err;
      const hasMessage = 'message' in err && typeof err['message'] === 'string';
      if (!hasCode || !hasMessage) {
        report.reasons.push(
          'Failed envelope "error" object must contain "code" and "message" (string)',
        );
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
  // Emit canonical CLI envelope shape (ADR-039) even for violation errors
  const envelope = {
    success: false,
    error: {
      code: ExitCode.LAFS_VIOLATION,
      codeName: 'E_LAFS_VIOLATION',
      message: err.message,
      details: {
        report: err.report,
      },
    },
    meta: {
      operation: 'cli.lafs-validator',
      requestId: 'lafs-validator-emit',
      duration_ms: 0,
      timestamp: new Date().toISOString(),
    },
  };
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = ExitCode.LAFS_VIOLATION;
}
