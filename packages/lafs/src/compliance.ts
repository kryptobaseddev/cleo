import { runEnvelopeConformance, runFlagConformance } from './conformance.js';
import { resolveOutputFormat } from './flagSemantics.js';
import type { ConformanceReport, FlagInput, LAFSEnvelope } from './types.js';
import {
  assertEnvelope,
  type EnvelopeValidationResult,
  validateEnvelope,
} from './validateEnvelope.js';

/**
 * Identifies which stage of the compliance pipeline produced an issue.
 *
 * @remarks
 * Used by {@link ComplianceIssue} to classify where a failure originated
 * during multi-stage LAFS compliance enforcement.
 */
export type ComplianceStage = 'schema' | 'envelope' | 'flags' | 'format';

/**
 * Describes a single compliance failure detected during enforcement.
 *
 * @remarks
 * Each issue maps to a specific pipeline stage and includes a human-readable
 * message with an optional detail string for diagnostics.
 */
export interface ComplianceIssue {
  /** The pipeline stage that produced this issue. */
  stage: ComplianceStage;
  /** A short, human-readable description of the failure. */
  message: string;
  /**
   * Additional diagnostic information about the failure.
   * @defaultValue undefined
   */
  detail?: string;
}

/**
 * Options controlling which compliance stages are executed.
 *
 * @remarks
 * All options default to safe values so callers can pass an empty object
 * and still get schema validation.
 */
export interface EnforceComplianceOptions {
  /**
   * Whether to run envelope conformance checks after schema validation.
   * @defaultValue true
   */
  checkConformance?: boolean;
  /**
   * Whether to run flag conformance checks.
   * @defaultValue false
   */
  checkFlags?: boolean;
  /**
   * Flag input to validate when {@link checkFlags} is enabled.
   * @defaultValue undefined
   */
  flags?: FlagInput;
  /**
   * When true, asserts that the resolved output format is JSON.
   * @defaultValue false
   */
  requireJsonOutput?: boolean;
}

/**
 * Aggregated result of a full LAFS compliance run.
 *
 * @remarks
 * Contains the overall pass/fail status, per-stage reports, and the
 * parsed envelope when schema validation succeeds.
 */
export interface ComplianceResult {
  /** True when every executed stage passes with zero issues. */
  ok: boolean;
  /**
   * The parsed envelope, present only when schema validation succeeds.
   * @defaultValue undefined
   */
  envelope?: LAFSEnvelope;
  /** Schema validation result from AJV. */
  validation: EnvelopeValidationResult;
  /**
   * Envelope conformance report, present when {@link EnforceComplianceOptions.checkConformance} is true.
   * @defaultValue undefined
   */
  envelopeConformance?: ConformanceReport;
  /**
   * Flag conformance report, present when {@link EnforceComplianceOptions.checkFlags} is true.
   * @defaultValue undefined
   */
  flagConformance?: ConformanceReport;
  /** All issues collected across every executed stage. */
  issues: ComplianceIssue[];
}

/**
 * Error thrown when {@link assertCompliance} or {@link withCompliance} detects failures.
 *
 * @remarks
 * Extends `Error` with a structured `issues` array so callers can
 * programmatically inspect each failure without parsing the message string.
 *
 * @example
 * ```ts
 * try {
 *   assertCompliance(envelope);
 * } catch (err) {
 *   if (err instanceof ComplianceError) {
 *     console.log(err.issues);
 *   }
 * }
 * ```
 */
export class ComplianceError extends Error {
  /** The structured list of compliance issues that caused this error. */
  readonly issues: ComplianceIssue[];

