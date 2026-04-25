/**
 * Validate / Check Domain Operations
 *
 * T982 extension: Added new types for gate, archive, coherence, compliance-sync,
 * chain, grade, canon, workflow-compliance, verify-explain, and all protocol subtypes.
 */

import type { WarpChain } from '../warp-chain.js';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationViolation {
  rule: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  value?: unknown;
  expected?: unknown;
  line?: number;
}

export interface ComplianceMetrics {
  total: number;
  passed: number;
  failed: number;
  score: number;
  byProtocol: Record<string, { passed: number; failed: number }>;
  bySeverity: Record<ValidationSeverity, number>;
}

export interface ValidateSchemaParams {
  fileType?: 'todo' | 'config' | 'archive' | 'log' | 'manifest';
  filePath?: string;
  type?: string;
  data?: unknown;
}
export interface ValidateSchemaResult {
  valid: boolean;
  schemaVersion: string;
  violations: ValidationViolation[];
}

export interface ValidateProtocolBaseParams {
  mode?: 'task' | 'manifest';
  taskId?: string;
  manifestFile?: string;
  strict?: boolean;
}

export interface ValidateProtocolParams extends ValidateProtocolBaseParams {
  protocolType?: string;
  votingMatrixFile?: string;
  epicId?: string;
  specFile?: string;
  hasCodeChanges?: boolean;
  adrContent?: string;
  status?: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  hitlReviewed?: boolean;
  downstreamFlagged?: boolean;
  persistedInDb?: boolean;
  specMatchConfirmed?: boolean;
  testSuitePassed?: boolean;
  protocolComplianceChecked?: boolean;
  framework?: string;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  coveragePercent?: number;
  coverageThreshold?: number;
  ivtLoopConverged?: boolean;
  ivtLoopIterations?: number;
  version?: string;
  hasChangelog?: boolean;
  artifactType?: string;
  buildPassed?: boolean;
  hasAttestation?: boolean;
  hasSbom?: boolean;
}

export interface ValidateProtocolResult {
  taskId: string;
  protocol: string;
  passed: boolean;
  score: number;
  violations: ValidationViolation[];
  requirements: { total: number; met: number; failed: number };
}

export interface ValidateTaskParams {
  taskId: string;
  checkMode?: 'basic' | 'strict' | 'anti-hallucination';
}
export interface ValidateTaskResult {
  taskId: string;
  valid: boolean;
  violations: ValidationViolation[];
  checks: {
    idUniqueness: boolean;
    titleDescriptionDifferent: boolean;
    validStatus: boolean;
    noFutureTimestamps: boolean;
    noDuplicateDescription: boolean;
  };
}

export interface ValidateManifestParams {
  entry?: string;
  taskId?: string;
}
export interface ValidateManifestResult {
  valid: boolean;
  entry: { id: string; file: string; exists: boolean };
  violations: ValidationViolation[];
}

export interface ValidateOutputParams {
  taskId?: string;
  filePath: string;
}
export interface ValidateOutputResult {
  taskId: string;
  filePath: string;
  valid: boolean;
  checks: {
    fileExists: boolean;
    hasTaskHeader: boolean;
    hasStatus: boolean;
    hasSummary: boolean;
    linkedToTask: boolean;
  };
  violations: ValidationViolation[];
}

export interface ValidateComplianceSummaryParams {
  scope?: string;
  since?: string;
  detail?: boolean;
  limit?: number;
  type?: string;
  taskId?: string;
  days?: number;
  global?: unknown;
}
export type ValidateComplianceSummaryResult = ComplianceMetrics;

export interface ValidateComplianceViolationsParams {
  severity?: ValidationSeverity;
  protocol?: string;
}
export interface ValidateComplianceViolationsResult {
  violations: Array<ValidationViolation & { taskId: string; protocol: string; timestamp: string }>;
  total: number;
}

export interface ValidateTestStatusParams {
  taskId?: string;
  format?: string;
}
export interface ValidateTestStatusResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  byTask?: Record<string, { passed: number; failed: number }>;
}

export interface ValidateTestCoverageParams {
  taskId?: string;
}
export interface ValidateTestCoverageResult {
  lineCoverage: number;
  branchCoverage: number;
  functionCoverage: number;
  statementCoverage: number;
  threshold: number;
  meetsThreshold: boolean;
}

export interface ValidateCoherenceParams {
  taskId?: string;
}
export interface ValidateCoherenceResult {
  passed: boolean;
  issues: string[];
  warnings: string[];
}

export interface ValidateGateParams {
  taskId: string;
  gate?: string;
  value?: boolean;
  agent?: string;
  all?: boolean;
  reset?: boolean;
  evidence?: string;
  sessionId?: string;
}
export interface ValidateGateResult {
  taskId: string;
  gates: Record<string, boolean>;
  passed: boolean;
  round: number;
}

