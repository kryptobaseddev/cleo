import type { ConformanceReport, FlagInput, LAFSEnvelope } from "./types.js";
import { runEnvelopeConformance, runFlagConformance } from "./conformance.js";
import { resolveOutputFormat } from "./flagSemantics.js";
import { assertEnvelope, validateEnvelope, type EnvelopeValidationResult } from "./validateEnvelope.js";

export type ComplianceStage = "schema" | "envelope" | "flags" | "format";

export interface ComplianceIssue {
  stage: ComplianceStage;
  message: string;
  detail?: string;
}

export interface EnforceComplianceOptions {
  checkConformance?: boolean;
  checkFlags?: boolean;
  flags?: FlagInput;
  requireJsonOutput?: boolean;
}

export interface ComplianceResult {
  ok: boolean;
  envelope?: LAFSEnvelope;
  validation: EnvelopeValidationResult;
  envelopeConformance?: ConformanceReport;
  flagConformance?: ConformanceReport;
  issues: ComplianceIssue[];
}

export class ComplianceError extends Error {
  readonly issues: ComplianceIssue[];

  constructor(issues: ComplianceIssue[]) {
    super(`LAFS compliance failed: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ComplianceError";
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

export function enforceCompliance(
  input: unknown,
  options: EnforceComplianceOptions = {},
): ComplianceResult {
  const {
    checkConformance = true,
    checkFlags = false,
    flags,
    requireJsonOutput = false,
  } = options;

  const issues: ComplianceIssue[] = [];

  const validation = validateEnvelope(input);
  if (!validation.valid) {
    issues.push(
      ...validation.errors.map((error) => ({
        stage: "schema" as const,
        message: "schema validation failed",
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
      issues.push(...conformanceIssues(envelopeConformance, "envelope"));
    }
  }

  let flagConformance: ConformanceReport | undefined;
  if (checkFlags && flags) {
    flagConformance = runFlagConformance(flags);
    if (!flagConformance.ok) {
      issues.push(...conformanceIssues(flagConformance, "flags"));
    }
  }

  if (requireJsonOutput) {
    const resolved = resolveOutputFormat(flags ?? {});
    if (resolved.format !== "json") {
      issues.push({
        stage: "format",
        message: "non-json output format resolved",
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

export function withCompliance<TArgs extends unknown[], TResult extends LAFSEnvelope>(
  producer: (...args: TArgs) => TResult | Promise<TResult>,
  options: EnforceComplianceOptions = {},
): (...args: TArgs) => Promise<LAFSEnvelope> {
  return async (...args: TArgs): Promise<LAFSEnvelope> => {
    const envelope = await producer(...args);
    return assertCompliance(envelope, options);
  };
}

export type ComplianceMiddleware = (
  envelope: LAFSEnvelope,
  next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
) => Promise<LAFSEnvelope> | LAFSEnvelope;

export function createComplianceMiddleware(
  options: EnforceComplianceOptions = {},
): ComplianceMiddleware {
  return async (_envelope: LAFSEnvelope, next: () => LAFSEnvelope | Promise<LAFSEnvelope>) => {
    const candidate = await next();
    return assertCompliance(candidate, options);
  };
}