  /**
   * Creates a new ComplianceError from a list of issues.
   *
   * @param issues - The compliance issues that triggered this error.
   */
  constructor(issues: ComplianceIssue[]) {
    super(`LAFS compliance failed: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'ComplianceError';
    this.issues = issues;
  }
}

function conformanceIssues(report: ConformanceReport, stage: ComplianceStage): ComplianceIssue[] {
  return report.checks
    .filter((check) => !check.pass)
    .map((check) => ({
      stage,
      message: `${check.name} failed`,
      detail: check.detail,
    }));
}

/**
 * Runs the full LAFS compliance pipeline against an unknown input value.
 *
 * @remarks
 * Executes stages in order: schema validation, envelope conformance,
 * flag conformance, and output-format assertion. Each stage is gated
 * by the corresponding option. Schema validation always runs first;
 * if it fails, later stages are skipped.
 *
 * @param input - The raw value to validate as a LAFS envelope.
 * @param options - Controls which optional stages execute.
 * @returns A {@link ComplianceResult} with the aggregate pass/fail status and per-stage reports.
 *
 * @example
 * ```ts
 * const result = enforceCompliance(rawJson, { checkFlags: true, flags: { jsonFlag: true } });
 * if (!result.ok) {
 *   console.error(result.issues);
 * }
 * ```
 */
export function enforceCompliance(
  input: unknown,
  options: EnforceComplianceOptions = {},
): ComplianceResult {
  const { checkConformance = true, checkFlags = false, flags, requireJsonOutput = false } = options;

  const issues: ComplianceIssue[] = [];

  const validation = validateEnvelope(input);
  if (!validation.valid) {
    issues.push(
      ...validation.errors.map((error) => ({
        stage: 'schema' as const,
        message: 'schema validation failed',
        detail: error,
      })),
    );

    return {
      ok: false,
      validation,
      issues,
    };
  }

  const envelope = assertEnvelope(input);

  let envelopeConformance: ConformanceReport | undefined;
  if (checkConformance) {
    envelopeConformance = runEnvelopeConformance(envelope);
    if (!envelopeConformance.ok) {
      issues.push(...conformanceIssues(envelopeConformance, 'envelope'));
    }
  }

  let flagConformance: ConformanceReport | undefined;
  if (checkFlags && flags) {
    flagConformance = runFlagConformance(flags);
    if (!flagConformance.ok) {
      issues.push(...conformanceIssues(flagConformance, 'flags'));
    }
  }

  if (requireJsonOutput) {
    const resolved = resolveOutputFormat(flags ?? {});
    if (resolved.format !== 'json') {
      issues.push({
        stage: 'format',
        message: 'non-json output format resolved',
        detail: `resolved format is ${resolved.format}`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    envelope,
    validation,
    envelopeConformance,
    flagConformance,
    issues,
  };
}

/**
 * Validates input and throws {@link ComplianceError} on any failure.
 *
 * @remarks
 * Thin wrapper around {@link enforceCompliance} that converts a non-ok
 * result into an exception. Useful in pipelines where compliance is a
 * hard gate.
 *
 * @param input - The raw value to validate as a LAFS envelope.
 * @param options - Controls which optional stages execute.
 * @returns The validated {@link LAFSEnvelope} when all stages pass.
 * @throws {@link ComplianceError} When any compliance stage fails.
 *
 * @example
 * ```ts
 * const envelope = assertCompliance(rawJson);
 * ```
 */
export function assertCompliance(
  input: unknown,
  options: EnforceComplianceOptions = {},
): LAFSEnvelope {
  const result = enforceCompliance(input, options);
  if (!result.ok || !result.envelope) {
    throw new ComplianceError(result.issues);
  }
  return result.envelope;
}

/**
 * Wraps an envelope-producing function with automatic compliance enforcement.
 *
 * @remarks
 * Returns a new async function that calls the producer, then pipes the
 * result through {@link assertCompliance}. If the producer returns a
 * non-compliant envelope, the wrapper throws {@link ComplianceError}.
 *
 * @typeParam TArgs - Argument types forwarded to the producer function.
 * @typeParam TResult - The envelope subtype returned by the producer.
 * @param producer - A sync or async function that produces a LAFS envelope.
 * @param options - Compliance options forwarded to {@link assertCompliance}.
 * @returns An async function with the same signature that enforces compliance on every call.
 *
 * @example
 * ```ts
 * const safeFetch = withCompliance(fetchEnvelope, { checkConformance: true });
 * const envelope = await safeFetch('/api/data');
 * ```
 */
export function withCompliance<TArgs extends unknown[], TResult extends LAFSEnvelope>(
  producer: (...args: TArgs) => TResult | Promise<TResult>,
  options: EnforceComplianceOptions = {},
): (...args: TArgs) => Promise<LAFSEnvelope> {
  return async (...args: TArgs): Promise<LAFSEnvelope> => {
    const envelope = await producer(...args);
    return assertCompliance(envelope, options);
  };
}

/**
 * Middleware signature for intercepting LAFS envelopes in a pipeline.
 *
 * @remarks
 * Follows a standard middleware pattern: receive the current envelope,
 * call `next()` to continue the chain, then optionally transform the result.
 *
 * @param envelope - The envelope entering this middleware.
 * @param next - Callback that invokes the next middleware or terminal handler.
 * @returns The (possibly transformed) envelope to pass upstream.
 */
export type ComplianceMiddleware = (
  envelope: LAFSEnvelope,
  next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
) => Promise<LAFSEnvelope> | LAFSEnvelope;

/**
 * Creates a {@link ComplianceMiddleware} that enforces LAFS compliance on the next handler's output.
 *
 * @remarks
 * The returned middleware calls `next()`, then pipes the candidate envelope
 * through {@link assertCompliance}. Non-compliant envelopes cause a
 * {@link ComplianceError} to propagate.
 *
 * @param options - Compliance options forwarded to {@link assertCompliance}.
 * @returns A middleware function that validates the downstream envelope.
 *
 * @example
 * ```ts
 * const mw = createComplianceMiddleware({ checkConformance: true });
 * const result = await mw(currentEnvelope, () => produceEnvelope());
 * ```
 */
export function createComplianceMiddleware(
  options: EnforceComplianceOptions = {},
): ComplianceMiddleware {
  return async (_envelope: LAFSEnvelope, next: () => LAFSEnvelope | Promise<LAFSEnvelope>) => {
    const candidate = await next();
    return assertCompliance(candidate, options);
  };
}
