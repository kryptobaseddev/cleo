/**
 * Validate Engine Operations — business logic layer.
 *
 * Contains all gate-verification and protocol-validation domain logic migrated
 * from `packages/cleo/src/dispatch/engines/validate-engine.ts` (ENG-MIG-7 / T1574).
 *
 * Each exported function returns `EngineResult` and is importable from
 * `@cleocode/core/internal` so the CLI dispatch layer can call them without
 * any intermediate engine file.
 *
 * @task T1574 — ENG-MIG-7
 * @epic T1566
 */

import type {
  EvidenceAtom,
  GateEvidence,
  TaskVerification,
  VerificationGate,
} from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { checkAndIncrementOverrideCap } from '../security/override-cap.js';
import { enforceSharedEvidence } from '../security/shared-evidence-tracker.js';
import { getAccessor } from '../store/data-accessor.js';
import {
  checkCallsiteCoverageAtom,
  checkEngineMigrationLocDrop,
  checkGateEvidenceMinimum,
  composeGateEvidence,
  parseEvidence,
  validateAtom,
} from '../tasks/evidence.js';
import { appendForceBypassLine, appendGateAuditLine } from '../tasks/gate-audit.js';
import {
  hasCallsiteCoverageLabel,
  hasEngineMigrationLabel,
} from '../verification/evidence-atoms.js';
import {
  checkArchitectureDecisionManifest,
  validateArchitectureDecisionTask,
} from './protocols/architecture-decision.js';
import {
  checkArtifactPublishManifest,
  validateArtifactPublishTask,
} from './protocols/artifact-publish.js';
import { checkConsensusManifest, validateConsensusTask } from './protocols/consensus.js';
import { checkContributionManifest, validateContributionTask } from './protocols/contribution.js';
import {
  checkDecompositionManifest,
  validateDecompositionTask,
} from './protocols/decomposition.js';
import {
  checkImplementationManifest,
  validateImplementationTask,
} from './protocols/implementation.js';
import { checkProvenanceManifest, validateProvenanceTask } from './protocols/provenance.js';
import { checkReleaseManifest, validateReleaseTask } from './protocols/release.js';
import { checkResearchManifest, validateResearchTask } from './protocols/research.js';
import {
  checkSpecificationManifest,
  validateSpecificationTask,
} from './protocols/specification.js';
import { checkTestingManifest, validateTestingTask } from './protocols/testing.js';
import { checkValidationManifest, validateValidationTask } from './protocols/validation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Parameters shared across all protocol validation operations. */
export interface ProtocolValidationParams {
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

export interface GateVerifyParams {
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

export interface GateVerifyResult {
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

// ---------------------------------------------------------------------------
// Shared catch handler for protocol validation ops.
// ---------------------------------------------------------------------------

function protocolCatch(err: unknown): EngineResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.includes('not found')
    ? 'E_NOT_FOUND'
    : message.includes('violations')
      ? 'E_PROTOCOL_VIOLATION'
      : 'E_VALIDATION_ERROR';
  return engineError(code, message);
}

// ---------------------------------------------------------------------------
// Gate verification
// ---------------------------------------------------------------------------

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
  projectRoot: string,
  params: GateVerifyParams,
): Promise<EngineResult<GateVerifyResult>> {
  try {
    const { taskId, gate, value = true, agent, all, reset } = params;
    const agentId = agent ?? 'unknown';
    const sessionId = params.sessionId ?? null;

    // Validate task ID format
    const idPattern = /^T\d{3,}$/;
    if (!idPattern.test(taskId)) {
      return engineError('E_INVALID_INPUT', `Invalid task ID format: ${taskId}`);
    }

    const accessor = await getAccessor(projectRoot);
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

    const configGates = await loadRequiredGates(projectRoot);

    // View mode (no modifications)
    if (!gate && !all && !reset) {
      const verification = task.verification ?? initVerification();
      const missing = getMissingGates(verification, configGates);
      return engineSuccess({
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
      });
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
        projectRoot,
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
        projectRoot,
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
          const check = await validateAtom(atom, projectRoot);
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

        // T1604 — engine-migration label gate.
        // If the task carries the `engine-migration` label and the `implemented`
        // gate is among the targets, require a `loc-drop` evidence atom proving
        // the migrated engine shed ≥ the configured minimum percentage of LOC.
        const isImplementedTarget = targets.includes('implemented');
        if (isImplementedTarget && hasEngineMigrationLabel(task.labels ?? [])) {
          const locDropError = checkEngineMigrationLocDrop(validatedAtoms);
          if (locDropError) {
            return engineError('E_EVIDENCE_INSUFFICIENT', locDropError);
          }
        }

        // T1605 — callsite-coverage label gate.
        // If the task carries the `callsite-coverage` label and the `implemented`
        // gate is among the targets, require a `callsite-coverage` evidence atom
        // proving the exported symbol has ≥1 production callsite outside its
        // own source file, test files, and dist directories.  Catches the T1601
        // pattern where a function is shipped but never wired to production.
        if (isImplementedTarget && hasCallsiteCoverageLabel(task.labels ?? [])) {
          const callsiteError = checkCallsiteCoverageAtom(validatedAtoms);
          if (callsiteError) {
            return engineError('E_EVIDENCE_INSUFFICIENT', callsiteError);
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
        await appendGateAuditLine(projectRoot, auditRecord);
        if (override.override && action !== 'reset') {
          // T1501: include sessionOverrideOrdinal in the force-bypass record.
          // T1504: include workTreeContext when the override was exempt from the cap counter.
          await appendForceBypassLine(projectRoot, {
            ...auditRecord,
            overrideReason: override.reason,
            pid: process.pid,
            command: (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512),
            ...(sessionOverrideOrdinal !== undefined ? { sessionOverrideOrdinal } : {}),
            ...(isWorktreeCtx ? { workTreeContext: true } : {}),
          });
        } else if ((sharedEvidenceAcknowledged || sharedAtomWarned) && action !== 'reset') {
          // T1502: log shared-evidence state even on non-override writes.
          await appendForceBypassLine(projectRoot, {
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

    return engineSuccess(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_GENERAL', message);
  }
}

// ---------------------------------------------------------------------------
// Protocol validation operations (T5327 + T260)
// ---------------------------------------------------------------------------

/**
 * check.protocol.consensus - Validate consensus protocol compliance
 * @task T5327
 */
export async function validateProtocolConsensus(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, votingMatrixFile } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateConsensusTask(params.taskId, { strict, votingMatrixFile });
      return engineSuccess(result);
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkConsensusManifest(params.manifestFile, {
        strict,
        votingMatrixFile,
      });
      return engineSuccess(result);
    }
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.contribution - Validate contribution protocol compliance
 * @task T5327
 */
export async function validateProtocolContribution(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateContributionTask(params.taskId, { strict });
      return engineSuccess(result);
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkContributionManifest(params.manifestFile, { strict });
      return engineSuccess(result);
    }
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.decomposition - Validate decomposition protocol compliance
 * @task T5327
 */
export async function validateProtocolDecomposition(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, epicId } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateDecompositionTask(params.taskId, { strict, epicId });
      return engineSuccess(result);
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkDecompositionManifest(params.manifestFile, { strict, epicId });
      return engineSuccess(result);
    }
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.implementation - Validate implementation protocol compliance
 * @task T5327
 */
export async function validateProtocolImplementation(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateImplementationTask(params.taskId, { strict });
      return engineSuccess(result);
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkImplementationManifest(params.manifestFile, { strict });
      return engineSuccess(result);
    }
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.specification - Validate specification protocol compliance
 * @task T5327
 */
export async function validateProtocolSpecification(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, specFile } = params;

    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateSpecificationTask(params.taskId, { strict, specFile });
      return engineSuccess(result);
    } else {
      if (!params.manifestFile) {
        return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
      }
      const result = await checkSpecificationManifest(params.manifestFile, { strict, specFile });
      return engineSuccess(result);
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
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, hasCodeChanges } = params;
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateResearchTask(params.taskId, { strict, hasCodeChanges });
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkResearchManifest(params.manifestFile, { strict, hasCodeChanges });
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.architecture-decision - Validate ADR protocol compliance
 * @task T260
 */
export async function validateProtocolArchitectureDecision(
  _projectRoot: string,
  params: ProtocolValidationParams,
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
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkArchitectureDecisionManifest(params.manifestFile, adrOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.validation - Validate validation-stage protocol compliance
 * @task T260
 */
export async function validateProtocolValidation(
  _projectRoot: string,
  params: ProtocolValidationParams,
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
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkValidationManifest(params.manifestFile, validationOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.testing - Validate testing-stage protocol compliance (IVT loop)
 * @task T260
 */
export async function validateProtocolTesting(
  _projectRoot: string,
  params: ProtocolValidationParams,
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
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkTestingManifest(params.manifestFile, testingOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.release - Validate release protocol compliance
 * @task T260
 */
export async function validateProtocolRelease(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, version, hasChangelog } = params;
    const releaseOpts = { strict, version, hasChangelog };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateReleaseTask(params.taskId, releaseOpts);
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkReleaseManifest(params.manifestFile, releaseOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.artifact-publish - Validate artifact-publish protocol compliance
 * @task T260
 */
export async function validateProtocolArtifactPublish(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, artifactType, buildPassed } = params;
    const artifactOpts = { strict, artifactType, buildPassed };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateArtifactPublishTask(params.taskId, artifactOpts);
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkArtifactPublishManifest(params.manifestFile, artifactOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}

/**
 * check.protocol.provenance - Validate provenance protocol compliance
 * @task T260
 */
export async function validateProtocolProvenance(
  _projectRoot: string,
  params: ProtocolValidationParams,
): Promise<EngineResult> {
  try {
    const { mode, strict, hasAttestation, hasSbom } = params;
    const provenanceOpts = { strict, hasAttestation, hasSbom };
    if (mode === 'task') {
      if (!params.taskId) {
        return engineError('E_INVALID_INPUT', 'taskId is required for task mode');
      }
      const result = await validateProvenanceTask(params.taskId, provenanceOpts);
      return engineSuccess(result);
    }
    if (!params.manifestFile) {
      return engineError('E_INVALID_INPUT', 'manifestFile is required for manifest mode');
    }
    const result = await checkProvenanceManifest(params.manifestFile, provenanceOpts);
    return engineSuccess(result);
  } catch (err: unknown) {
    return protocolCatch(err);
  }
}
