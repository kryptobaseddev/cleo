/**
 * Check/Validation domain Core operations — ADR-057 D1 normalized shape.
 *
 * Each function follows the uniform `(projectRoot: string, params: <Op>Params)`
 * signature so the dispatch layer can call Core directly without positional-arg
 * coupling or inline business logic.
 *
 * The original Core functions (`validateChain`, `revalidateEvidence`, etc.) are
 * preserved with their existing signatures for internal Core callers (lifecycle,
 * chain-store, etc.). This file provides **normalized wrappers** that satisfy the
 * ADR-057 D1 shape for the dispatch boundary.
 *
 * @module validation/ops
 * @task T1452 — check domain Core API SSoT alignment (ADR-057 D1)
 * @see ADR-057 — Core API normalization
 * @see packages/contracts/src/operations/validate.ts
 */

import type {
  GateEvidence,
  ValidateArchiveStatsParams,
  ValidateArchiveStatsResult,
  ValidateChainParams,
  ValidateChainResult,
  ValidateCoherenceParams,
  ValidateCoherenceResult,
  ValidateComplianceRecordParams,
  ValidateComplianceRecordResult,
  ValidateComplianceSummaryParams,
  ValidateComplianceSummaryResult,
  ValidateComplianceSyncParams,
  ValidateComplianceSyncResult,
  ValidateGradeListParams,
  ValidateGradeListResult,
  ValidateGradeParams,
  ValidateGradeResult,
  ValidateManifestParams,
  ValidateManifestResult,
  ValidateOutputParams,
  ValidateOutputResult,
  ValidateProtocolParams,
  ValidateProtocolResult,
  ValidateSchemaParams,
  ValidateSchemaResult,
  ValidateTaskParams,
  ValidateTaskResult,
  ValidateTestCoverageParams,
  ValidateTestCoverageResult,
  ValidateTestRunParams,
  ValidateTestRunResult,
  ValidateTestStatusParams,
  ValidateTestStatusResult,
  ValidateWorkflowComplianceParams,
  ValidateWorkflowComplianceResult,
} from '@cleocode/contracts';
import { revalidateEvidence } from '../tasks/evidence.js';
import { validateChain } from './chain-validation.js';
import {
  coreBatchValidate,
  coreCoherenceCheck,
  coreComplianceRecord,
  coreComplianceSummary,
  coreComplianceViolations,
  coreTestCoverage,
  coreTestRun,
  coreTestStatus,
  coreValidateManifest,
  coreValidateOutput,
  coreValidateProtocol,
  coreValidateSchema,
  coreValidateTask,
} from './validate-ops.js';

// ---------------------------------------------------------------------------
// Re-validation evidence params shape
// ---------------------------------------------------------------------------

/**
 * Parameters for the normalized {@link checkRevalidateEvidence} wrapper.
 *
 * @task T1452
 */
export interface CheckRevalidateEvidenceParams {
  /** Evidence bundle to re-validate. */
  evidence: GateEvidence;
}

/**
 * Result returned by {@link checkRevalidateEvidence}.
 *
 * @task T1452
 */
