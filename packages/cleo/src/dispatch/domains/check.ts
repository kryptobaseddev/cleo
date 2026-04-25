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
  EvidenceAtom,
  GateEvidence,
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
  getLogger,
  getProjectRoot,
  getWorkflowComplianceReport,
  paginate,
  revalidateEvidence,
  validateChain,
} from '@cleocode/core/internal';
import { defineTypedHandler, lafsError, lafsSuccess, typedDispatch } from '../adapters/typed.js';
import {
  systemArchiveStats,
  validateCoherenceCheck,
  validateComplianceRecord,
  validateComplianceSummary,
  validateComplianceViolations,
  validateGateVerify,
  validateManifestOp,
  validateOutput,
  validateProtocol,
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
  validateSchemaOp,
  validateTaskOp,
  validateTestCoverage,
  validateTestRun,
  validateTestStatus,
} from '../lib/engine.js';
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
    const result = await validateSchemaOp(params.type, params.data, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'schema',
      );
    }
    return lafsSuccess(result.data ?? { valid: false, violations: [] }, 'schema');
  },

  task: async (params: ValidateTaskParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'task');
    }
    const result = await validateTaskOp(params.taskId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'task',
      );
    }
    return lafsSuccess(
      result.data ?? { taskId: params.taskId, valid: false, violations: [], checks: {} },
      'task',
    );
  },

  manifest: async (_params: ValidateManifestParams) => {
    const projectRoot = getProjectRoot();
    const result = validateManifestOp(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'manifest',
      );
    }
    return lafsSuccess(result.data ?? { valid: false, entry: {}, violations: [] }, 'manifest');
  },

  output: async (params: ValidateOutputParams) => {
    const projectRoot = getProjectRoot();
    if (!params.filePath) {
      return lafsError('E_INVALID_INPUT', 'filePath is required', 'output');
    }
    const result = validateOutput(params.filePath, params.taskId, projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'output',
      );
    }
    return lafsSuccess(
      result.data ?? { taskId: '', filePath: '', valid: false, checks: {}, violations: [] },
      'output',
    );
  },

  'compliance.summary': async (params: ValidateComplianceSummaryParams) => {
    const projectRoot = getProjectRoot();

    if (params.detail) {
      const result = validateComplianceViolations(params.limit, projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'compliance.summary',
        );
      }
      return lafsSuccess(result.data ?? { violations: [], total: 0 }, 'compliance.summary');
    }

    const result = validateComplianceSummary(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'compliance.summary',
      );
    }

    // Include the requested view type so callers can differentiate
    // trend/skills/value/audit/summary responses
    const data = result.data ?? {};
    const enrichedData = {
      ...data,
      view: params.type ?? 'summary',
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.days ? { days: params.days } : {}),
      ...(params.global ? { global: params.global } : {}),
    };
    return lafsSuccess(enrichedData, 'compliance.summary');
  },

  test: async (params: ValidateTestStatusParams) => {
    const projectRoot = getProjectRoot();

    if (params.format === 'coverage') {
      const result = validateTestCoverage(projectRoot);
      if (!result.success) {
        return lafsError(
          String(result.error?.code ?? 'E_INTERNAL'),
          result.error?.message ?? 'Unknown error',
          'test',
        );
      }
      return lafsSuccess(
        result.data ?? { lineCoverage: 0, branchCoverage: 0, functionCoverage: 0, threshold: 0 },
        'test',
      );
    }

    // Default to status
    const result = validateTestStatus(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'test',
      );
    }
    return lafsSuccess(
      result.data ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 },
      'test',
    );
  },

  coherence: async (_params: ValidateCoherenceParams) => {
    const projectRoot = getProjectRoot();
    const result = await validateCoherenceCheck(projectRoot);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'coherence',
      );
    }
    return lafsSuccess(result.data ?? { passed: false, issues: [], warnings: [] }, 'coherence');
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
        const result = await validateProtocolConsensus(
          {
            ...protocolParams,
            votingMatrixFile: params.votingMatrixFile,
          },
          projectRoot,
        );
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
        const result = await validateProtocolContribution(protocolParams, projectRoot);
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
        const result = await validateProtocolDecomposition(
          {
            ...protocolParams,
            epicId: params.epicId,
          },
          projectRoot,
        );
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
        const result = await validateProtocolImplementation(protocolParams, projectRoot);
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
        const result = await validateProtocolSpecification(
          {
            ...protocolParams,
            specFile: params.specFile,
          },
          projectRoot,
        );
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
        const result = await validateProtocolResearch(
          {
            ...protocolParams,
            hasCodeChanges: params.hasCodeChanges,
          },
          projectRoot,
        );
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
        const result = await validateProtocolArchitectureDecision(
          {
            ...protocolParams,
            adrContent: params.adrContent,
            status: params.status,
            hitlReviewed: params.hitlReviewed,
            downstreamFlagged: params.downstreamFlagged,
            persistedInDb: params.persistedInDb,
          },
          projectRoot,
        );
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
        const result = await validateProtocolValidation(
          {
            ...protocolParams,
            specMatchConfirmed: params.specMatchConfirmed,
            testSuitePassed: params.testSuitePassed,
            protocolComplianceChecked: params.protocolComplianceChecked,
          },
          projectRoot,
        );
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
        const result = await validateProtocolTesting(
          {
            ...protocolParams,
            framework: params.framework,
            testsRun: params.testsRun,
            testsPassed: params.testsPassed,
            testsFailed: params.testsFailed,
            coveragePercent: params.coveragePercent,
            coverageThreshold: params.coverageThreshold,
            ivtLoopConverged: params.ivtLoopConverged,
            ivtLoopIterations: params.ivtLoopIterations,
          },
          projectRoot,
        );
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
        const result = await validateProtocolRelease(
          {
            ...protocolParams,
            version: params.version,
            hasChangelog: params.hasChangelog,
          },
          projectRoot,
        );
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
        const result = await validateProtocolArtifactPublish(
          {
            ...protocolParams,
            artifactType: params.artifactType,
            buildPassed: params.buildPassed,
          },
          projectRoot,
        );
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
        const result = await validateProtocolProvenance(
          {
            ...protocolParams,
            hasAttestation: params.hasAttestation,
            hasSbom: params.hasSbom,
          },
          projectRoot,
        );
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
        const result = await validateProtocol(params.taskId, protocolType, projectRoot);
        if (!result.success) {
          return lafsError(
            String(result.error?.code ?? 'E_INTERNAL'),
            result.error?.message ?? 'Unknown error',
            'protocol',
          );
        }
        return lafsSuccess(result.data ?? { taskId: '', protocol: '', passed: false }, 'protocol');
      }
    }
  },

  'gate.status': async (params: ValidateGateParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'gate.status');
    }
    // Read-only access
    const result = await validateGateVerify({ taskId: params.taskId }, projectRoot);
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
    const raw = await validateGateVerify({ taskId: params.taskId }, projectRoot);
    if (!raw.success) {
      return lafsError(
        String(raw.error?.code ?? 'E_INTERNAL'),
        raw.error?.message ?? 'Unknown error',
        'verify.explain',
      );
    }

    const d = raw.data as {
      taskId: string;
      title?: string;
      status?: string;
      verification?: {
        passed: boolean;
        round: number;
        gates: Record<string, boolean>;
        evidence?: Record<string, unknown>;
        failureLog?: unknown[];
        lastUpdated?: string | null;
      };
      requiredGates?: string[];
      missingGates?: string[];
    };

    const gatesObj = d.verification?.gates ?? {};
    const evidenceObj = (d.verification?.evidence ?? {}) as Record<string, unknown>;
    const requiredGates = d.requiredGates ?? [];
    const missingGates = d.missingGates ?? [];
    const lastUpdated = d.verification?.lastUpdated ?? null;

    // ---- Build gates[] array -----------------------------------------
    const gatesArray = requiredGates.map((gate) => {
      const v = gatesObj[gate];
      const state: 'pass' | 'fail' | 'pending' =
        v === true ? 'pass' : v === false ? 'fail' : 'pending';
      const evidenceEntry = evidenceObj[gate];
      const capturedAt =
        evidenceEntry && typeof evidenceEntry === 'object' && !Array.isArray(evidenceEntry)
          ? ((evidenceEntry as { capturedAt?: string }).capturedAt ?? null)
          : null;
      const timestamp = capturedAt ?? (state === 'pending' ? null : lastUpdated);
      return { name: gate, state, timestamp };
    });

    // ---- Normalise evidence to canonical GateEvidence form ----------
    function normaliseGateEvidence(raw: unknown): {
      atoms: EvidenceAtom[];
      capturedAt: string;
      capturedBy: string;
      override?: boolean;
    } | null {
      if (!raw) return null;
      if (Array.isArray(raw)) {
        return {
          atoms: raw as EvidenceAtom[],
          capturedAt: lastUpdated ?? '',
          capturedBy: 'unknown',
        };
      }
      if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.atoms)) {
          return {
            atoms: obj.atoms as EvidenceAtom[],
            capturedAt: (obj.capturedAt as string) ?? lastUpdated ?? '',
            capturedBy: (obj.capturedBy as string) ?? 'unknown',
            override: obj.override === true,
          };
        }
      }
      return null;
    }

    // ---- Build evidence[] with re-validation --------------------------
    interface EvidenceEntry {
      gate: string;
      atoms: EvidenceAtom[];
      capturedAt: string;
      capturedBy: string;
      override: boolean;
      stillValid: boolean;
      failedAtoms: Array<{ kind: EvidenceAtom['kind']; reason: string }>;
    }

    const evidenceArray: EvidenceEntry[] = [];
    const staleGates: string[] = [];

    for (const gate of requiredGates) {
      const normalised = normaliseGateEvidence(evidenceObj[gate]);
      if (!normalised) continue;

      let stillValid = true;
      let failedAtoms: EvidenceEntry['failedAtoms'] = [];
      try {
        const reval = await revalidateEvidence(
          {
            atoms: normalised.atoms,
            capturedAt: normalised.capturedAt,
            capturedBy: normalised.capturedBy,
            override: normalised.override,
          } as GateEvidence,
          projectRoot,
        );
        stillValid = reval.stillValid;
        failedAtoms = reval.failedAtoms.map((f) => ({
          kind: f.atom.kind,
          reason: f.reason,
        }));
      } catch {
        // Re-validation failure is not fatal
        stillValid = true;
        failedAtoms = [];
      }

      if (!stillValid) {
        staleGates.push(gate);
      }

      evidenceArray.push({
        gate,
        atoms: normalised.atoms,
        capturedAt: normalised.capturedAt,
        capturedBy: normalised.capturedBy,
        override: normalised.override === true,
        stillValid,
        failedAtoms,
      });
    }

    // ---- Build blockers[] ---------------------------------------------
    const blockers: string[] = [];
    for (const g of missingGates) {
      blockers.push(
        `Gate '${g}' is not yet passing — run \`cleo verify ${params.taskId} --gate ${g} --evidence …\``,
      );
    }
    for (const g of staleGates) {
      const entry = evidenceArray.find((e) => e.gate === g);
      const firstFailure = entry?.failedAtoms[0]?.reason ?? 'evidence re-validation failed';
      blockers.push(`Gate '${g}' evidence is stale: ${firstFailure} (E_EVIDENCE_STALE)`);
    }
    if (d.status === 'done') {
      blockers.push(
        `Task ${params.taskId} is already done — verification is locked (ADR-051 §11.1)`,
      );
    }

    // ---- Build human-readable explanation -----------------------------
    const gateLines = requiredGates.map((gate) => {
      const passed = gatesObj[gate] === true;
      const entry = evidenceArray.find((e) => e.gate === gate);
      const atomDesc =
        entry && entry.atoms.length > 0
          ? entry.atoms
              .map((a) => {
                const atom = a as Record<string, unknown>;
                const kind = atom.kind as string;
                const payload =
                  atom.sha ??
                  atom.shortSha ??
                  atom.tool ??
                  atom.url ??
                  atom.note ??
                  atom.path ??
                  atom.value ??
                  '';
                return kind ? `${kind}:${payload}` : String(a);
              })
              .join(', ')
          : 'no evidence recorded';
      const staleTag = entry && !entry.stillValid ? ' [STALE]' : '';
      return `  ${passed ? 'PASS' : 'FAIL'} [${gate}]${staleTag} — ${atomDesc}`;
    });

    const overallVerdict = d.verification?.passed
      ? staleGates.length > 0
        ? `BLOCKED — ${staleGates.length} gate(s) have stale evidence`
        : 'All required gates PASSED'
      : `PENDING — ${missingGates.length} gate(s) not yet passing: ${missingGates.join(', ')}`;

    const explanation = [
      `Task: ${d.taskId}${d.title ? ` — ${d.title}` : ''}`,
      `Status: ${d.status ?? 'unknown'} | Verification round: ${d.verification?.round ?? 0}`,
      ``,
      `Gate breakdown:`,
      ...gateLines,
      ``,
      `Verdict: ${overallVerdict}`,
    ].join('\n');

    return lafsSuccess(
      {
        taskId: d.taskId,
        title: d.title,
        status: d.status,
        passed: d.verification?.passed ?? false,
        round: d.verification?.round ?? 0,
        gates: gatesArray,
        evidence: evidenceArray,
        blockers,
        gatesMap: gatesObj,
        evidenceMap: evidenceObj,
        requiredGates,
        missingGates,
        explanation,
      },
      'verify.explain',
    );
  },

  'archive.stats': async (params: ValidateArchiveStatsParams) => {
    const projectRoot = getProjectRoot();
    const result = await systemArchiveStats(projectRoot, {
      period: params.period,
      report: params.report as any,
      since: params.since,
      until: params.until,
    });
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'archive.stats',
      );
    }
    return lafsSuccess(result.data ?? {}, 'archive.stats');
  },

  'chain.validate': async (params: ValidateChainParams) => {
    const projectRoot = getProjectRoot();
    if (!params.chain) {
      return lafsError('E_INVALID_INPUT', 'chain is required', 'chain.validate');
    }
    const chainResult = validateChain(params.chain);
    return lafsSuccess(chainResult, 'chain.validate');
  },

  grade: async (params: ValidateGradeParams) => {
    const projectRoot = getProjectRoot();
    const { gradeSession } = await import('@cleocode/core/internal');
    if (!params.sessionId) {
      return lafsError('E_INVALID_INPUT', 'sessionId required', 'grade');
    }
    const gradeResult = await gradeSession(params.sessionId, projectRoot);
    return lafsSuccess(gradeResult, 'grade');
  },

  'grade.list': async (params: ValidateGradeListParams) => {
    const projectRoot = getProjectRoot();
    const { readGrades } = await import('@cleocode/core/internal');
    const allGrades = await readGrades(undefined, projectRoot);
    const filteredGrades = params.sessionId
      ? allGrades.filter((g) => g.sessionId === params.sessionId)
      : allGrades;
    const page = paginate(filteredGrades, params.limit, params.offset);
    return lafsSuccess(
      {
        grades: page.items,
        total: allGrades.length,
        filtered: filteredGrades.length,
      },
      'grade.list',
    );
  },

  canon: async (_params: ValidateCanonParams) => {
    const projectRoot = getProjectRoot();
    const { runCanonCheck } = await import('./check/canon.js');
    const result = runCanonCheck({ projectRoot });
    return lafsSuccess(result, 'canon');
  },

  'workflow.compliance': async (params: ValidateWorkflowComplianceParams) => {
    const projectRoot = getProjectRoot();
    const result = await getWorkflowComplianceReport({
      since: params.since,
      cwd: projectRoot,
    });
    return lafsSuccess(result, 'workflow.compliance');
  },

  // -----------------------------------------------------------------------
  // Mutate ops
  // -----------------------------------------------------------------------

  'compliance.record': async (params: ValidateComplianceRecordParams) => {
    const projectRoot = getProjectRoot();
    if (!params.taskId || !params.result) {
      return lafsError('E_INVALID_INPUT', 'taskId and result are required', 'compliance.record');
    }
    const engineResult = validateComplianceRecord(
      params.taskId,
      params.result,
      params.protocol,
      params.violations,
      projectRoot,
    );
    if (!engineResult.success) {
      return lafsError(
        String(engineResult.error?.code ?? 'E_INTERNAL'),
        engineResult.error?.message ?? 'Unknown error',
        'compliance.record',
      );
    }
    return lafsSuccess(
      engineResult.data ?? { taskId: params.taskId, recorded: '' },
      'compliance.record',
    );
  },

  'test.run': async (params: ValidateTestRunParams) => {
    const projectRoot = getProjectRoot();
    const result = validateTestRun(
      { scope: params.scope, pattern: params.pattern, parallel: params.parallel },
      projectRoot,
    );
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'test.run',
      );
    }
    return lafsSuccess(
      result.data ?? { status: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 } },
      'test.run',
    );
  },

  'compliance.sync': async (params: ValidateComplianceSyncParams) => {
    const projectRoot = getProjectRoot();
    const { syncComplianceMetrics } = await import('@cleocode/core/internal');
    const result = await syncComplianceMetrics({
      force: params.force,
      cwd: projectRoot,
    });
    return lafsSuccess(result, 'compliance.sync');
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
    };
    const result = await validateGateVerify(gateParams, projectRoot);
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
      const envelope = await typedDispatch(_checkTypedHandler, operation as any, params);
      return {
        meta: dispatchMeta('query', 'check', operation, startTime),
        success: envelope.success,
        ...(envelope.success ? { data: envelope.data } : { error: envelope.error }),
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
      const envelope = await typedDispatch(_checkTypedHandler, operation as any, params);
      return {
        meta: dispatchMeta('mutate', 'check', operation, startTime),
        success: envelope.success,
        ...(envelope.success ? { data: envelope.data } : { error: envelope.error }),
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
