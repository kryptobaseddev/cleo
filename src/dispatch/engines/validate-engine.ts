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

import { resolveProjectRoot } from '../../core/platform.js';
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
} from '../../core/validation/validate-ops.js';
import { type EngineResult, engineError } from './_error.js';

/**
 * validate.schema - JSON Schema validation
 * @task T4477
 */
export function validateSchemaOp(type: string, data?: unknown, projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreValidateSchema(type, data, root);
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
  violations?: Array<{ code: string; message: string; severity: string }>,
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
  checkConsensusManifest,
  validateConsensusTask,
} from '../../core/validation/protocols/consensus.js';
import {
  checkContributionManifest,
  validateContributionTask,
} from '../../core/validation/protocols/contribution.js';
import {
  checkDecompositionManifest,
  validateDecompositionTask,
} from '../../core/validation/protocols/decomposition.js';
import {
  checkImplementationManifest,
  validateImplementationTask,
} from '../../core/validation/protocols/implementation.js';
import {
  checkSpecificationManifest,
  validateSpecificationTask,
} from '../../core/validation/protocols/specification.js';

interface ProtocolValidationParams {
  mode: 'task' | 'manifest';
  taskId?: string;
  manifestFile?: string;
  strict?: boolean;
  votingMatrixFile?: string;
  epicId?: string;
  specFile?: string;
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
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('violations')
        ? 'E_PROTOCOL_VIOLATION'
        : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

// ============================================================================
// Gate Verification (T5327)
// ============================================================================

import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { TaskVerification, VerificationGate } from '../../types/task.js';

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
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
  };
}

function computePassed(verification: TaskVerification): boolean {
  for (const gate of DEFAULT_REQUIRED_GATES) {
    if (verification.gates[gate] !== true) return false;
  }
  return true;
}

function getMissingGates(verification: TaskVerification): VerificationGate[] {
  return DEFAULT_REQUIRED_GATES.filter((g) => verification.gates[g] !== true);
}

interface GateVerifyParams {
  taskId: string;
  gate?: string;
  value?: boolean;
  agent?: string;
  all?: boolean;
  reset?: boolean;
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
}

/**
 * check.gate.verify - View or modify verification gates for a task
 * @task T5327
 */
export async function validateGateVerify(
  params: GateVerifyParams,
  projectRoot?: string,
): Promise<EngineResult<GateVerifyResult>> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const { taskId, gate, value = true, agent, all, reset } = params;

    // Validate task ID format
    const idPattern = /^T\d{3,}$/;
    if (!idPattern.test(taskId)) {
      return engineError('E_INVALID_INPUT', `Invalid task ID format: ${taskId}`);
    }

    const accessor = await getAccessor(root);
    const data = await accessor.loadTaskFile();

    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) {
      return engineError('E_NOT_FOUND', `Task ${taskId} not found`);
    }

    // View mode (no modifications)
    if (!gate && !all && !reset) {
      const verification = task.verification ?? initVerification();
      const missing = getMissingGates(verification);
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
          requiredGates: DEFAULT_REQUIRED_GATES,
          missingGates: missing,
          action: 'view',
        },
      };
    }

    // Modification mode
    let verification = task.verification ?? initVerification();
    const now = new Date().toISOString();
    let action: GateVerifyResult['action'] = 'view';

    if (reset) {
      verification = initVerification();
      action = 'reset';
    } else if (all) {
      for (const g of DEFAULT_REQUIRED_GATES) {
        verification.gates[g] = true;
      }
      if (agent) {
        verification.lastAgent = agent as never;
      }
      verification.lastUpdated = now;
      action = 'set_all';
    } else if (gate) {
      if (!VALID_GATES.includes(gate as VerificationGate)) {
        return engineError(
          'E_INVALID_INPUT',
          `Invalid gate: ${gate}. Valid: ${VALID_GATES.join(', ')}`,
        );
      }

      verification.gates[gate as VerificationGate] = value;

      if (agent) {
        verification.lastAgent = agent as never;
      }
      verification.lastUpdated = now;

      if (!value) {
        verification.round++;
        verification.failureLog.push({
          round: verification.round,
          agent: agent ?? 'unknown',
          reason: `Gate ${gate} set to false`,
          timestamp: now,
        });
      }
      action = 'set_gate';
    }

    verification.passed = computePassed(verification);
    task.verification = verification;
    task.updatedAt = now;

    data._meta.checksum = computeChecksum(data.tasks);
    data.lastUpdated = now;

    await accessor.saveTaskFile(data);

    const missing = getMissingGates(verification);
    const result: GateVerifyResult = {
      taskId,
      title: task.title,
      status: task.status,
      type: task.type ?? 'task',
      verification,
      verificationStatus: verification.passed ? 'passed' : 'pending',
      passed: verification.passed,
      round: verification.round,
      requiredGates: DEFAULT_REQUIRED_GATES,
      missingGates: missing,
      action,
    };

    if (action === 'set_gate') {
      result.gateSet = gate;
    } else if (action === 'set_all') {
      result.gatesSet = DEFAULT_REQUIRED_GATES;
    }

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_GENERAL', message);
  }
}
