/**
 * Check Domain Handler (Dispatch Layer)
 *
 * Consolidates validate domain operations into the canonical "check"
 * domain. Handles schema validation, protocol compliance, task validation,
 * manifest checks, output validation, compliance tracking, test operations,
 * and coherence checks.
 *
 * All operations delegate to native engine functions from validate-engine.
 *
 * Uses typed-handler pattern (Wave D · T975) for compile-time param narrowing.
 * Zero `as any`/`as unknown as X` casts for param extraction (T1423).
 *
 * @epic T4820
 * @task T1423 — typed narrowing for check domain
 */

import type {
  CheckOps,
  ValidateArchiveStatsParams,
  ValidateCanonParams,
  ValidateChainParams,
  ValidateCoherenceParams,
  ValidateComplianceRecordParams,
  ValidateComplianceSummaryParams,
  ValidateComplianceSyncParams,
  ValidateGateParams,
  ValidateGradeListParams,
  ValidateGradeParams,
  ValidateManifestParams,
  ValidateOutputParams,
  ValidateProtocolParams,
  ValidateSchemaParams,
  ValidateTaskParams,
  ValidateTestRunParams,
  ValidateTestStatusParams,
  ValidateVerifyExplainParams,
  ValidateWorkflowComplianceParams,
} from '@cleocode/contracts';
import {
  checkArchiveStats,
  checkCoherence,
  checkComplianceRecord,
  checkComplianceSummary,
  checkComplianceSync,
  checkExplainVerification,
  checkGradeSession,
  checkReadGrades,
  checkTestCoverage,
  checkTestRun,
  checkTestStatus,
  checkValidateChain,
  checkValidateManifest,
  checkValidateOutput,
  checkValidateProtocol,
  checkValidateSchema,
  checkValidateTask,
  checkWorkflowCompliance,
  getLogger,
  getProjectRoot,
  validateGateVerify,
  validateProtocolArchitectureDecision,
  validateProtocolArtifactPublish,
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolProvenance,
  validateProtocolRelease,
  validateProtocolResearch,
  validateProtocolSpecification,
  validateProtocolTesting,
  validateProtocolValidation,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1423)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _checkTypedHandler = defineTypedHandler<CheckOps>('check', {
  // -----------------------------------------------------------------------
  // Query ops
  // -----------------------------------------------------------------------

  schema: async (params: ValidateSchemaParams) => {
    const projectRoot = getProjectRoot();
    if (!params.type) {
      return lafsError('E_INVALID_INPUT', 'type is required', 'schema');
    }
    try {
      const result = await checkValidateSchema(projectRoot, params);
      return lafsSuccess(result, 'schema');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('not found')
        ? 'E_NOT_FOUND'
        : message.includes('Unknown schema')
          ? 'E_INVALID_TYPE'
          : message.includes('required')
            ? 'E_INVALID_INPUT'
            : 'E_VALIDATION_ERROR';
      return lafsError(code, message, 'schema');
    }
  },

  task: async (params: ValidateTaskParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'task');
    }
    try {
      const result = await checkValidateTask(projectRoot, params);
      return lafsSuccess(result, 'task');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
      return lafsError(code, message, 'task');
    }
  },

  manifest: async (params: ValidateManifestParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = checkValidateManifest(projectRoot, params);
      return lafsSuccess(result, 'manifest');
    } catch (err) {
      return lafsError(
        'E_FILE_ERROR',
        err instanceof Error ? err.message : String(err),
        'manifest',
      );
    }
  },

  output: async (params: ValidateOutputParams) => {
    const projectRoot = getProjectRoot();
    if (!params.filePath) {
      return lafsError('E_INVALID_INPUT', 'filePath is required', 'output');
    }
    try {
      const result = checkValidateOutput(projectRoot, params);
      return lafsSuccess(result, 'output');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
      return lafsError(code, message, 'output');
    }
  },

  'compliance.summary': async (params: ValidateComplianceSummaryParams) => {
    const projectRoot = getProjectRoot();
    try {
      const summary = checkComplianceSummary(projectRoot, params);
      // Include the requested view type so callers can differentiate
      // trend/skills/value/audit/summary responses
      const enrichedData = {
        ...summary,
        view: params.type ?? 'summary',
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.days ? { days: params.days } : {}),
        ...(params.global ? { global: params.global } : {}),
      };
      return lafsSuccess(enrichedData, 'compliance.summary');
    } catch (err) {
      return lafsError(
        'E_FILE_ERROR',
        err instanceof Error ? err.message : String(err),
        'compliance.summary',
      );
    }
  },

  test: async (params: ValidateTestStatusParams) => {
    const projectRoot = getProjectRoot();

    if (params?.format === 'coverage') {
      try {
        const result = checkTestCoverage(projectRoot, {});
        return lafsSuccess(result, 'test');
      } catch (err) {
        return lafsError('E_FILE_ERROR', err instanceof Error ? err.message : String(err), 'test');
      }
    }

    // Default to status
    try {
      const result = checkTestStatus(projectRoot, params);
      return lafsSuccess(result, 'test');
    } catch (err) {
      return lafsError('E_GENERAL', err instanceof Error ? err.message : String(err), 'test');
    }
  },

  coherence: async (params: ValidateCoherenceParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = await checkCoherence(projectRoot, params);
      return lafsSuccess(result, 'coherence');
    } catch (err) {
      return lafsError(
        'E_NOT_INITIALIZED',
        err instanceof Error ? err.message : String(err),
        'coherence',
      );
    }
  },

  protocol: async (params: ValidateProtocolParams) => {
    const projectRoot = getProjectRoot();
    const protocolType = params.protocolType;
    const mode = params.mode ?? 'task';

    // Common protocol parameters
    const protocolParams = {
      mode,
      taskId: params.taskId,
      manifestFile: params.manifestFile,
      strict: params.strict,
    };

    // Dispatch to specific protocol validators
    switch (protocolType) {
      case 'consensus': {
        const result = await validateProtocolConsensus(projectRoot, {
          ...protocolParams,
          votingMatrixFile: params.votingMatrixFile,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'contribution': {
        const result = await validateProtocolContribution(projectRoot, protocolParams);
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'decomposition': {
        const result = await validateProtocolDecomposition(projectRoot, {
          ...protocolParams,
          epicId: params.epicId,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'implementation': {
        const result = await validateProtocolImplementation(projectRoot, protocolParams);
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'specification': {
        const result = await validateProtocolSpecification(projectRoot, {
          ...protocolParams,
          specFile: params.specFile,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'research': {
        const result = await validateProtocolResearch(projectRoot, {
          ...protocolParams,
          hasCodeChanges: params.hasCodeChanges,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'architecture-decision':
      case 'architecture_decision': {
        const result = await validateProtocolArchitectureDecision(projectRoot, {
          ...protocolParams,
          adrContent: params.adrContent,
          status: params.status,
          hitlReviewed: params.hitlReviewed,
          downstreamFlagged: params.downstreamFlagged,
          persistedInDb: params.persistedInDb,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'validation': {
        const result = await validateProtocolValidation(projectRoot, {
          ...protocolParams,
          specMatchConfirmed: params.specMatchConfirmed,
          testSuitePassed: params.testSuitePassed,
          protocolComplianceChecked: params.protocolComplianceChecked,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'testing': {
        const result = await validateProtocolTesting(projectRoot, {
          ...protocolParams,
          framework: params.framework,
          testsRun: params.testsRun,
          testsPassed: params.testsPassed,
          testsFailed: params.testsFailed,
          coveragePercent: params.coveragePercent,
          coverageThreshold: params.coverageThreshold,
          ivtLoopConverged: params.ivtLoopConverged,
          ivtLoopIterations: params.ivtLoopIterations,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'release': {
        const result = await validateProtocolRelease(projectRoot, {
          ...protocolParams,
          version: params.version,
          hasChangelog: params.hasChangelog,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'artifact-publish':
      case 'artifact_publish': {
        const result = await validateProtocolArtifactPublish(projectRoot, {
          ...protocolParams,
          artifactType: params.artifactType,
          buildPassed: params.buildPassed,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      case 'provenance': {
        const result = await validateProtocolProvenance(projectRoot, {
          ...protocolParams,
          hasAttestation: params.hasAttestation,
          hasSbom: params.hasSbom,
        });
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
      default: {
        // Generic protocol validation (legacy behavior)
        if (!params.taskId) {
          return lafsError(
            'E_INVALID_INPUT',
            'taskId is required for generic protocol check',
            'protocol',
          );
        }
        try {
          const result = await checkValidateProtocol(projectRoot, params);
          return lafsSuccess(result, 'protocol');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_INPUT';
          return lafsError(code, message, 'protocol');
        }
      }
    }
  },

  'gate.status': async (params: ValidateGateParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'gate.status');
    }
    // Read-only access
    const result = await validateGateVerify(projectRoot, { taskId: params.taskId });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'gate.status',
      );
    }
    return lafsSuccess(
      result.data ?? { taskId: params.taskId, gates: {}, passed: false },
      'gate.status',
    );
  },

  'verify.explain': async (params: ValidateVerifyExplainParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'verify.explain');
    }

    // Reuse gate.status read-only view for the raw data
    const raw = await validateGateVerify(projectRoot, { taskId: params.taskId });
    if (!raw.success) {
      return lafsError(
        String(raw.error?.code ?? 'E_INTERNAL'),
        raw.error?.message ?? 'Unknown error',
        'verify.explain',
      );
    }

    // Delegate all explain rendering to Core (ADR-057 D3 — CLI is thin transport).
    const result = await checkExplainVerification(
      raw.data as Parameters<typeof checkExplainVerification>[0],
      projectRoot,
      params.taskId,
    );
    return lafsSuccess(result, 'verify.explain');
  },

  'archive.stats': async (params: ValidateArchiveStatsParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = await checkArchiveStats(projectRoot, params);
      return lafsSuccess(result, 'archive.stats');
    } catch (err) {
      return lafsError(
        'E_NOT_INITIALIZED',
        err instanceof Error ? err.message : String(err),
        'archive.stats',
      );
    }
  },

  'chain.validate': async (params: ValidateChainParams) => {
    if (!params.chain) {
      return lafsError('E_INVALID_INPUT', 'chain is required', 'chain.validate');
    }
    // chain.validate is a pure-function check (no project state); pass empty
    // projectRoot string to satisfy the normalized (projectRoot, params) shape.
    const chainResult = checkValidateChain('', params);
    return lafsSuccess(chainResult, 'chain.validate');
  },

  grade: async (params: ValidateGradeParams) => {
    const projectRoot = getProjectRoot();
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId required', 'grade');
    }
    try {
      const gradeResult = await checkGradeSession(projectRoot, params);
      return lafsSuccess(gradeResult, 'grade');
    } catch (err) {
      return lafsError('E_NOT_FOUND', err instanceof Error ? err.message : String(err), 'grade');
    }
  },

  'grade.list': async (params: ValidateGradeListParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = await checkReadGrades(projectRoot, params);
      return lafsSuccess(result, 'grade.list');
    } catch (err) {
      return lafsError(
        'E_NOT_FOUND',
        err instanceof Error ? err.message : String(err),
        'grade.list',
      );
    }
  },

  canon: async (_params: ValidateCanonParams) => {
    const projectRoot = getProjectRoot();
    const { runCanonCheck } = await import('./check/canon.js');
    const result = runCanonCheck({ projectRoot });
    return lafsSuccess(result, 'canon');
  },

  'workflow.compliance': async (params: ValidateWorkflowComplianceParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = await checkWorkflowCompliance(projectRoot, params);
      return lafsSuccess(result, 'workflow.compliance');
    } catch (err) {
      return lafsError(
        'E_GENERAL',
        err instanceof Error ? err.message : String(err),
        'workflow.compliance',
      );
    }
  },

  // -----------------------------------------------------------------------
  // Mutate ops
  // -----------------------------------------------------------------------

  'compliance.record': async (params: ValidateComplianceRecordParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId || !params.result) {
      return lafsError('E_INVALID_INPUT', 'taskId and result are required', 'compliance.record');
    }
    try {
      const result = checkComplianceRecord(projectRoot, params);
      return lafsSuccess(result, 'compliance.record');
    } catch (err) {
      return lafsError(
        'E_INVALID_INPUT',
        err instanceof Error ? err.message : String(err),
        'compliance.record',
      );
    }
  },

  'test.run': async (params: ValidateTestRunParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = checkTestRun(projectRoot, params);
      return lafsSuccess(result, 'test.run');
    } catch (err) {
      return lafsError('E_GENERAL', err instanceof Error ? err.message : String(err), 'test.run');
    }
  },

  'test.coverage': async (params) => {
    // T1434: surface the dedicated test.coverage typed op declared in
    // CheckOps. The legacy `test` op routes by `params.format === 'coverage'`
    // and remains for backward compat with existing CLI surface; new typed
    // callers SHOULD prefer `test.coverage` which targets checkTestCoverage
    // directly.
    const projectRoot = getProjectRoot();
    try {
      const result = checkTestCoverage(projectRoot, params ?? {});
      return lafsSuccess(result, 'test.coverage');
    } catch (err) {
      return lafsError(
        'E_FILE_ERROR',
        err instanceof Error ? err.message : String(err),
        'test.coverage',
      );
    }
  },

  'compliance.sync': async (params: ValidateComplianceSyncParams) => {
    const projectRoot = getProjectRoot();
    try {
      const result = await checkComplianceSync(projectRoot, params);
      return lafsSuccess(result, 'compliance.sync');
    } catch (err) {
      return lafsError(
        'E_GENERAL',
        err instanceof Error ? err.message : String(err),
        'compliance.sync',
      );
    }
  },

  'gate.set': async (params: ValidateGateParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'gate.set');
    }
    const gateParams = {
      taskId: params.taskId,
      gate: params.gate,
      value: params.value,
      agent: params.agent,
      all: params.all,
      reset: params.reset,
      evidence: params.evidence,
      sessionId: params.sessionId,
      sharedEvidence: params.sharedEvidence,
    };
    const result = await validateGateVerify(projectRoot, gateParams);
    // T994: Track memory usage on gate verification (fire-and-forget; must not block).
    setImmediate(async () => {
      try {
        const { trackMemoryUsage } = await import('@cleocode/core/internal');
        await trackMemoryUsage(projectRoot, params.taskId!, true, params.taskId!, 'verified');
      } catch {
        // Quality tracking errors must never surface to the verify flow
      }
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'gate.set',
      );
    }
    return lafsSuccess(
      result.data ?? { taskId: params.taskId, gates: {}, passed: false },
      'gate.set',
    );
  },
});

// ---------------------------------------------------------------------------
// CheckHandler
// ---------------------------------------------------------------------------

/**
 * Legacy DomainHandler wrapper for the typed check handler.
 *
 * Delegates to the typed handler via `typedDispatch`, which performs the
 * single trust-boundary cast from `Record<string, unknown>` to the narrowed
 * `CheckOps[op][0]` type. This allows the registry to see the canonical
 * query/mutate interface while per-op code is type-safe.
 *
 * @task T975 — Wave D typed-dispatch migration
 * @task T1423 — check domain typed narrowing
 */
export class CheckHandler implements DomainHandler {
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      const envelope = await typedDispatch(
        _checkTypedHandler,
        operation as keyof CheckOps & string,
        params ?? {},
      );
      // T1434: normalize the LAFS error shape (`code: string | number`)
      // to the DispatchError shape (`code: string`).
      return {
        meta: dispatchMeta('query', 'check', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'query', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'check', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      const envelope = await typedDispatch(
        _checkTypedHandler,
        operation as keyof CheckOps & string,
        params ?? {},
      );
      // T1434: normalize the LAFS error shape (`code: string | number`)
      // to the DispatchError shape (`code: string`).
      return {
        meta: dispatchMeta('mutate', 'check', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'mutate', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'check', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'schema',
        'protocol',
        'task',
        'manifest',
        'output',
        'compliance.summary',
        'workflow.compliance',
        'test',
        'test.coverage',
        'coherence',
        'gate.status',
        'archive.stats',
        'grade',
        'grade.list',
        'chain.validate',
        'canon',
        'verify.explain',
      ],
      mutate: ['compliance.record', 'compliance.sync', 'test.run', 'gate.set'],
    };
  }
}