export interface CheckRevalidateEvidenceResult {
  /** Whether all evidence atoms are still valid. */
  stillValid: boolean;
  /** Atoms that failed re-validation with a human-readable reason. */
  failedAtoms: Array<{
    atom: GateEvidence['atoms'][number];
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Chain validate
// ---------------------------------------------------------------------------

/**
 * Validate a WarpChain definition.
 *
 * Normalized wrapper over {@link validateChain} conforming to ADR-057 D1.
 * The underlying function is a pure validator and does not use `projectRoot`,
 * but the wrapper accepts it to satisfy the uniform dispatch contract.
 *
 * @param _projectRoot - Absolute path to the project root (unused — pure fn).
 * @param params       - Chain validation parameters (`params.chain`).
 * @returns Unified chain validation result.
 *
 * @task T1452
 */
export function checkValidateChain(
  _projectRoot: string,
  params: ValidateChainParams,
): ValidateChainResult {
  return validateChain(params.chain);
}

// ---------------------------------------------------------------------------
// Re-validate evidence
// ---------------------------------------------------------------------------

/**
 * Re-validate previously-captured evidence atoms for staleness.
 *
 * Normalized wrapper over {@link revalidateEvidence} that corrects the original
 * argument order (`evidence, projectRoot` → `projectRoot, params`), conforming
 * to ADR-057 D1.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Evidence bundle to re-validate.
 * @returns Revalidation outcome with per-atom failure details.
 *
 * @task T1452
 * @adr ADR-051
 */
export async function checkRevalidateEvidence(
  projectRoot: string,
  params: CheckRevalidateEvidenceParams,
): Promise<CheckRevalidateEvidenceResult> {
  return revalidateEvidence(params.evidence, projectRoot);
}

// ---------------------------------------------------------------------------
// Schema validate
// ---------------------------------------------------------------------------

/**
 * Validate data against a named schema type.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Schema type and optional data payload.
 *
 * @task T1452
 */
export async function checkValidateSchema(
  projectRoot: string,
  params: ValidateSchemaParams,
): Promise<ValidateSchemaResult> {
  const result = await coreValidateSchema(params.type ?? '', params.data, projectRoot);
  return {
    valid: result.valid,
    schemaVersion: 'current',
    violations: (result.errors ?? []).map((e) => {
      const err = e as Record<string, unknown>;
      return {
        rule: String(err['keyword'] ?? 'schema'),
        severity: 'error' as const,
        message: String(err['message'] ?? 'Schema violation'),
        field: err['path'] ? String(err['path']) : undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Task validate
// ---------------------------------------------------------------------------

/**
 * Validate a single task against anti-hallucination rules.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Task ID and check mode.
 *
 * @task T1452
 */
export async function checkValidateTask(
  projectRoot: string,
  params: ValidateTaskParams,
): Promise<ValidateTaskResult> {
  const result = await coreValidateTask(params.taskId, projectRoot);
  const violations = result.violations.map((v) => ({
    rule: v.rule ?? 'task-rule',
    severity: v.severity as 'error' | 'warning' | 'info',
    message: v.message,
    field: v.field,
  }));
  return {
    taskId: result.taskId,
    valid: result.valid,
    violations,
    checks: {
      idUniqueness: !violations.some((v) => v.rule === 'UNIQUE_ID'),
      titleDescriptionDifferent: !violations.some((v) => v.rule === 'TITLE_DESCRIPTION_DIFFERENT'),
      validStatus: !violations.some((v) => v.rule === 'VALID_STATUS'),
      noFutureTimestamps: !violations.some((v) => v.rule === 'NO_FUTURE_TIMESTAMPS'),
      noDuplicateDescription: !violations.some((v) => v.rule === 'DUPLICATE_DESCRIPTION'),
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest validate
// ---------------------------------------------------------------------------

/**
 * Validate manifest JSONL entries for required fields.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params     - Optional entry and taskId filters (unused in core impl).
 *
 * @task T1452
 */
export function checkValidateManifest(
  projectRoot: string,
  _params: ValidateManifestParams,
): ValidateManifestResult {
  const result = coreValidateManifest(projectRoot);
  return {
    valid: result.valid,
    entry: { id: '', file: '', exists: result.totalEntries > 0 },
    violations: result.errors.flatMap((e) =>
      e.errors.map((msg) => ({
        rule: 'manifest',
        severity: 'error' as const,
        message: `Line ${e.line} (${e.entryId}): ${msg}`,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Output validate
// ---------------------------------------------------------------------------

/**
 * Validate an output file for required sections.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - File path and optional task ID.
 *
 * @task T1452
 */
export function checkValidateOutput(
  projectRoot: string,
  params: ValidateOutputParams,
): ValidateOutputResult {
  const result = coreValidateOutput(params.filePath, params.taskId, projectRoot);
  const violations = result.issues.map((issue) => ({
    rule: issue.code,
    severity: issue.severity as 'error' | 'warning' | 'info',
    message: issue.message,
  }));
  return {
    taskId: params.taskId ?? '',
    filePath: result.filePath,
    valid: result.valid,
    checks: {
      fileExists: true,
      hasTaskHeader: !violations.some((v) => v.rule === 'O_MISSING_TITLE'),
      hasStatus: true,
      hasSummary: !violations.some((v) => v.rule === 'O_MISSING_SUMMARY'),
      linkedToTask: !violations.some((v) => v.rule === 'O_MISSING_TASK_REF'),
    },
    violations,
  };
}

// ---------------------------------------------------------------------------
// Compliance summary
// ---------------------------------------------------------------------------

/**
 * Get aggregated compliance metrics.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Query parameters (scope, since, detail, limit, type, etc.).
 *
 * @task T1452
 */
export function checkComplianceSummary(
  projectRoot: string,
  params: ValidateComplianceSummaryParams,
): ValidateComplianceSummaryResult {
  if (params.detail) {
    const result = coreComplianceViolations(params.limit, projectRoot);
    return {
      total: result.total,
      passed: 0,
      failed: result.total,
      score: 0,
      byProtocol: {},
      bySeverity: { error: result.total, warning: 0, info: 0 },
    };
  }
  const result = coreComplianceSummary(projectRoot);
  return {
    total: result.total,
    passed: result.pass,
    failed: result.fail,
    score: result.passRate,
    byProtocol: Object.fromEntries(
      Object.entries(result.byProtocol).map(([k, v]) => [k, { passed: v.pass, failed: v.fail }]),
    ),
    bySeverity: { error: result.fail, warning: result.partial, info: 0 },
  };
}

// ---------------------------------------------------------------------------
// Test status
// ---------------------------------------------------------------------------

/**
 * Check test suite availability and status.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params     - Optional taskId and format filters.
 *
 * @task T1452
 */
export function checkTestStatus(
  projectRoot: string,
  _params: ValidateTestStatusParams,
): ValidateTestStatusResult {
  // coreTestStatus returns structural availability info; map to the
  // contract's numeric shape with zeroed counts (no runner invoked here).
  void coreTestStatus(projectRoot);
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    passRate: 0,
  };
}

// ---------------------------------------------------------------------------
// Test coverage
// ---------------------------------------------------------------------------

/**
 * Get test coverage metrics from coverage-summary.json.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params     - Optional taskId filter.
 *
 * @task T1452
 */
export function checkTestCoverage(
  projectRoot: string,
  _params: ValidateTestCoverageParams,
): ValidateTestCoverageResult {
  const result = coreTestCoverage(projectRoot);
  const lines = result['lines'] as Record<string, unknown> | undefined;
  const branches = result['branches'] as Record<string, unknown> | undefined;
  const functions = result['functions'] as Record<string, unknown> | undefined;
  const statements = result['statements'] as Record<string, unknown> | undefined;
  return {
    lineCoverage: typeof lines?.['pct'] === 'number' ? lines['pct'] : 0,
    branchCoverage: typeof branches?.['pct'] === 'number' ? branches['pct'] : 0,
    functionCoverage: typeof functions?.['pct'] === 'number' ? functions['pct'] : 0,
    statementCoverage: typeof statements?.['pct'] === 'number' ? statements['pct'] : 0,
    threshold: 0,
    meetsThreshold: false,
  };
}

// ---------------------------------------------------------------------------
// Coherence check
// ---------------------------------------------------------------------------

/**
 * Cross-validate task graph for consistency.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param _params     - Optional taskId filter (unused in core impl).
 *
 * @task T1452
 */
export async function checkCoherence(
  projectRoot: string,
  _params: ValidateCoherenceParams,
): Promise<ValidateCoherenceResult> {
  const result = await coreCoherenceCheck(projectRoot);
  const errors = result.issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = result.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return {
    passed: result.coherent,
    issues: errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Protocol validate
// ---------------------------------------------------------------------------

/**
 * Validate basic protocol compliance for a task (generic case).
 *
 * Sub-protocol validators (consensus, contribution, etc.) remain in the
 * validate engine and are called directly by the dispatch handler.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Protocol type, task ID, and mode.
 *
 * @task T1452
 */
export async function checkValidateProtocol(
  projectRoot: string,
  params: ValidateProtocolParams,
): Promise<ValidateProtocolResult> {
  const result = await coreValidateProtocol(params.taskId ?? '', params.protocolType, projectRoot);
  const violations = result.violations.map((v) => ({
    rule: v.code,
    severity: v.severity as 'error' | 'warning' | 'info',
    message: v.message,
  }));
  return {
    taskId: result.taskId,
    protocol: result.protocolType,
    passed: result.compliant,
    score: result.compliant ? 100 : 0,
    violations,
    requirements: {
      total: violations.length,
      met: violations.filter((v) => v.severity !== 'error').length,
      failed: violations.filter((v) => v.severity === 'error').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Compliance record
// ---------------------------------------------------------------------------

/**
 * Record a compliance check result to COMPLIANCE.jsonl.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Task ID, result, optional protocol and violations.
 *
 * @task T1452
 */
export function checkComplianceRecord(
  projectRoot: string,
  params: ValidateComplianceRecordParams,
): ValidateComplianceRecordResult {
  const result = coreComplianceRecord(
    params.taskId,
    params.result,
    params.protocol,
    params.violations,
    projectRoot,
  );
  return {
    taskId: result.taskId,
    recorded: result.result,
    metrics: {
      total: 1,
      passed: result.result === 'pass' ? 1 : 0,
      failed: result.result === 'fail' ? 1 : 0,
      score: result.result === 'pass' ? 100 : 0,
      byProtocol: {
        [result.protocol]: {
          passed: result.result === 'pass' ? 1 : 0,
          failed: result.result === 'fail' ? 1 : 0,
        },
      },
      bySeverity: { error: 0, warning: 0, info: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Test run
// ---------------------------------------------------------------------------

/**
 * Execute test suite via subprocess.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Test scope, pattern, and parallelism options.
 *
 * @task T1452
 */
export function checkTestRun(
  projectRoot: string,
  params: ValidateTestRunParams,
): ValidateTestRunResult {
  const result = coreTestRun(
    { scope: params.scope, pattern: params.pattern, parallel: params.parallel },
    projectRoot,
  );
  return {
    status: {
      total: 0,
      passed: result.passed === true ? 1 : 0,
      failed: result.passed === false && result.ran ? 1 : 0,
      skipped: 0,
      passRate: result.passed === true ? 100 : 0,
    },
    coverage: {
      lineCoverage: 0,
      branchCoverage: 0,
      functionCoverage: 0,
      statementCoverage: 0,
      threshold: 0,
      meetsThreshold: false,
    },
    duration: '0s',
    output: result.stdout ?? result.stderr,
  };
}

// ---------------------------------------------------------------------------
// Compliance sync
// ---------------------------------------------------------------------------

/**
 * Sync compliance metrics.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Force flag.
 *
 * @task T1452
 */
export async function checkComplianceSync(
  projectRoot: string,
  params: ValidateComplianceSyncParams,
): Promise<ValidateComplianceSyncResult> {
  const { syncComplianceMetrics } = await import('../compliance/index.js');
  return syncComplianceMetrics({ force: params.force, cwd: projectRoot });
}

// ---------------------------------------------------------------------------
// Batch validate
// ---------------------------------------------------------------------------

/**
 * Batch-validate all tasks in the project.
 *
 * @param projectRoot - Absolute path to the project root.
 *
 * @task T1452
 */
export async function checkBatchValidate(projectRoot: string): Promise<Record<string, unknown>> {
  return coreBatchValidate(projectRoot);
}

// ---------------------------------------------------------------------------
// Grade operations
// ---------------------------------------------------------------------------

/**
 * Grade a session by its ID.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Session ID.
 *
 * @task T1452
 */
export async function checkGradeSession(
  projectRoot: string,
  params: ValidateGradeParams,
): Promise<ValidateGradeResult> {
  const { gradeSession } = await import('../sessions/session-grade.js');
  const result = await gradeSession(params.sessionId, projectRoot);
  // ValidateGradeResult is Record<string, unknown> — spread to satisfy index signature
  return { ...result };
}

/**
 * List grades with optional session filter and pagination.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Optional session ID, limit, and offset filters.
 *
 * @task T1452
 */
export async function checkReadGrades(
  projectRoot: string,
  params: ValidateGradeListParams,
): Promise<ValidateGradeListResult> {
  const { readGrades } = await import('../sessions/session-grade.js');
  const allGrades = await readGrades(undefined, projectRoot);
  const filtered = params.sessionId
    ? allGrades.filter((g) => g.sessionId === params.sessionId)
    : allGrades;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? filtered.length;
  return {
    grades: filtered.slice(offset, offset + limit),
    total: allGrades.length,
    filtered: filtered.length,
  };
}

// ---------------------------------------------------------------------------
// Workflow compliance
// ---------------------------------------------------------------------------

/**
 * Get workflow compliance report.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Optional since date filter.
 *
 * @task T1452
 */
export async function checkWorkflowCompliance(
  projectRoot: string,
  params: ValidateWorkflowComplianceParams,
): Promise<ValidateWorkflowComplianceResult> {
  const { getWorkflowComplianceReport } = await import('../stats/workflow-telemetry.js');
  const result = await getWorkflowComplianceReport({ since: params.since, cwd: projectRoot });
  // ValidateWorkflowComplianceResult is Record<string, unknown> — spread to satisfy index sig
  return { ...result };
}

// ---------------------------------------------------------------------------
// Archive stats
// ---------------------------------------------------------------------------

/**
 * Get archive statistics.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params      - Optional period, report type, since/until date filters.
 *
 * @task T1452
 */
export async function checkArchiveStats(
  projectRoot: string,
  params: ValidateArchiveStatsParams,
): Promise<ValidateArchiveStatsResult> {
  const { getAccessor } = await import('../store/data-accessor.js');
  const accessor = await getAccessor(projectRoot);

  if (params.report && params.report !== 'summary') {
    const { analyzeArchive } = await import('../system/archive-analytics.js');
    const result = await analyzeArchive(
      {
        report: params.report as Parameters<typeof analyzeArchive>[0]['report'],
        since: params.since,
        until: params.until,
        cwd: projectRoot,
      },
      accessor,
    );
    // ValidateArchiveStatsResult is Record<string, unknown> — spread to satisfy index sig
    return { ...result };
  }

  const { getArchiveStats } = await import('../system/archive-stats.js');
  const result = await getArchiveStats({ period: params.period, cwd: projectRoot }, accessor);
  // ValidateArchiveStatsResult is Record<string, unknown> — spread to satisfy index sig
  return { ...result };
}
