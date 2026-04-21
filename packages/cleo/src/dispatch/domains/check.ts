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
 * @epic T4820
 */

import type { EvidenceAtom, GateEvidence, WarpChain } from '@cleocode/contracts';
import {
  getLogger,
  getProjectRoot,
  getWorkflowComplianceReport,
  paginate,
  revalidateEvidence,
  validateChain,
} from '@cleocode/core/internal';

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
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// CheckHandler
// ---------------------------------------------------------------------------

export class CheckHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'schema': {
          const type = params?.type as string;
          if (!type) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'type is required',
              startTime,
            );
          }
          const result = await validateSchemaOp(type, params?.data, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'task': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await validateTaskOp(taskId, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'manifest': {
          const result = validateManifestOp(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'output': {
          const filePath = params?.filePath as string;
          if (!filePath) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'filePath is required',
              startTime,
            );
          }
          const result = validateOutput(
            filePath,
            params?.taskId as string | undefined,
            projectRoot,
          );
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'compliance.summary': {
          const detail = params?.detail as boolean | undefined;
          const limit = params?.limit as number | undefined;
          const summaryType = (params?.type as string) ?? 'summary';

          if (detail) {
            const result = validateComplianceViolations(limit, projectRoot);
            return wrapResult(result, 'query', 'check', operation, startTime);
          }

          const result = validateComplianceSummary(projectRoot);
          if (!result.success || !result.data) {
            return wrapResult(result, 'query', 'check', operation, startTime);
          }

          // Include the requested view type so callers can differentiate
          // trend/skills/value/audit/summary responses
          const enrichedResult = {
            ...result,
            data: {
              ...(result.data as Record<string, unknown>),
              view: summaryType,
              ...(params?.taskId ? { taskId: params.taskId } : {}),
              ...(params?.days ? { days: params.days } : {}),
              ...(params?.global ? { global: params.global } : {}),
            },
          };
          return wrapResult(enrichedResult, 'query', 'check', operation, startTime);
        }

        case 'test': {
          const format = params?.format as string | undefined; // 'status' (default) or 'coverage'

          if (format === 'coverage') {
            const result = validateTestCoverage(projectRoot);
            return wrapResult(result, 'query', 'check', operation, startTime);
          }

          // Default to status
          const result = validateTestStatus(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'coherence': {
          const result = await validateCoherenceCheck(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'protocol': {
          const protocolType = params?.protocolType as string | undefined;
          const mode = (params?.mode as 'task' | 'manifest') ?? 'task';

          // Common protocol parameters
          const protocolParams = {
            mode,
            taskId: params?.taskId as string | undefined,
            manifestFile: params?.manifestFile as string | undefined,
            strict: params?.strict as boolean | undefined,
          };

          // Dispatch to specific protocol validators
          switch (protocolType) {
            case 'consensus': {
              const result = await validateProtocolConsensus(
                {
                  ...protocolParams,
                  votingMatrixFile: params?.votingMatrixFile as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'contribution': {
              const result = await validateProtocolContribution(protocolParams, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'decomposition': {
              const result = await validateProtocolDecomposition(
                {
                  ...protocolParams,
                  epicId: params?.epicId as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'implementation': {
              const result = await validateProtocolImplementation(protocolParams, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'specification': {
              const result = await validateProtocolSpecification(
                {
                  ...protocolParams,
                  specFile: params?.specFile as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'research': {
              const result = await validateProtocolResearch(
                {
                  ...protocolParams,
                  hasCodeChanges: params?.hasCodeChanges as boolean | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'architecture-decision':
            case 'architecture_decision': {
              const result = await validateProtocolArchitectureDecision(
                {
                  ...protocolParams,
                  adrContent: params?.adrContent as string | undefined,
                  status: params?.status as
                    | 'proposed'
                    | 'accepted'
                    | 'superseded'
                    | 'deprecated'
                    | undefined,
                  hitlReviewed: params?.hitlReviewed as boolean | undefined,
                  downstreamFlagged: params?.downstreamFlagged as boolean | undefined,
                  persistedInDb: params?.persistedInDb as boolean | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'validation': {
              const result = await validateProtocolValidation(
                {
                  ...protocolParams,
                  specMatchConfirmed: params?.specMatchConfirmed as boolean | undefined,
                  testSuitePassed: params?.testSuitePassed as boolean | undefined,
                  protocolComplianceChecked: params?.protocolComplianceChecked as
                    | boolean
                    | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'testing': {
              const result = await validateProtocolTesting(
                {
                  ...protocolParams,
                  framework: params?.framework as string | undefined,
                  testsRun: params?.testsRun as number | undefined,
                  testsPassed: params?.testsPassed as number | undefined,
                  testsFailed: params?.testsFailed as number | undefined,
                  coveragePercent: params?.coveragePercent as number | undefined,
                  coverageThreshold: params?.coverageThreshold as number | undefined,
                  ivtLoopConverged: params?.ivtLoopConverged as boolean | undefined,
                  ivtLoopIterations: params?.ivtLoopIterations as number | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'release': {
              const result = await validateProtocolRelease(
                {
                  ...protocolParams,
                  version: params?.version as string | undefined,
                  hasChangelog: params?.hasChangelog as boolean | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'artifact-publish':
            case 'artifact_publish': {
              const result = await validateProtocolArtifactPublish(
                {
                  ...protocolParams,
                  artifactType: params?.artifactType as string | undefined,
                  buildPassed: params?.buildPassed as boolean | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'provenance': {
              const result = await validateProtocolProvenance(
                {
                  ...protocolParams,
                  hasAttestation: params?.hasAttestation as boolean | undefined,
                  hasSbom: params?.hasSbom as boolean | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            default: {
              // Generic protocol validation (legacy behavior)
              const taskId = params?.taskId as string;
              if (!taskId) {
                return errorResult(
                  'query',
                  'check',
                  operation,
                  'E_INVALID_INPUT',
                  'taskId is required for generic protocol check',
                  startTime,
                );
              }
              const result = await validateProtocol(taskId, protocolType, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
          }
        }

        case 'gate.status': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          // Read-only access
          const result = await validateGateVerify({ taskId }, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        // T1006 / T1013 — human-readable breakdown of why gates pass/fail
        // for a task.  Enriches gate.status output with three arrays:
        //   - gates[]    : {name, state, timestamp} per required gate
        //   - evidence[] : per-gate evidence atoms + re-validation result
        //   - blockers[] : human-readable reasons why `cleo complete` is blocked
        //
        // Legacy object-shaped `gatesMap` and `evidenceMap` fields remain for
        // backward compatibility with prior callers (ADR-051, T1006).
        case 'verify.explain': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          // Reuse gate.status read-only view for the raw data
          const raw = await validateGateVerify({ taskId }, projectRoot);
          if (!raw.success) {
            return wrapResult(raw, 'query', 'check', operation, startTime);
          }

          const d = raw.data as {
            taskId: string;
            title?: string;
            status?: string;
            verification?: {
              passed: boolean;
              round: number;
              gates: Record<string, boolean>;
              /**
               * Real shape is `Partial<Record<VerificationGate, GateEvidence>>`
               * but legacy callers (and some tests) supply arrays of atoms
               * keyed by gate name.  Both are normalised below.
               */
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
          // Each required gate carries its own state.  `pending` = never
          // attempted (value is null/undefined).  `pass`/`fail` = explicit.
          const gatesArray = requiredGates.map((gate) => {
            const v = gatesObj[gate];
            const state: 'pass' | 'fail' | 'pending' =
              v === true ? 'pass' : v === false ? 'fail' : 'pending';
            const evidenceEntry = evidenceObj[gate];
            // Prefer per-gate capturedAt when available, fall back to task-level
            // lastUpdated so callers always see an ISO timestamp for passed gates.
            const capturedAt =
              evidenceEntry && typeof evidenceEntry === 'object' && !Array.isArray(evidenceEntry)
                ? ((evidenceEntry as { capturedAt?: string }).capturedAt ?? null)
                : null;
            const timestamp = capturedAt ?? (state === 'pending' ? null : lastUpdated);
            return { name: gate, state, timestamp };
          });

          // ---- Normalise evidence to canonical GateEvidence form ----------
          // Normalisation rules:
          //   - {atoms, capturedAt, capturedBy} → passthrough (canonical shape)
          //   - [atom, atom, …]                 → wrap in minimal GateEvidence
          //   - anything else                   → dropped (no atoms)
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
              if (Array.isArray(obj['atoms'])) {
                return {
                  atoms: obj['atoms'] as EvidenceAtom[],
                  capturedAt: (obj['capturedAt'] as string) ?? lastUpdated ?? '',
                  capturedBy: (obj['capturedBy'] as string) ?? 'unknown',
                  override: obj['override'] === true,
                };
              }
            }
            return null;
          }

          // ---- Build evidence[] with re-validation --------------------------
          // Re-run the staleness check so callers see whether captured
          // evidence still matches git/filesystem/toolchain reality.  This
          // is the same logic `cleo complete` runs, surfaced for visibility.
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

            // Only re-validate when evidence shape is complete enough to feed
            // the helper — override evidence and legacy array-wrapped entries
            // are accepted as-is to preserve backward compatibility.
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
              // Re-validation failure is not fatal — surface as unknown
              // (treat as still-valid to avoid false-positive blockers).
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
          // Every reason `cleo complete` would refuse is listed here:
          //   1. Unmet required gates (missingGates from gate.status)
          //   2. Stale evidence (hash drift, file removal, commit unreachable)
          //   3. Task already `done` (the raw engine surfaces this too)
          const blockers: string[] = [];
          for (const g of missingGates) {
            blockers.push(
              `Gate '${g}' is not yet passing — run \`cleo verify ${taskId} --gate ${g} --evidence …\``,
            );
          }
          for (const g of staleGates) {
            const entry = evidenceArray.find((e) => e.gate === g);
            const firstFailure = entry?.failedAtoms[0]?.reason ?? 'evidence re-validation failed';
            blockers.push(`Gate '${g}' evidence is stale: ${firstFailure} (E_EVIDENCE_STALE)`);
          }
          if (d.status === 'done') {
            blockers.push(
              `Task ${taskId} is already done — verification is locked (ADR-051 §11.1)`,
            );
          }

          // ---- Build human-readable explanation -----------------------------
          // Matches the prior (T1006) format so callers parsing explanation
          // continue to work.  Atoms are rendered as `kind:value` for brevity.
          const gateLines = requiredGates.map((gate) => {
            const passed = gatesObj[gate] === true;
            const entry = evidenceArray.find((e) => e.gate === gate);
            const atomDesc =
              entry && entry.atoms.length > 0
                ? entry.atoms
                    .map((a) => {
                      const atom = a as Record<string, unknown>;
                      // Best-effort: extract a display value from each atom kind
                      const kind = atom['kind'] as string;
                      const payload =
                        atom['sha'] ??
                        atom['shortSha'] ??
                        atom['tool'] ??
                        atom['url'] ??
                        atom['note'] ??
                        atom['path'] ??
                        atom['value'] ??
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

          return {
            meta: dispatchMeta('query', 'check', operation, startTime),
            success: true,
            data: {
              taskId: d.taskId,
              title: d.title,
              status: d.status,
              passed: d.verification?.passed ?? false,
              round: d.verification?.round ?? 0,
              // T1013 canonical shape — array-shaped, type-safe, re-validated.
              gates: gatesArray,
              evidence: evidenceArray,
              blockers,
              // Legacy object-shape (kept for T1006 callers reading
              // gates[gate] / evidence[gate]).  New consumers should use
              // the top-level arrays above.
              gatesMap: gatesObj,
              evidenceMap: evidenceObj,
              requiredGates,
              missingGates,
              explanation,
            },
          };
        }

        case 'archive.stats': {
          const result = await systemArchiveStats(projectRoot, {
            period: params?.period as number | undefined,
            report: params?.report as
              | import('@cleocode/core/internal').ArchiveReportType
              | undefined,
            since: params?.since as string | undefined,
            until: params?.until as string | undefined,
          });
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        // T5405: WarpChain validation
        case 'chain.validate': {
          const chain = params?.chain as WarpChain;
          if (!chain) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'chain is required',
              startTime,
            );
          }
          const chainResult = validateChain(chain);
          return wrapResult(
            { success: chainResult.errors.length === 0, data: chainResult },
            'query',
            'check',
            operation,
            startTime,
          );
        }

        // T5615: grade ops moved from admin to check
        case 'grade': {
          const { gradeSession } = await import('@cleocode/core/internal');
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'sessionId required',
              startTime,
            );
          }
          const gradeResult = await gradeSession(sessionId, projectRoot);
          return wrapResult(
            { success: true, data: gradeResult },
            'query',
            'check',
            operation,
            startTime,
          );
        }

        case 'grade.list': {
          const { readGrades } = await import('@cleocode/core/internal');
          const limit = typeof params?.limit === 'number' ? params.limit : undefined;
          const offset = typeof params?.offset === 'number' ? params.offset : undefined;
          const allGrades = await readGrades(undefined, projectRoot);
          const sessionId = params?.sessionId as string | undefined;
          const filteredGrades = sessionId
            ? allGrades.filter((g) => g.sessionId === sessionId)
            : allGrades;
          const page = paginate(filteredGrades, limit, offset);
          return {
            meta: dispatchMeta('query', 'check', operation, startTime),
            success: true,
            data: {
              grades: page.items,
              total: allGrades.length,
              filtered: filteredGrades.length,
            },
            page: page.page,
          };
        }

        // T646: Canon drift detection — compares docs to live code
        case 'canon': {
          const { runCanonCheck } = await import('./check/canon.js');
          const result = runCanonCheck({ projectRoot });
          return {
            meta: dispatchMeta('query', 'check', operation, startTime),
            success: result.passed,
            data: result,
            ...(!result.passed
              ? {
                  error: {
                    code: 'E_CANON_DRIFT',
                    message: `Canon drift detected: ${result.violations.length} forbidden phrase(s), ${result.assertions.filter((a) => !a.passed).length} failed assertion(s)`,
                  },
                }
              : {}),
          };
        }

        // T065: Workflow compliance telemetry — WF-001 through WF-005
        case 'workflow.compliance': {
          const since = params?.since as string | undefined;
          const result = await getWorkflowComplianceReport({
            since,
            cwd: projectRoot,
          });
          return {
            meta: dispatchMeta('query', 'check', operation, startTime),
            success: true,
            data: result,
          };
        }

        default:
          return unsupportedOp('query', 'check', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'query', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'check', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'compliance.record': {
          const taskId = params?.taskId as string;
          const result = params?.result as string;
          if (!taskId || !result) {
            return errorResult(
              'mutate',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId and result are required',
              startTime,
            );
          }
          const engineResult = validateComplianceRecord(
            taskId,
            result,
            params?.protocol as string | undefined,
            params?.violations as
              | Array<{ code: string; message: string; severity: 'error' | 'warning' }>
              | undefined,
            projectRoot,
          );
          return wrapResult(engineResult, 'mutate', 'check', operation, startTime);
        }

        case 'test.run': {
          const result = validateTestRun(
            params as { scope?: string; pattern?: string; parallel?: boolean } | undefined,
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'check', operation, startTime);
        }

        case 'compliance.sync': {
          const { syncComplianceMetrics } = await import('@cleocode/core/internal');
          const result = await syncComplianceMetrics({
            force: params?.force as boolean | undefined,
            cwd: projectRoot,
          });
          return {
            meta: dispatchMeta('mutate', 'check', operation, startTime),
            success: (result.success as boolean) ?? true,
            data: result,
          };
        }

        case 'gate.set': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const gateParams = {
            taskId,
            gate: params?.gate as string | undefined,
            value: params?.value as boolean | undefined,
            agent: params?.agent as string | undefined,
            all: params?.all as boolean | undefined,
            reset: params?.reset as boolean | undefined,
            // T832 / ADR-051: evidence + sessionId for audit trail.
            evidence: params?.evidence as string | undefined,
            sessionId: params?.sessionId as string | undefined,
          };
          const result = await validateGateVerify(gateParams, projectRoot);
          // T994: Track memory usage on gate verification (fire-and-forget; must not block).
          setImmediate(async () => {
            try {
              const { trackMemoryUsage } = await import('@cleocode/core/internal');
              await trackMemoryUsage(projectRoot, taskId, true, taskId, 'verified');
            } catch {
              // Quality tracking errors must never surface to the verify flow
            }
          });
          return wrapResult(result, 'mutate', 'check', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'check', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'mutate', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'check', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

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
        // T1006 — human-readable breakdown of why gates pass/fail for a task
        'verify.explain',
      ],
      mutate: ['compliance.record', 'compliance.sync', 'test.run', 'gate.set'],
    };
  }
}
