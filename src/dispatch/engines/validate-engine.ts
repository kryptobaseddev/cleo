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
  coreValidateSchema,
  coreValidateTask,
  coreValidateProtocol,
  coreValidateManifest,
  coreValidateOutput,
  coreComplianceSummary,
  coreComplianceViolations,
  coreComplianceRecord,
  coreTestStatus,
  coreCoherenceCheck,
  coreTestRun,
  coreBatchValidate,
  coreTestCoverage,
  type CoherenceIssue,
} from '../../core/validation/validate-ops.js';
import { engineError, type EngineResult } from './_error.js';

/**
 * validate.schema - JSON Schema validation
 * @task T4477
 */
export function validateSchemaOp(
  type: string,
  data?: unknown,
  projectRoot?: string
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreValidateSchema(type, data, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes('not found') ? 'E_NOT_FOUND'
      : message.includes('Unknown schema') ? 'E_INVALID_TYPE'
      : message.includes('required') ? 'E_INVALID_INPUT'
      : 'E_VALIDATION_ERROR';
    return engineError(code, message);
  }
}

/**
 * validate.task - Anti-hallucination task validation
 * @task T4477
 */
export async function validateTask(
  taskId: string,
  projectRoot?: string
): Promise<EngineResult> {
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
  projectRoot?: string
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
export function validateManifest(
  projectRoot?: string
): EngineResult {
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
  projectRoot?: string
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
export function validateComplianceSummary(
  projectRoot?: string
): EngineResult {
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
export function validateComplianceViolations(
  limit?: number,
  projectRoot?: string
): EngineResult {
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
  projectRoot?: string
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
export function validateTestStatus(
  projectRoot?: string
): EngineResult {
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
  projectRoot?: string
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
  projectRoot?: string
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
export async function validateBatchValidate(
  projectRoot?: string
): Promise<EngineResult> {
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
export function validateTestCoverage(
  projectRoot?: string
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = coreTestCoverage(root);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_FILE_ERROR', err instanceof Error ? err.message : String(err));
  }
}
