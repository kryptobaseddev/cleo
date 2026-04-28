/**
 * Validate Engine
 *
 * Thin wrapper layer around core validation operations.
 * Delegates all business logic to src/core/validation/validate-ops.ts.
 *
 * @task T4477
 * @task T4659
 * @task T4786
 * @epic T4654
 */

import {
  type CoherenceIssue,
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
  resolveProjectRoot,
} from '@cleocode/core/internal';
import { type EngineResult, engineError } from './_error.js';

/**
 * validate.schema - JSON Schema validation
 * @task T4477
 */
export async function validateSchemaOp(
  type: string,
  data?: unknown,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await coreValidateSchema(type, data, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('Unknown schema')
        ? 'E_INVALID_TYPE'
        : message.includes('required')
          ? 'E_INVALID_INPUT'
          : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * validate.task - Anti-hallucination task validation
 * @task T4477
 */
export async function validateTask(taskId: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await coreValidateTask(taskId, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}

/**
 * validate.protocol - Protocol compliance check
 * @task T4477
 */
export async function validateProtocol(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await coreValidateProtocol(taskId, protocolType, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}

/**
 * validate.manifest - Manifest entry validation
 * @task T4477
 */
export function validateManifest(projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreValidateManifest(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_FILE_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.output - Output file validation
 * @task T4477
 */
export function validateOutput(
  filePath: string,
  taskId?: string,
  projectRoot?: string,
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreValidateOutput(filePath, taskId, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
    return engineError(code, message);
  }
}

/**
 * validate.compliance.summary - Aggregated compliance metrics
 * @task T4477
 */
export function validateComplianceSummary(projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreComplianceSummary(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_FILE_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.compliance.violations - List compliance violations
 * @task T4477
 */
export function validateComplianceViolations(limit?: number, projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreComplianceViolations(limit, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_FILE_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.compliance.record - Record compliance check result
 * @task T4477
 */
export function validateComplianceRecord(
  taskId: string,
  result: string,
  protocol?: string,
  violations?: Array<{ code: string; message: string; severity: 'warning' | 'error' }>,
  projectRoot?: string,
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const data = coreComplianceRecord(taskId, result, protocol, violations, root);
    return { success: true, data };
  } catch (err: unknown) {
    return engineError('E_INVALID_INPUT', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.test.status - Test suite status
 * @task T4477
 */
export function validateTestStatus(projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreTestStatus(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_GENERAL', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.coherence-check - Cross-validate task graph for consistency
 * @task T4477
 */
export async function validateCoherenceCheck(
  projectRoot?: string,
): Promise<EngineResult<{ coherent: boolean; issues: CoherenceIssue[] }>> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await coreCoherenceCheck(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_NOT_INITIALIZED', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.test.run - Execute test suite via subprocess
 * @task T4632
 */
export function validateTestRun(
  params?: { scope?: string; pattern?: string; parallel?: boolean },
  projectRoot?: string,
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreTestRun(params, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_GENERAL', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.batch-validate - Batch validate all tasks against schema and rules
 * @task T4632
 */
export async function validateBatchValidate(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await coreBatchValidate(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_NOT_FOUND', err instanceof Error ? err.message : String(err));
  }
}

/**
 * validate.test.coverage - Coverage metrics
 * @task T4477
 */
export function validateTestCoverage(projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreTestCoverage(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_FILE_ERROR', err instanceof Error ? err.message : String(err));
  }
}

// ============================================================================
// Protocol Validation Operations (T5327)
// ============================================================================

import {
  checkArchitectureDecisionManifest,
  checkArtifactPublishManifest,
  checkConsensusManifest,
  checkContributionManifest,
  checkDecompositionManifest,
  checkImplementationManifest,
  checkProvenanceManifest,
  checkReleaseManifest,
  checkResearchManifest,
  checkSpecificationManifest,
  checkTestingManifest,
  checkValidationManifest,
  validateArchitectureDecisionTask,
  validateArtifactPublishTask,
  validateConsensusTask,
  validateContributionProtocol as validateContributionTask,
  validateDecompositionTask,
  validateImplementationTask,
  validateProvenanceTask,
  validateReleaseTask,
  validateResearchTask,
  validateSpecificationTask,
  validateTestingTask,
  validateValidationTask,
} from '@cleocode/core/internal';

interface ProtocolValidationParams {
  mode: 'task' | 'manifest';
  taskId?: string;
  manifestFile?: string;
  strict?: boolean;
  // consensus
  votingMatrixFile?: string;
  // decomposition
  epicId?: string;
  siblingCount?: number;
  descriptionClarity?: boolean;
  maxSiblings?: number;
  maxDepth?: number;
  // specification
  specFile?: string;
  // implementation / contribution
  hasTaskTags?: boolean;
  hasContributionTags?: boolean;
  // research
  hasCodeChanges?: boolean;
  // release
  version?: string;
  hasChangelog?: boolean;
  // artifact-publish
  artifactType?: string;
  buildPassed?: boolean;
  // provenance
  hasAttestation?: boolean;
  hasSbom?: boolean;
  // architecture-decision
  adrContent?: string;
  status?: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  hitlReviewed?: boolean;
  downstreamFlagged?: boolean;
  persistedInDb?: boolean;
  // validation stage
  specMatchConfirmed?: boolean;
  testSuitePassed?: boolean;
  protocolComplianceChecked?: boolean;
  // testing stage
  framework?: string;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  coveragePercent?: number;
  coverageThreshold?: number;
  ivtLoopConverged?: boolean;
  ivtLoopIterations?: number;
}

/**
 * Shared catch handler for protocol validation ops.
 *
 * @task T260
 */
function protocolCatch(err: unknown): EngineResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.includes('not found')
    ? 'E_NOT_FOUND'
    : message.includes('violations')
      ? 'E_PROTOCOL_VIOLATION'
      : 'E_VALIDATION_ERROR';
  return engineError(code, message);
}

/**
 * check.protocol.consensus - Validate consensus protocol compliance
 * @task T5327
 */
export async function validateProtocolConsensus(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, votingMatrixFile } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateConsensusTask(params.taskId, {
        strict,
        votingMatrixFile,
      });
      return { success: true, data: result };
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkConsensusManifest(params.manifestFile, {
        strict,
        votingMatrixFile,
      });
      return { success: true, data: result };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('violations')
        ? 'E_PROTOCOL_VIOLATION'
        : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * check.protocol.contribution - Validate contribution protocol compliance
 * @task T5327
 */
export async function validateProtocolContribution(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateContributionTask(params.taskId, { strict });
      return { success: true, data: result };
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkContributionManifest(params.manifestFile, { strict });
      return { success: true, data: result };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('violations')
        ? 'E_PROTOCOL_VIOLATION'
        : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * check.protocol.decomposition - Validate decomposition protocol compliance
 * @task T5327
 */
export async function validateProtocolDecomposition(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, epicId } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateDecompositionTask(params.taskId, { strict, epicId });
      return { success: true, data: result };
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkDecompositionManifest(params.manifestFile, { strict, epicId });
      return { success: true, data: result };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('violations')
        ? 'E_PROTOCOL_VIOLATION'
        : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * check.protocol.implementation - Validate implementation protocol compliance
 * @task T5327
 */
export async function validateProtocolImplementation(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateImplementationTask(params.taskId, { strict });
      return { success: true, data: result };
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkImplementationManifest(params.manifestFile, { strict });
      return { success: true, data: result };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('violations')
        ? 'E_PROTOCOL_VIOLATION'
        : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * check.protocol.specification - Validate specification protocol compliance
 * @task T5327
 */
export async function validateProtocolSpecification(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, specFile } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateSpecificationTask(params.taskId, { strict, specFile });
      return { success: true, data: result };
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkSpecificationManifest(params.manifestFile, { strict, specFile });
      return { success: true, data: result };
    }
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.research - Validate research protocol compliance
 * @task T260
 */
export async function validateProtocolResearch(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, hasCodeChanges } = params;
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateResearchTask(params.taskId, { strict, hasCodeChanges });
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkResearchManifest(params.manifestFile, { strict, hasCodeChanges });
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.architecture-decision - Validate ADR protocol compliance
 * @task T260
 */
export async function validateProtocolArchitectureDecision(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, adrContent, status, hitlReviewed, downstreamFlagged, persistedInDb } =
      params;
    const adrOpts = { strict, adrContent, status, hitlReviewed, downstreamFlagged, persistedInDb };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateArchitectureDecisionTask(params.taskId, adrOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkArchitectureDecisionManifest(params.manifestFile, adrOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.validation - Validate validation-stage protocol compliance
 * @task T260
 */
export async function validateProtocolValidation(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, specMatchConfirmed, testSuitePassed, protocolComplianceChecked } = params;
    const validationOpts = {
      strict,
      specMatchConfirmed,
      testSuitePassed,
      protocolComplianceChecked,
    };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateValidationTask(params.taskId, validationOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkValidationManifest(params.manifestFile, validationOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.testing - Validate testing-stage protocol compliance (IVT loop)
 * @task T260
 */
export async function validateProtocolTesting(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const {
      mode,
      strict,
      framework,
      testsRun,
      testsPassed,
      testsFailed,
      coveragePercent,
      coverageThreshold,
      ivtLoopConverged,
      ivtLoopIterations,
    } = params;
    const testingOpts = {
      strict,
      framework: framework as
        | 'vitest'
        | 'jest'
        | 'mocha'
        | 'pytest'
        | 'unittest'
        | 'go-test'
        | 'cargo-test'
        | 'rspec'
        | 'phpunit'
        | 'bats'
        | 'other'
        | undefined,
      testsRun,
      testsPassed,
      testsFailed,
      coveragePercent,
      coverageThreshold,
      ivtLoopConverged,
      ivtLoopIterations,
    };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateTestingTask(params.taskId, testingOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkTestingManifest(params.manifestFile, testingOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.release - Validate release protocol compliance
 * @task T260
 */
export async function validateProtocolRelease(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, version, hasChangelog } = params;
    const releaseOpts = { strict, version, hasChangelog };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateReleaseTask(params.taskId, releaseOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkReleaseManifest(params.manifestFile, releaseOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.artifact-publish - Validate artifact-publish protocol compliance
 * @task T260
 */
export async function validateProtocolArtifactPublish(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, artifactType, buildPassed } = params;
    const artifactOpts = { strict, artifactType, buildPassed };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateArtifactPublishTask(params.taskId, artifactOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkArtifactPublishManifest(params.manifestFile, artifactOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.provenance - Validate provenance protocol compliance
 * @task T260
 */
export async function validateProtocolProvenance(
  params: ProtocolValidationParams,
  _projectRoot?: string,
): Promise<EngineResult> {
  try {
    const { mode, strict, hasAttestation, hasSbom } = params;
    const provenanceOpts = { strict, hasAttestation, hasSbom };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateProvenanceTask(params.taskId, provenanceOpts);
      return { success: true, data: result };
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkProvenanceManifest(params.manifestFile, provenanceOpts);
    return { success: true, data: result };
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

// ============================================================================
// Gate Verification (T5327 + T832/ADR-051)
// ============================================================================

import type {
  EvidenceAtom,
  GateEvidence,
  TaskVerification,
  VerificationGate,
} from '@cleocode/contracts';
import {
  appendForceBypassLine,
  appendGateAuditLine,
  checkAndIncrementOverrideCap,
  checkGateEvidenceMinimum,
  composeGateEvidence,
  enforceSharedEvidence,
  getAccessor,
  parseEvidence,
  validateAtom,
} from '@cleocode/core/internal';

const VALID_GATES: VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
];

const DEFAULT_REQUIRED_GATES: VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'securityPassed',
  'documented',
];

function initVerification(): TaskVerification {
  return {
    passed: false,
    round: 0,
    gates: {},
    evidence: {},
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
  };
}

/**
 * Evaluate CLEO_OWNER_OVERRIDE environment and return the override state +
 * reason. Documented in ADR-051 §7.4.
 *
 * T1118 L4b: If CLEO_AGENT_ROLE is a restricted role (worker|lead|subagent),
 * override is silently rejected here even if the env var is set. This prevents
 * agents from using CLEO_OWNER_OVERRIDE to bypass evidence gates.
 *
 * @task T832
 * @task T1118
 */
function readOverrideState(): { override: boolean; reason: string } {
  const raw = process.env['CLEO_OWNER_OVERRIDE'];
  const override = raw === '1' || raw === 'true';
  const reason = (process.env['CLEO_OWNER_OVERRIDE_REASON'] ?? '').trim() || 'unspecified';

  // T1118 L4b — reject override for restricted agent roles.
  if (override) {
    const role = process.env['CLEO_AGENT_ROLE'];
    const forbiddenRoles = new Set(['worker', 'lead', 'subagent']);
    if (role && forbiddenRoles.has(role)) {
      // Silently downgrade — the agent cannot use override.
      return { override: false, reason: 'E_OVERRIDE_FORBIDDEN_AGENT_ROLE' };
    }
  }

  return { override, reason };
}

function computePassed(
  verification: TaskVerification,
  requiredGates: VerificationGate[] = DEFAULT_REQUIRED_GATES,
): boolean {
  for (const gate of requiredGates) {
    if (verification.gates[gate] !== true) return false;
  }
  return true;
}

function getMissingGates(
  verification: TaskVerification,
  requiredGates: VerificationGate[] = DEFAULT_REQUIRED_GATES,
): VerificationGate[] {
  return requiredGates.filter((g) => verification.gates[g] !== true);
}

/** Load required gates from project config, falling back to hardcoded defaults. */
async function loadRequiredGates(projectRoot: string): Promise<VerificationGate[]> {
  try {
    const { loadConfig } = await import('@cleocode/core/internal');
    const config = await loadConfig(projectRoot);
    const cfgGates = config.verification?.requiredGates;
    if (Array.isArray(cfgGates) && cfgGates.length > 0) {
      return cfgGates.filter((g): g is VerificationGate =>
        DEFAULT_REQUIRED_GATES.includes(g as VerificationGate),
      );
    }
  } catch {
    // fallback
  }
  return [...DEFAULT_REQUIRED_GATES];
}

interface GateVerifyParams {
  taskId: string;
  gate?: string;
  value?: boolean;
  agent?: string;
  all?: boolean;
  reset?: boolean;
  /**
   * Raw evidence string from CLI `--evidence` flag (T832 / ADR-051).
   * Required for all write operations except `reset` and `value=false`.
   */
  evidence?: string;
  /** Session ID for audit trail (T832 / ADR-051 §6.1). */
  sessionId?: string;
  /**
   * Acknowledge that the same evidence atom is being applied to >3 distinct
   * tasks in this session (T1502 / P0-6).  Without this flag, such reuse
   * triggers a warning (or a hard reject in strict mode).
   */
  sharedEvidence?: boolean;
}

interface GateVerifyResult {
  taskId: string;
  title?: string;
  status?: string;
  type?: string;
  verification: TaskVerification;
  verificationStatus: 'passed' | 'pending';
  passed: boolean;
  round: number;
  requiredGates: VerificationGate[];
  missingGates: VerificationGate[];
  action?: 'view' | 'set_gate' | 'set_all' | 'reset';
  gateSet?: string;
  gatesSet?: VerificationGate[];
  /** Evidence atoms validated and persisted for this write (T832). */
  evidenceStored?: EvidenceAtom[];
  /** True when CLEO_OWNER_OVERRIDE bypassed evidence validation (T832). */
  override?: boolean;
  /**
   * Actionable next-step hint emitted when all required gates become green
   * after a write (policy-b: verify never auto-completes, explicit complete
   * is always required).  Absent on view mode and when gates are still missing.
   * Fixes GH #94 / T919.
   */
  hint?: string;
}

/**
 * check.gate.verify — View or modify verification gates for a task.
 *
 * As of v2026.4.78 (T832 / ADR-051), every gate write MUST be accompanied
 * by structured evidence validated against git, the filesystem, and the
 * toolchain.  `reset` mode requires no evidence. `value=false` (gate fail)
 * requires no evidence since failures do not need proof.
 *
 * @task T5327
 * @task T832
 * @adr ADR-051
 */
export async function validateGateVerify(
  params: GateVerifyParams,
  projectRoot?: string,
): Promise<EngineResult<GateVerifyResult>> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const { taskId, gate, value = true, agent, all, reset } = params;
    const agentId = agent ?? 'unknown';
    const sessionId = params.sessionId ?? null;

    // Validate task ID format
    const idPattern = /^T\d{3,}$/;
    if (!idPattern.test(taskId)) {
      return engineError('E_INVALID_INPUT', `Invalid task ID format: ${taskId}`);
    }

    const accessor = await getAccessor(root);
    const task = await accessor.loadSingleTask(taskId);
    if (!task) {
      return engineError('E_NOT_FOUND', `Task ${taskId} not found`);
    }

    // Completed tasks are immutable w.r.t. verification (ADR-051 §11.1).
    // View + reset remain available; evidence writes are rejected.
    if (task.status === 'done' && (gate || all) && value !== false) {
      return engineError(
        'E_ALREADY_DONE',
        `Task ${taskId} is already done — verification evidence cannot be added to completed tasks (ADR-051 §11.1)`,
      );
    }

    const configGates = await loadRequiredGates(root);

    // View mode (no modifications)
    if (!gate && !all && !reset) {
      const verification = task.verification ?? initVerification();
      const missing = getMissingGates(verification, configGates);
      return {
        success: true,
        data: {
          taskId,
          title: task.title,
          status: task.status,
          type: task.type ?? 'task',
          verification,
          verificationStatus: verification.passed ? 'passed' : 'pending',
          passed: verification.passed,
          round: verification.round,
          requiredGates: configGates,
          missingGates: missing,
          action: 'view',
        },
      };
    }

    // Check if evidence-based requirement applies.  gate failures
    // (value=false) and resets do NOT require evidence.
    const isWriteRequiringEvidence = (all || (gate && value !== false)) && !reset;
    const override = readOverrideState();

    // T1501 / P0-5 — per-session CLEO_OWNER_OVERRIDE cap.
    // Enforce before the write proceeds so the error surfaces early.
    let sessionOverrideOrdinal: number | undefined;
    // T1504 — track worktree-context exemption so it can be logged in the bypass record.
    let isWorktreeCtx = false;
    if (override.override && isWriteRequiringEvidence) {
      const command = (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512);
      const capResult = checkAndIncrementOverrideCap(
        root,
        sessionId ?? 'global',
        undefined,
        command,
      );
      if (!capResult.allowed) {
        return engineError(
          capResult.errorCode ?? 'E_OVERRIDE_CAP_EXCEEDED',
          capResult.errorMessage ?? 'Per-session override cap exceeded.',
        );
      }
      sessionOverrideOrdinal = capResult.sessionOverrideOrdinal;
      isWorktreeCtx = capResult.workTreeContext === true;
    }

    // T1502 / P0-6 — shared-evidence detection.
    let sharedEvidenceAcknowledged = false;
    let sharedAtomWarned = false;
    if (isWriteRequiringEvidence && !override.override && params.evidence && sessionId) {
      const seResult = enforceSharedEvidence(
        root,
        sessionId,
        taskId,
        params.evidence,
        params.sharedEvidence === true,
      );
      if (!seResult.allowed) {
        return engineError(
          seResult.errorCode ?? 'E_SHARED_EVIDENCE_FLAG_REQUIRED',
          seResult.errorMessage ?? 'Shared evidence flag required.',
        );
      }
      sharedEvidenceAcknowledged = seResult.acknowledged === true;
      sharedAtomWarned = seResult.warned === true;
    }

    // Modification mode
    let verification = task.verification ?? initVerification();
    if (!verification.evidence) {
      verification.evidence = {};
    }
    const now = new Date().toISOString();
    let action: GateVerifyResult['action'] = 'view';
    const evidenceStored: EvidenceAtom[] = [];

    if (reset) {
      verification = initVerification();
      action = 'reset';
    } else if (isWriteRequiringEvidence) {
      // Determine target gates.
      const targets: VerificationGate[] = all ? configGates : [gate as VerificationGate];

      if (!all && !VALID_GATES.includes(gate as VerificationGate)) {
        return engineError(
          'E_INVALID_INPUT',
          `Invalid gate: ${gate}. Valid: ${VALID_GATES.join(', ')}`,
        );
      }

      // Parse evidence if provided.
      let validatedAtoms: EvidenceAtom[] = [];
      if (override.override) {
        // Override — no evidence required.
        validatedAtoms = [{ kind: 'override', reason: override.reason }];
      } else {
        if (!params.evidence) {
          return engineError(
            'E_EVIDENCE_MISSING',
            `Evidence is required. See ADR-051.\n` +
              `Example: cleo verify ${taskId} --gate implemented --evidence commit:<sha>;files:<path>\n` +
              `Or set CLEO_OWNER_OVERRIDE=1 with CLEO_OWNER_OVERRIDE_REASON=<reason> for emergency bypass (audited).`,
          );
        }

        let parsed: ReturnType<typeof parseEvidence>;
        try {
          parsed = parseEvidence(params.evidence);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return engineError('E_EVIDENCE_INVALID', message);
        }

        for (const atom of parsed.atoms) {
          const check = await validateAtom(atom, root);
          if (!check.ok) {
            return engineError(check.codeName, check.reason);
          }
          validatedAtoms.push(check.atom);
        }

        // Check each target gate satisfies its minimum.
        for (const targetGate of targets) {
          const missing = checkGateEvidenceMinimum(targetGate, validatedAtoms);
          if (missing) {
            return engineError('E_EVIDENCE_INSUFFICIENT', missing);
          }
        }
      }

      evidenceStored.push(...validatedAtoms);
      const evidence: GateEvidence = composeGateEvidence(
        validatedAtoms,
        agentId,
        override.override || undefined,
        override.override ? override.reason : undefined,
      );

      for (const targetGate of targets) {
        verification.gates[targetGate] = true;
        verification.evidence![targetGate] = evidence;
      }

      verification.lastAgent = agent as never;
      verification.lastUpdated = now;
      action = all ? 'set_all' : 'set_gate';
    } else if (gate) {
      // Gate failure — no evidence required (failures do not need proof).
      if (!VALID_GATES.includes(gate as VerificationGate)) {
        return engineError(
          'E_INVALID_INPUT',
          `Invalid gate: ${gate}. Valid: ${VALID_GATES.join(', ')}`,
        );
      }

      verification.gates[gate as VerificationGate] = false;

      if (agent) {
        verification.lastAgent = agent as never;
      }
      verification.lastUpdated = now;

      verification.round++;
      verification.failureLog.push({
        round: verification.round,
        agent: agentId,
        reason: `Gate ${gate} set to false`,
        timestamp: now,
      });
      action = 'set_gate';
    }

    verification.passed = computePassed(verification, configGates);
    task.verification = verification;
    task.updatedAt = now;

    await accessor.upsertSingleTask(task);

    // Emit audit line for every non-view action.  Best-effort: audit write
    // failures are logged but do not block the operation.
    if (action && action !== 'view') {
      const auditRecord = {
        timestamp: now,
        taskId,
        gate: all ? '*all*' : (gate ?? ''),
        action: (action === 'set_gate' ? 'set' : action === 'set_all' ? 'all' : 'reset') as
          | 'set'
          | 'all'
          | 'reset',
        evidence:
          evidenceStored.length > 0
            ? composeGateEvidence(
                evidenceStored,
                agentId,
                override.override || undefined,
                override.override ? override.reason : undefined,
              )
            : undefined,
        agent: agentId,
        sessionId,
        passed: verification.passed,
        override: override.override,
      };

      try {
        await appendGateAuditLine(root, auditRecord);
        if (override.override && action !== 'reset') {
          // T1501: include sessionOverrideOrdinal in the force-bypass record.
          // T1504: include workTreeContext when the override was exempt from the cap counter.
          await appendForceBypassLine(root, {
            ...auditRecord,
            overrideReason: override.reason,
            pid: process.pid,
            command: (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512),
            ...(sessionOverrideOrdinal !== undefined ? { sessionOverrideOrdinal } : {}),
            ...(isWorktreeCtx ? { workTreeContext: true } : {}),
          });
        } else if ((sharedEvidenceAcknowledged || sharedAtomWarned) && action !== 'reset') {
          // T1502: log shared-evidence state even on non-override writes.
          await appendForceBypassLine(root, {
            ...auditRecord,
            overrideReason: 'shared-evidence',
            pid: process.pid,
            command: (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512),
            ...(sharedEvidenceAcknowledged ? { sharedEvidence: true } : {}),
            ...(sharedAtomWarned ? { sharedAtomWarning: true } : {}),
          });
        }
      } catch {
        // Audit failure must not block the operation — silent fallback.
      }
    }

    const missing = getMissingGates(verification, configGates);
    const result: GateVerifyResult = {
      taskId,
      title: task.title,
      status: task.status,
      type: task.type ?? 'task',
      verification,
      verificationStatus: verification.passed ? 'passed' : 'pending',
      passed: verification.passed,
      round: verification.round,
      requiredGates: configGates,
      missingGates: missing,
      action,
    };

    if (action === 'set_gate') {
      result.gateSet = gate;
    } else if (action === 'set_all') {
      result.gatesSet = configGates;
    }

    if (evidenceStored.length > 0) {
      result.evidenceStored = evidenceStored;
      result.override = override.override;
    }

    // GH #94 / T919 — policy (b): verify NEVER auto-completes.
    // When the final gate write drives verification.passed to true, emit a
    // clear next-step hint so agents and users know they must explicitly run
    // `cleo complete`.  Only emitted on write actions (not view/reset) when
    // all required gates are green.
    if (
      (action === 'set_gate' || action === 'set_all') &&
      verification.passed === true &&
      missing.length === 0
    ) {
      result.hint = `All gates green. Run: cleo complete ${taskId}`;
    }

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_GENERAL', message);
  }
}