export interface ValidateVerifyExplainParams {
  taskId: string;
}
export interface ValidateVerifyExplainResult {
  taskId: string;
  title?: string;
  status?: string;
  passed: boolean;
  round: number;
  gates: Record<string, boolean>;
  evidence: Record<string, unknown[]>;
  requiredGates: string[];
  missingGates: string[];
  explanation: string;
}

export type ArchiveReportTypeAlias =
  | 'summary'
  | 'by-phase'
  | 'by-label'
  | 'by-priority'
  | 'cycle-times'
  | 'trends';

export interface ValidateArchiveStatsParams {
  period?: number;
  report?: ArchiveReportTypeAlias;
  since?: string;
  until?: string;
}
export type ValidateArchiveStatsResult = Record<string, unknown>;

export interface ValidateChainParams {
  chain: WarpChain;
}
export interface ValidateChainResult {
  wellFormed: boolean;
  gateSatisfiable: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidateGradeParams {
  sessionId: string;
}
export type ValidateGradeResult = Record<string, unknown>;

export interface ValidateGradeListParams {
  sessionId?: string;
  limit?: number;
  offset?: number;
}
export interface ValidateGradeListResult {
  grades: unknown[];
  total: number;
  filtered: number;
}

export interface ValidateCanonParams {
  taskId?: string;
}
export interface ValidateCanonResult {
  passed: boolean;
  violations: unknown[];
  assertions: Array<{ passed: boolean }>;
}

export interface ValidateWorkflowComplianceParams {
  since?: string;
}
export type ValidateWorkflowComplianceResult = Record<string, unknown>;

export interface ValidateComplianceRecordParams {
  taskId: string;
  result: string;
  protocol?: string;
  violations?: Array<{ code: string; message: string; severity: 'error' | 'warning' }>;
}
export interface ValidateComplianceRecordResult {
  taskId: string;
  recorded: string;
  metrics: ComplianceMetrics;
}

export interface ValidateTestRunParams {
  scope?: string;
  pattern?: string;
  parallel?: boolean;
}
export interface ValidateTestRunResult {
  status: ValidateTestStatusResult;
  coverage: ValidateTestCoverageResult;
  duration: string;
  output?: string;
}

export interface ValidateComplianceSyncParams {
  force?: boolean;
}
export type ValidateComplianceSyncResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Typed operation record (Wave D adapter — T975)
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the check domain.
 *
 * Maps each operation name (as dispatched by the registry — no domain prefix)
 * to its `[Params, Result]` tuple. Used by `TypedDomainHandler<CheckOps>`
 * in the dispatch layer to provide compile-time narrowing of params.
 *
 * @task T1423 — check typed narrowing (T975 follow-on)
 */
export type CheckOps = {
  readonly schema: readonly [ValidateSchemaParams, ValidateSchemaResult];
  readonly task: readonly [ValidateTaskParams, ValidateTaskResult];
  readonly manifest: readonly [ValidateManifestParams, ValidateManifestResult];
  readonly output: readonly [ValidateOutputParams, ValidateOutputResult];
  readonly 'compliance.summary': readonly [
    ValidateComplianceSummaryParams,
    ValidateComplianceSummaryResult,
  ];
  readonly 'compliance.record': readonly [
    ValidateComplianceRecordParams,
    ValidateComplianceRecordResult,
  ];
  readonly 'compliance.sync': readonly [ValidateComplianceSyncParams, ValidateComplianceSyncResult];
  readonly test: readonly [ValidateTestStatusParams, ValidateTestStatusResult];
  readonly 'test.run': readonly [ValidateTestRunParams, ValidateTestRunResult];
  readonly 'test.coverage': readonly [ValidateTestCoverageParams, ValidateTestCoverageResult];
  readonly coherence: readonly [ValidateCoherenceParams, ValidateCoherenceResult];
  readonly 'gate.status': readonly [ValidateGateParams, ValidateGateResult];
  readonly 'gate.set': readonly [ValidateGateParams, ValidateGateResult];
  readonly 'verify.explain': readonly [ValidateVerifyExplainParams, ValidateVerifyExplainResult];
  readonly 'archive.stats': readonly [ValidateArchiveStatsParams, ValidateArchiveStatsResult];
  readonly 'chain.validate': readonly [ValidateChainParams, ValidateChainResult];
  readonly grade: readonly [ValidateGradeParams, ValidateGradeResult];
  readonly 'grade.list': readonly [ValidateGradeListParams, ValidateGradeListResult];
  readonly canon: readonly [ValidateCanonParams, ValidateCanonResult];
  readonly 'workflow.compliance': readonly [
    ValidateWorkflowComplianceParams,
    ValidateWorkflowComplianceResult,
  ];
  readonly protocol: readonly [ValidateProtocolParams, ValidateProtocolResult];
};
