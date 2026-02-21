/**
 * Validate Domain Operations (11 operations)
 *
 * Query operations: 9
 * Mutate operations: 2
 */

/**
 * Common validation types
 */
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

/**
 * Query Operations
 */

// validate.schema
export interface ValidateSchemaParams {
  fileType: 'todo' | 'config' | 'archive' | 'log' | 'manifest';
  filePath?: string;
}
export interface ValidateSchemaResult {
  valid: boolean;
  schemaVersion: string;
  violations: ValidationViolation[];
}

// validate.protocol
export interface ValidateProtocolParams {
  taskId: string;
  protocolType: 'research' | 'consensus' | 'specification' | 'decomposition' | 'implementation' | 'contribution' | 'release';
}
export interface ValidateProtocolResult {
  taskId: string;
  protocol: string;
  passed: boolean;
  score: number;
  violations: ValidationViolation[];
  requirements: {
    total: number;
    met: number;
    failed: number;
  };
}

// validate.task
export interface ValidateTaskParams {
  taskId: string;
  checkMode: 'basic' | 'strict' | 'anti-hallucination';
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

// validate.manifest
export interface ValidateManifestParams {
  entry?: string;
  taskId?: string;
}
export interface ValidateManifestResult {
  valid: boolean;
  entry: {
    id: string;
    file: string;
    exists: boolean;
  };
  violations: ValidationViolation[];
}

// validate.output
export interface ValidateOutputParams {
  taskId: string;
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

// validate.compliance.summary
export interface ValidateComplianceSummaryParams {
  scope?: string;
  since?: string;
}
export type ValidateComplianceSummaryResult = ComplianceMetrics;

// validate.compliance.violations
export interface ValidateComplianceViolationsParams {
  severity?: ValidationSeverity;
  protocol?: string;
}
export interface ValidateComplianceViolationsResult {
  violations: Array<ValidationViolation & {
    taskId: string;
    protocol: string;
    timestamp: string;
  }>;
  total: number;
}

// validate.test.status
export interface ValidateTestStatusParams {
  taskId?: string;
}
export interface ValidateTestStatusResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  byTask?: Record<string, { passed: number; failed: number }>;
}

// validate.test.coverage
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

/**
 * Mutate Operations
 */

// validate.compliance.record
export interface ValidateComplianceRecordParams {
  taskId: string;
  result: ValidateProtocolResult;
}
export interface ValidateComplianceRecordResult {
  taskId: string;
  recorded: string;
  metrics: ComplianceMetrics;
}

// validate.test.run
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
