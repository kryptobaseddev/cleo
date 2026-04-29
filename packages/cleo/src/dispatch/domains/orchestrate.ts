/**
 * Orchestrate Domain Handler (Dispatch Layer)
 *
 * Handles multi-agent orchestration: dependency analysis, wave computation,
 * spawn readiness, parallel coordination, and orchestration context.
 * All operations delegate to native engine functions.
 *
 * Wave 7a additions (T379):
 * - orchestrate.classify (T408) — prompt-based team routing stub
 * - orchestrate.fanout (T409) — Promise.allSettled spawn wrapper
 * - orchestrate.fanout.status (T415) — fanout status stub
 * - orchestrate.analyze mode="parallel-safety" (T410) — dep-graph grouping
 *
 * Type-safe dispatch via OpsFromCore<typeof coreOps> per ADR-058.
 * Param extraction inferred by coreOps — zero `params?.x as Type` casts.
 *
 * @epic T4820
 * @epic T377
 * @task T1538 — OpsFromCore migration per ADR-058
 */

import {
  getLogger,
  getProjectRoot,
  instantiateTessera,
  listTesseraTemplates,
  paginate,
  pivotTask,
  showTessera,
} from '@cleocode/core/internal';
import { CLEO_DIR_NAME, WORKFLOWS_SUBDIR } from '../../cli/paths.js';
import type { OpsFromCore } from '../adapters/typed.js';
import {
  orchestrateAnalyze,
  orchestrateBootstrap,
  orchestrateContext,
  orchestrateHandoff,
  orchestrateNext,
  orchestrateParallelEnd,
  orchestrateParallelStart,
  orchestratePlan,
  orchestrateReady,
  orchestrateSpawn,
  orchestrateSpawnExecute,
  orchestrateStartup,
  orchestrateStatus,
  orchestrateUnblockOpportunities,
  orchestrateValidate,
  orchestrateWaves,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, getListParams, handleErrorResult, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';
import { IvtrHandler } from './ivtr.js';
import {
  acquirePlaybookDb,
  listPendingApprovalsForDispatch,
  lookupApprovalByTokenForDispatch,
} from './playbook.js';

/** Shared IvtrHandler instance for ivtr.* sub-operations (T811). */
const ivtrHandler = new IvtrHandler();

// ---------------------------------------------------------------------------
// Local param types for OpsFromCore wrapper functions
// ---------------------------------------------------------------------------

interface OrchestrateStatusParams {
  epicId?: string;
}

interface OrchestrateNextParams {
  epicId: string;
}

interface OrchestrateReadyParams {
  epicId: string;
}

interface OrchestrateAnalyzeParams {
  epicId?: string;
  mode?: string;
  taskIds?: string[];
}

interface OrchestrateClassifyParams {
  request: string;
  context?: string;
}

interface OrchestrateFanoutStatusParams {
  manifestEntryId: string;
}

interface OrchestrateContextParams {
  epicId?: string;
}

interface OrchestrateWavesParams {
  epicId: string;
}

interface OrchestratePlanParams {
  epicId: string;
  preferTier?: 0 | 1 | 2;
}

interface OrchestrateBootstrapParams {
  speed?: 'fast' | 'full' | 'complete';
}

type OrchestrateUnblockParams = Record<string, never>;

interface OrchestrateTesseraListParams {
  id?: string;
  limit?: number;
  offset?: number;
}

interface OrchestrateIvtrStatusParams {
  taskId?: string;
  [key: string]: unknown;
}

type OrchestratePendingParams = Record<string, never>;

interface OrchestrateStartParams {
  epicId: string;
}

interface OrchestrateSpawnParams {
  taskId: string;
  protocolType?: string;
  tier?: 0 | 1 | 2;
  noWorktree?: boolean;
}

interface OrchestrateHandoffParams {
  taskId: string;
  protocolType: string;
  note?: string;
  nextAction?: string;
  variant?: string;
  tier?: 0 | 1 | 2;
  idempotencyKey?: string;
}

interface OrchestrateSpawnExecuteParams {
  taskId: string;
  adapterId?: string;
  protocolType?: string;
  tier?: 0 | 1 | 2;
}

interface OrchestrateValidateParams {
  taskId: string;
}

interface OrchestratePivotParams {
  fromTaskId: string;
  toTaskId: string;
  reason: string;
  blocksFrom?: boolean;
}

interface OrchestrateWorktreeCompleteParams {
  taskId: string;
}

interface OrchestrateWorktreeCleanupParams {
  taskIds?: string[];
}

interface OrchestrateWorktreePruneParams {
  taskId?: string;
}

interface OrchestrateParallelParams {
  action: string;
  epicId?: string;
  wave?: number;
}

interface OrchestrateFanoutParams {
  items: Array<{ team: string; taskId: string; skill?: string }>;
}

interface OrchestrateTesseraInstantiateParams {
  templateId: string;
  epicId: string;
  variables?: Record<string, unknown>;
}

interface OrchestrateApproveParams {
  resumeToken?: string;
  approver?: string;
  reason?: string;
}

interface OrchestrateRejectParams {
  resumeToken?: string;
  approver?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Wave 7a helper types (T408, T409, T410)
// ---------------------------------------------------------------------------

/** Classify result shape returned by orchestrate.classify. */
interface ClassifyResult {
  /** Matched team name, or null if no match. */
  team: string | null;
  /** Lead agent name within the matched team, or null. */
  lead: string | null;
  /** Suggested protocol type for the spawn. */
  protocol: string | null;
  /** Stage hint from the matched team's stages list. */
  stage: string | null;
  /** Confidence score 0.0–1.0 (stub always returns 0.5). */
  confidence: number;
  /** Human-readable reasoning for the classification. */
  reasoning: string;
}

/** Single fanout item shape. */
interface FanoutItem {
  /** Team name to route the task to. */
  team: string;
  /** Task ID to spawn. */
  taskId: string;
  /** Optional skill to inject into the spawn context. */
  skill?: string;
}

/** Result for a single fanout item. */
interface FanoutItemResult {
  /** Task ID. */
  taskId: string;
  /** Outcome status. */
  status: 'spawned' | 'failed';
  /** Adapter instance ID returned by the spawn adapter, when available. */
  instanceId?: string;
  /** Error message if status is failed. */
  error?: string;
}

/** Maximum number of fanout manifest entries retained in memory. */
const FANOUT_MANIFEST_MAX_SIZE = 64;

const fanoutManifestStore = new Map<
  string,
  {
    results: FanoutItemResult[];
    completedAt: string;
  }
>();

/**
 * Evict oldest entries when the manifest store exceeds the size cap.
 */
function evictFanoutManifest(): void {
  while (fanoutManifestStore.size > FANOUT_MANIFEST_MAX_SIZE) {
    const oldest = fanoutManifestStore.keys().next().value;
    if (oldest !== undefined) fanoutManifestStore.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
// ---------------------------------------------------------------------------

async function orchestrateStatusOp(params: OrchestrateStatusParams) {
  return orchestrateStatus(params.epicId, getProjectRoot());
}

async function orchestrateNextOp(params: OrchestrateNextParams) {
  return orchestrateNext(params.epicId, getProjectRoot());
}

async function orchestrateReadyOp(params: OrchestrateReadyParams) {
  return orchestrateReady(params.epicId, getProjectRoot());
}

async function orchestrateAnalyzeOp(params: OrchestrateAnalyzeParams) {
  if (params.mode === 'parallel-safety') {
    return orchestrateAnalyzeParallelSafety(params.taskIds ?? [], getProjectRoot());
  }
  return orchestrateAnalyze(params.epicId, getProjectRoot(), params.mode);
}

async function orchestrateClassifyOp(params: OrchestrateClassifyParams) {
  return orchestrateClassify(params.request, params.context, getProjectRoot());
}

function orchestrateFanoutStatusOp(params: OrchestrateFanoutStatusParams) {
  const entry = fanoutManifestStore.get(params.manifestEntryId);
  if (!entry) {
    return Promise.resolve({
      success: true,
      data: {
        manifestEntryId: params.manifestEntryId,
        pending: [] as string[],
        running: [] as string[],
        complete: [] as string[],
        failed: [] as string[],
        found: false,
      },
    });
  }
  const spawned = entry.results.filter((r) => r.status === 'spawned').map((r) => r.taskId);
  const failed = entry.results.filter((r) => r.status === 'failed').map((r) => r.taskId);
  return Promise.resolve({
    success: true,
    data: {
      manifestEntryId: params.manifestEntryId,
      pending: [] as string[],
      running: spawned,
      complete: [] as string[],
      failed,
      found: true,
      completedAt: entry.completedAt,
    },
  });
}

async function orchestrateContextOp(params: OrchestrateContextParams) {
  return orchestrateContext(params.epicId, getProjectRoot());
}

async function orchestrateWavesOp(params: OrchestrateWavesParams) {
  return orchestrateWaves(params.epicId, getProjectRoot());
}

async function orchestratePlanOp(params: OrchestratePlanParams) {
  return orchestratePlan({
    epicId: params.epicId,
    projectRoot: getProjectRoot(),
    preferTier: params.preferTier,
  });
}

async function orchestrateBootstrapOp(params: OrchestrateBootstrapParams) {
  return orchestrateBootstrap(getProjectRoot(), { speed: params.speed });
}

async function orchestrateUnblockOp(_params: OrchestrateUnblockParams) {
  return orchestrateUnblockOpportunities(getProjectRoot());
}

async function orchestrateTesseraListOp(params: OrchestrateTesseraListParams) {
  return Promise.resolve({ success: true, data: params }); // sentinel — handled inline
}

async function orchestrateIvtrStatusOp(params: OrchestrateIvtrStatusParams) {
  return ivtrHandler.query('status', params);
}

async function orchestratePendingOp(_params: OrchestratePendingParams) {
  return Promise.resolve({ success: true, data: {} }); // sentinel — handled inline
}

async function orchestrateStartOp(params: OrchestrateStartParams) {
  return orchestrateStartup(params.epicId, getProjectRoot());
}

async function orchestrateSpawnOp(params: OrchestrateSpawnParams) {
  return orchestrateSpawn(
    params.taskId,
    params.protocolType,
    getProjectRoot(),
    params.tier,
    params.noWorktree,
  );
}

async function orchestrateHandoffOp(params: OrchestrateHandoffParams) {
  return orchestrateHandoff(
    {
      taskId: params.taskId,
      protocolType: params.protocolType,
      note: params.note,
      nextAction: params.nextAction,
      variant: params.variant,
      tier: params.tier,
      idempotencyKey: params.idempotencyKey,
    },
    getProjectRoot(),
  );
}

async function orchestrateSpawnExecuteOp(params: OrchestrateSpawnExecuteParams) {
  return orchestrateSpawnExecute(
    params.taskId,
    params.adapterId,
    params.protocolType,
    getProjectRoot(),
    params.tier,
  );
}

async function orchestrateValidateOp(params: OrchestrateValidateParams) {
  return orchestrateValidate(params.taskId, getProjectRoot());
}

async function orchestratePivotOp(params: OrchestratePivotParams) {
  try {
    const result = await pivotTask(params.fromTaskId, params.toTaskId, {
      reason: params.reason,
      blocksFrom: params.blocksFrom,
      projectRoot: getProjectRoot(),
    });
    return { success: true, data: result };
  } catch (err) {
    const code = (err as { code?: number })?.code;
    const message = err instanceof Error ? err.message : String(err);
    // Map ExitCode 38 (ACTIVE_TASK_REQUIRED) → spec-named E_NOT_ACTIVE
    let errorCode = 'E_GENERAL';
    if (code === 2) errorCode = 'E_INVALID_INPUT';
    else if (code === 4) errorCode = 'E_NOT_FOUND';
    else if (code === 6) errorCode = 'E_VALIDATION';
    else if (code === 38) errorCode = 'E_NOT_ACTIVE';
    return {
      success: false,
      error: { code: errorCode, message },
    };
  }
}

async function orchestrateWorktreeCompleteOp(params: OrchestrateWorktreeCompleteParams) {
  return handleWorktreeComplete(params.taskId, getProjectRoot());
}

async function orchestrateWorktreeCleanupOp(params: OrchestrateWorktreeCleanupParams) {
  return handleWorktreeCleanup(getProjectRoot(), params.taskIds);
}

async function orchestrateWorktreePruneOp(params: OrchestrateWorktreePruneParams) {
  return handleWorktreePrune(getProjectRoot(), params.taskId);
}

async function orchestrateParallelOp(params: OrchestrateParallelParams) {
  return Promise.resolve({ success: true, data: params }); // sentinel — handled inline via routeByParam
}

async function orchestrateFanoutOp(params: OrchestrateFanoutParams) {
  return orchestrateFanoutImpl(params.items, getProjectRoot());
}

async function orchestrateTesseraInstantiateOp(params: OrchestrateTesseraInstantiateParams) {
  return Promise.resolve({ success: true, data: params }); // sentinel — handled inline
}

async function orchestrateApproveOp(params: OrchestrateApproveParams) {
  return Promise.resolve({ success: true, data: params }); // sentinel — handled inline
}

async function orchestrateRejectOp(params: OrchestrateRejectParams) {
  return Promise.resolve({ success: true, data: params }); // sentinel — handled inline
}

// ---------------------------------------------------------------------------
// Core op registry — OpsFromCore inference source
// ---------------------------------------------------------------------------

/**
 * Orchestrate operation registry for `OpsFromCore<typeof coreOps>` inference.
 *
 * @task T1538 — orchestrate dispatch OpsFromCore migration
 */
const coreOps = {
  status: orchestrateStatusOp,
  next: orchestrateNextOp,
  ready: orchestrateReadyOp,
  analyze: orchestrateAnalyzeOp,
  classify: orchestrateClassifyOp,
  'fanout.status': orchestrateFanoutStatusOp,
  context: orchestrateContextOp,
  waves: orchestrateWavesOp,
  plan: orchestratePlanOp,
  bootstrap: orchestrateBootstrapOp,
  'unblock.opportunities': orchestrateUnblockOp,
  'tessera.list': orchestrateTesseraListOp,
  'ivtr.status': orchestrateIvtrStatusOp,
  pending: orchestratePendingOp,
  start: orchestrateStartOp,
  spawn: orchestrateSpawnOp,
  handoff: orchestrateHandoffOp,
  'spawn.execute': orchestrateSpawnExecuteOp,
  validate: orchestrateValidateOp,
  pivot: orchestratePivotOp,
  'worktree.complete': orchestrateWorktreeCompleteOp,
  'worktree.cleanup': orchestrateWorktreeCleanupOp,
  'worktree.prune': orchestrateWorktreePruneOp,
  parallel: orchestrateParallelOp,
  fanout: orchestrateFanoutOp,
  'tessera.instantiate': orchestrateTesseraInstantiateOp,
  approve: orchestrateApproveOp,
  reject: orchestrateRejectOp,
} as const;

// ---------------------------------------------------------------------------
// Typed operation record (public — for testing and downstream inference)
// ---------------------------------------------------------------------------

/** Inferred typed operation record for the orchestrate domain (ADR-058 · T1538). */
export type OrchestrateDispatchOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// OrchestrateHandler
// ---------------------------------------------------------------------------

export class OrchestrateHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const p: OrchestrateStatusParams = { epicId: params?.epicId as string | undefined };
          return wrapResult(await coreOps.status(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'next': {
          if (!params?.epicId)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const p: OrchestrateNextParams = { epicId: params.epicId as string };
          return wrapResult(await coreOps.next(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'ready': {
          if (!params?.epicId)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const p: OrchestrateReadyParams = { epicId: params.epicId as string };
          return wrapResult(await coreOps.ready(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'analyze': {
          const p: OrchestrateAnalyzeParams = {
            epicId: params?.epicId as string | undefined,
            mode: params?.mode as string | undefined,
            taskIds: params?.taskIds as string[] | undefined,
          };
          return wrapResult(await coreOps.analyze(p), 'query', 'orchestrate', 'analyze', startTime);
        }

        case 'classify': {
          if (!params?.request)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'request is required',
              startTime,
            );
          const p: OrchestrateClassifyParams = {
            request: params.request as string,
            context: params.context as string | undefined,
          };
          return wrapResult(
            await coreOps.classify(p),
            'query',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'fanout.status': {
          if (!params?.manifestEntryId)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'manifestEntryId is required',
              startTime,
            );
          const p: OrchestrateFanoutStatusParams = {
            manifestEntryId: params.manifestEntryId as string,
          };
          const result = await coreOps['fanout.status'](p);
          return {
            meta: dispatchMeta('query', 'orchestrate', operation, startTime),
            success: true,
            data: result.data,
          };
        }

        case 'context': {
          const p: OrchestrateContextParams = { epicId: params?.epicId as string | undefined };
          return wrapResult(await coreOps.context(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'waves': {
          if (!params?.epicId)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const p: OrchestrateWavesParams = { epicId: params.epicId as string };
          return wrapResult(await coreOps.waves(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'plan': {
          if (!params?.epicId)
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const preferTierRaw = params.preferTier;
          let preferTier: 0 | 1 | 2 | undefined;
          if (preferTierRaw === 0 || preferTierRaw === 1 || preferTierRaw === 2) {
            preferTier = preferTierRaw;
          }
          const p: OrchestratePlanParams = { epicId: params.epicId as string, preferTier };
          return wrapResult(await coreOps.plan(p), 'query', 'orchestrate', operation, startTime);
        }

        case 'bootstrap': {
          const p: OrchestrateBootstrapParams = {
            speed: params?.speed as 'fast' | 'full' | 'complete' | undefined,
          };
          return wrapResult(
            await coreOps.bootstrap(p),
            'query',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'unblock.opportunities':
          return wrapResult(
            await coreOps['unblock.opportunities']({}),
            'query',
            'orchestrate',
            operation,
            startTime,
          );

        case 'tessera.list': {
          const id = params?.id as string | undefined;
          if (id) {
            const template = showTessera(id);
            if (!template)
              return errorResult(
                'query',
                'orchestrate',
                'tessera.list',
                'E_NOT_FOUND',
                `Tessera template "${id}" not found`,
                startTime,
              );
            return {
              meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
              success: true,
              data: template,
            };
          }
          const templates = listTesseraTemplates();
          const { limit, offset } = getListParams(params);
          const page = paginate(templates, limit, offset);
          return {
            meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
            success: true,
            data: {
              templates: page.items,
              count: templates.length,
              total: templates.length,
              filtered: templates.length,
            },
            page: page.page,
          };
        }

        case 'ivtr.status':
          return ivtrHandler.query('status', params);

        case 'pending':
          return handlePendingApprovals(startTime);

        default:
          return errorResult(
            'query',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'query', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'orchestrate', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          if (!params?.epicId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const p: OrchestrateStartParams = { epicId: params.epicId as string };
          return wrapResult(await coreOps.start(p), 'mutate', 'orchestrate', operation, startTime);
        }

        case 'spawn': {
          if (!params?.taskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const tierRaw = params.tier;
          const tier =
            tierRaw === 0 || tierRaw === 1 || tierRaw === 2 ? (tierRaw as 0 | 1 | 2) : undefined;
          const p: OrchestrateSpawnParams = {
            taskId: params.taskId as string,
            protocolType: params.protocolType as string | undefined,
            tier,
            noWorktree: params.noWorktree as boolean | undefined,
          };
          return wrapResult(await coreOps.spawn(p), 'mutate', 'orchestrate', operation, startTime);
        }

        case 'handoff': {
          if (!params?.taskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          if (!params?.protocolType)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'protocolType is required',
              startTime,
            );
          const tierRaw = params.tier;
          const tier =
            tierRaw === 0 || tierRaw === 1 || tierRaw === 2 ? (tierRaw as 0 | 1 | 2) : undefined;
          const p: OrchestrateHandoffParams = {
            taskId: params.taskId as string,
            protocolType: params.protocolType as string,
            note: params.note as string | undefined,
            nextAction: params.nextAction as string | undefined,
            variant: params.variant as string | undefined,
            tier,
            idempotencyKey: params.idempotencyKey as string | undefined,
          };
          return wrapResult(
            await coreOps.handoff(p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'spawn.execute': {
          if (!params?.taskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const tierRaw = params.tier;
          const tier =
            tierRaw === 0 || tierRaw === 1 || tierRaw === 2 ? (tierRaw as 0 | 1 | 2) : undefined;
          const p: OrchestrateSpawnExecuteParams = {
            taskId: params.taskId as string,
            adapterId: params.adapterId as string | undefined,
            protocolType: params.protocolType as string | undefined,
            tier,
          };
          return wrapResult(
            await coreOps['spawn.execute'](p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'validate': {
          if (!params?.taskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const p: OrchestrateValidateParams = { taskId: params.taskId as string };
          return wrapResult(
            await coreOps.validate(p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'pivot': {
          if (!params?.fromTaskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'fromTaskId is required',
              startTime,
            );
          if (!params?.toTaskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'toTaskId is required',
              startTime,
            );
          if (!params?.reason || typeof params.reason !== 'string' || !params.reason.trim())
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_VALIDATION',
              'reason is required (no silent pivots)',
              startTime,
            );
          const p: OrchestratePivotParams = {
            fromTaskId: params.fromTaskId as string,
            toTaskId: params.toTaskId as string,
            reason: params.reason as string,
            blocksFrom: params.blocksFrom as boolean | undefined,
          };
          return wrapResult(await coreOps.pivot(p), 'mutate', 'orchestrate', operation, startTime);
        }

        case 'worktree.complete': {
          if (!params?.taskId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          const p: OrchestrateWorktreeCompleteParams = { taskId: params.taskId as string };
          return wrapResult(
            await coreOps['worktree.complete'](p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'worktree.cleanup': {
          const p: OrchestrateWorktreeCleanupParams = {
            taskIds: params?.taskIds as string[] | undefined,
          };
          return wrapResult(
            await coreOps['worktree.cleanup'](p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'worktree.prune': {
          const p: OrchestrateWorktreePruneParams = {
            taskId: params?.taskId as string | undefined,
          };
          return wrapResult(
            await coreOps['worktree.prune'](p),
            'mutate',
            'orchestrate',
            operation,
            startTime,
          );
        }

        case 'parallel': {
          return routeByParam(params, 'action', {
            start: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId)
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              if (wave === undefined || wave === null)
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              return wrapResult(
                await orchestrateParallelStart(epicId, wave, getProjectRoot()),
                'mutate',
                'orchestrate',
                'parallel',
                startTime,
              );
            },
            end: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId)
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              if (wave === undefined || wave === null)
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              return wrapResult(
                await orchestrateParallelEnd(epicId, wave, getProjectRoot()),
                'mutate',
                'orchestrate',
                'parallel',
                startTime,
              );
            },
          });
        }

        case 'fanout': {
          const items = params?.items as
            | Array<{ team: string; taskId: string; skill?: string }>
            | undefined;
          if (!items || !Array.isArray(items) || items.length === 0)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'items array is required and must be non-empty',
              startTime,
            );
          const p: OrchestrateFanoutParams = { items };
          return wrapResult(await coreOps.fanout(p), 'mutate', 'orchestrate', operation, startTime);
        }

        case 'tessera.instantiate': {
          if (!params?.templateId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'templateId is required',
              startTime,
            );
          if (!params?.epicId)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          const template = showTessera(params.templateId as string);
          if (!template)
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_NOT_FOUND',
              `Tessera template "${params.templateId}" not found`,
              startTime,
            );
          const variables = (params.variables as Record<string, unknown>) ?? {};
          const epicId = params.epicId as string;
          const instance = await instantiateTessera(
            template,
            {
              templateId: params.templateId as string,
              epicId,
              variables: { epicId, ...variables },
            },
            getProjectRoot(),
          );
          return {
            meta: dispatchMeta('mutate', 'orchestrate', operation, startTime),
            success: true,
            data: instance,
          };
        }

        case 'ivtr.start':
          return ivtrHandler.mutate('start', params);
        case 'ivtr.next':
          return ivtrHandler.mutate('next', params);
        case 'ivtr.release':
          return ivtrHandler.mutate('release', params);
        case 'ivtr.loop-back':
          return ivtrHandler.mutate('loop-back', params);

        case 'approve':
          return handleApproveGate(params, startTime);
        case 'reject':
          return handleRejectGate(params, startTime);

        default:
          return errorResult(
            'mutate',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'mutate', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'orchestrate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status',
        'next',
        'ready',
        'analyze',
        'context',
        'waves',
        'plan',
        'bootstrap',
        'unblock.opportunities',
        'tessera.list',
        'classify',
        'fanout.status',
        'ivtr.status',
        'pending',
      ],
      mutate: [
        'start',
        'spawn',
        'handoff',
        'spawn.execute',
        'validate',
        'pivot',
        'parallel',
        'tessera.instantiate',
        'fanout',
        'ivtr.start',
        'ivtr.next',
        'ivtr.release',
        'ivtr.loop-back',
        'approve',
        'reject',
        'worktree.complete',
        'worktree.cleanup',
        'worktree.prune',
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Wave 7a handler functions (T408, T409, T410)
// ---------------------------------------------------------------------------

/**
 * T408 — Classify a request against the CANT team registry.
 *
 * @param request - The request text to classify.
 * @param context - Optional additional context.
 * @param projectRoot - Project root directory.
 */
async function orchestrateClassify(
  request: string,
  context: string | undefined,
  projectRoot: string,
): Promise<{ success: boolean; data?: ClassifyResult; error?: { code: string; message: string } }> {
  try {
    const { getCleoCantWorkflowsDir } = await import('@cleocode/core/internal');
    const { readFileSync, readdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const workflowsDir = getCleoCantWorkflowsDir();
    const combined = `${request} ${context ?? ''}`.toLowerCase();

    const matches: Array<{ team: string; score: number; consultWhen: string; stages: string[] }> =
      [];

    if (existsSync(workflowsDir)) {
      const files = readdirSync(workflowsDir).filter((f: string) => f.endsWith('.cant'));
      for (const file of files) {
        try {
          const src = readFileSync(join(workflowsDir, file), 'utf-8');
          const teamMatch = /^team\s+(\S+):/m.exec(src);
          if (!teamMatch) continue;
          const teamName = teamMatch[1]!;
          const cwMatch = /consult-when:\s*["']?(.+?)["']?\s*$/m.exec(src);
          const consultWhen = cwMatch ? cwMatch[1]!.trim() : '';
          const stagesMatch = /stages:\s*\[([^\]]+)\]/.exec(src);
          const stages = stagesMatch ? stagesMatch[1]!.split(',').map((s: string) => s.trim()) : [];
          const hintWords = consultWhen.toLowerCase().split(/\s+/);
          const score = hintWords.filter((w: string) => combined.includes(w)).length;
          matches.push({ team: teamName, score, consultWhen, stages });
        } catch {
          // skip unreadable files
        }
      }
    }

    const localCantDir = join(projectRoot, CLEO_DIR_NAME, WORKFLOWS_SUBDIR);
    if (existsSync(localCantDir)) {
      const files = readdirSync(localCantDir).filter((f: string) => f.endsWith('.cant'));
      for (const file of files) {
        try {
          const src = readFileSync(join(localCantDir, file), 'utf-8');
          const teamMatch = /^team\s+(\S+):/m.exec(src);
          if (!teamMatch) continue;
          const teamName = teamMatch[1]!;
          const cwMatch = /consult-when:\s*["']?(.+?)["']?\s*$/m.exec(src);
          const consultWhen = cwMatch ? cwMatch[1]!.trim() : '';
          const stagesMatch = /stages:\s*\[([^\]]+)\]/.exec(src);
          const stages = stagesMatch ? stagesMatch[1]!.split(',').map((s: string) => s.trim()) : [];
          const hintWords = consultWhen.toLowerCase().split(/\s+/);
          const score = hintWords.filter((w: string) => combined.includes(w)).length;
          matches.push({ team: teamName, score, consultWhen, stages });
        } catch {
          // skip
        }
      }
    }

    if (matches.length === 0) {
      return {
        success: true,
        data: {
          team: null,
          lead: null,
          protocol: null,
          stage: null,
          confidence: 0,
          reasoning:
            'No CANT team definitions found. Seed teams.cant in the global workflows dir (W7b runtime enforcement) to enable team routing.',
        },
      };
    }

    matches.sort((a, b) => b.score - a.score);
    const best = matches[0]!;
    return {
      success: true,
      data: {
        team: best.team,
        lead: null,
        protocol: 'base-subagent',
        stage: best.stages[0] ?? null,
        confidence: best.score > 0 ? 0.5 : 0.1,
        reasoning:
          best.score > 0
            ? `Matched team '${best.team}' via consult-when hint: "${best.consultWhen}"`
            : `No strong match found; defaulting to first registered team '${best.team}'`,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'classify', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_CLASSIFY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * T409 / T433 — Fan out N spawn requests via Promise.allSettled.
 */
async function orchestrateFanoutImpl(
  items: FanoutItem[],
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const manifestEntryId = `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const settled = await Promise.allSettled(
      items.map(async (item): Promise<FanoutItemResult> => {
        const spawnResult = await orchestrateSpawnExecute(
          item.taskId,
          undefined,
          undefined,
          projectRoot,
          undefined,
        );
        if (!spawnResult.success) {
          return {
            taskId: item.taskId,
            status: 'failed',
            error: spawnResult.error?.message ?? `Spawn failed for task ${item.taskId}`,
          };
        }
        const data = spawnResult.data as Record<string, unknown> | undefined;
        return {
          taskId: item.taskId,
          status: 'spawned',
          instanceId: typeof data?.instanceId === 'string' ? data.instanceId : undefined,
        };
      }),
    );

    const results: FanoutItemResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      return {
        taskId: items[i]!.taskId,
        status: 'failed',
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    });

    fanoutManifestStore.set(manifestEntryId, { results, completedAt: new Date().toISOString() });
    evictFanoutManifest();

    return {
      success: true,
      data: {
        manifestEntryId,
        results,
        total: items.length,
        spawned: results.filter((r) => r.status === 'spawned').length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'fanout', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_FANOUT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * T410 — Analyze a list of tasks for parallel safety.
 */
async function orchestrateAnalyzeParallelSafety(
  taskIds: string[],
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  if (taskIds.length === 0) {
    return {
      success: true,
      data: {
        parallelSafe: true,
        groups: [] as string[][],
        note: 'No tasks provided — trivially parallel-safe',
      },
    };
  }

  try {
    const { getAccessor } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const result = await accessor.queryTasks({});
    const allTasks = result?.tasks ?? [];

    const depMap = new Map<string, string[]>();
    for (const t of allTasks) {
      const deps: string[] = (t as { blockers?: string[] }).blockers ?? [];
      depMap.set(t.id, deps);
    }

    function transitiveClose(id: string, visited = new Set<string>()): Set<string> {
      if (visited.has(id)) return visited;
      visited.add(id);
      const deps = depMap.get(id) ?? [];
      for (const dep of deps) {
        transitiveClose(dep, visited);
      }
      return visited;
    }

    const closures = new Map<string, Set<string>>();
    for (const id of taskIds) {
      closures.set(id, transitiveClose(id));
    }

    function parallelSafe(a: string, b: string): boolean {
      const closureA = closures.get(a) ?? new Set();
      const closureB = closures.get(b) ?? new Set();
      return !closureA.has(b) && !closureB.has(a);
    }

    const groups: string[][] = [];
    for (const id of taskIds) {
      let placed = false;
      for (const group of groups) {
        if (group.every((member) => parallelSafe(id, member))) {
          group.push(id);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([id]);
      }
    }

    return {
      success: true,
      data: {
        parallelSafe: groups.length <= 1,
        groups,
        taskCount: taskIds.length,
        groupCount: groups.length,
      },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'analyze/parallel-safety', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_ANALYZE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// T1118 L1 — Worktree lifecycle handlers
// ---------------------------------------------------------------------------

async function handleWorktreeComplete(
  taskId: string,
  projectRoot: string,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const { completeAgentWorktree } = await import('@cleocode/core/internal');
    const result = completeAgentWorktree(taskId, projectRoot);
    return { success: true, data: result };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'worktree.complete', taskId, err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_WORKTREE_COMPLETE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleWorktreeCleanup(
  projectRoot: string,
  taskIds: string[] | undefined,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const { pruneOrphanedWorktrees } = await import('@cleocode/core/internal');
    const activeSet = taskIds ? new Set(taskIds) : undefined;
    const result = pruneOrphanedWorktrees(projectRoot, activeSet);
    return { success: true, data: result };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'worktree.cleanup', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_WORKTREE_CLEANUP_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleWorktreePrune(
  projectRoot: string,
  taskId: string | undefined,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const { pruneWorktree, pruneOrphanedWorktrees } = await import('@cleocode/core/internal');
    if (taskId) {
      const result = pruneWorktree(taskId, projectRoot);
      return { success: true, data: result };
    }
    const result = pruneOrphanedWorktrees(projectRoot, undefined);
    return { success: true, data: { ...result, mode: 'bulk' } };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'worktree.prune', taskId, err: error },
      error instanceof Error ? error.message : String(error),
    );
    return {
      success: false,
      error: {
        code: 'E_WORKTREE_PRUNE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// T935 — HITL approval gate handlers
// ---------------------------------------------------------------------------

async function handlePendingApprovals(startTime: number): Promise<DispatchResponse> {
  try {
    const approvals = await listPendingApprovalsForDispatch();
    return {
      meta: dispatchMeta('query', 'orchestrate', 'pending', startTime),
      success: true,
      data: { approvals, count: approvals.length, total: approvals.length },
    };
  } catch (error) {
    getLogger('domain:orchestrate').error(
      { operation: 'pending', err: error },
      error instanceof Error ? error.message : String(error),
    );
    return handleErrorResult('query', 'orchestrate', 'pending', error, startTime);
  }
}

async function handleApproveGate(
  params: Record<string, unknown> | undefined,
  startTime: number,
): Promise<DispatchResponse> {
  const resumeToken = params?.resumeToken as string | undefined;
  if (!resumeToken)
    return errorResult(
      'mutate',
      'orchestrate',
      'approve',
      'E_VALIDATION',
      'resumeToken is required',
      startTime,
    );

  const approver =
    typeof params?.approver === 'string' && params.approver.length > 0
      ? params.approver
      : 'cli-user';
  const reason = typeof params?.reason === 'string' ? params.reason : undefined;

  try {
    const existing = await lookupApprovalByTokenForDispatch(resumeToken);
    if (existing === null)
      return errorResult(
        'mutate',
        'orchestrate',
        'approve',
        'E_APPROVAL_NOT_FOUND',
        `no approval gate for token ${resumeToken}`,
        startTime,
      );

    if (existing.status === 'approved') {
      return {
        meta: dispatchMeta('mutate', 'orchestrate', 'approve', startTime),
        success: true,
        data: { ...existing, idempotent: true },
      };
    }
    if (existing.status === 'rejected')
      return errorResult(
        'mutate',
        'orchestrate',
        'approve',
        'E_APPROVAL_ALREADY_DECIDED',
        `gate ${existing.approvalId} was rejected${existing.reason ? ` (${existing.reason})` : ''}`,
        startTime,
      );

    const db = await acquirePlaybookDb();
    const { approveGate } = await import('@cleocode/playbooks');
    const updated = approveGate(db, resumeToken, approver, reason);
    return {
      meta: dispatchMeta('mutate', 'orchestrate', 'approve', startTime),
      success: true,
      data: updated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('E_APPROVAL_ALREADY_DECIDED'))
      return errorResult(
        'mutate',
        'orchestrate',
        'approve',
        'E_APPROVAL_ALREADY_DECIDED',
        message,
        startTime,
      );
    if (message.includes('E_APPROVAL_NOT_FOUND'))
      return errorResult(
        'mutate',
        'orchestrate',
        'approve',
        'E_APPROVAL_NOT_FOUND',
        message,
        startTime,
      );
    getLogger('domain:orchestrate').error({ operation: 'approve', err: error }, message);
    return handleErrorResult('mutate', 'orchestrate', 'approve', error, startTime);
  }
}

async function handleRejectGate(
  params: Record<string, unknown> | undefined,
  startTime: number,
): Promise<DispatchResponse> {
  const resumeToken = params?.resumeToken as string | undefined;
  if (!resumeToken)
    return errorResult(
      'mutate',
      'orchestrate',
      'reject',
      'E_VALIDATION',
      'resumeToken is required',
      startTime,
    );

  const reason = typeof params?.reason === 'string' ? params.reason.trim() : '';
  if (reason.length === 0)
    return errorResult(
      'mutate',
      'orchestrate',
      'reject',
      'E_VALIDATION',
      'reason is required for rejection',
      startTime,
    );

  const approver =
    typeof params?.approver === 'string' && params.approver.length > 0
      ? params.approver
      : 'cli-user';

  try {
    const existing = await lookupApprovalByTokenForDispatch(resumeToken);
    if (existing === null)
      return errorResult(
        'mutate',
        'orchestrate',
        'reject',
        'E_APPROVAL_NOT_FOUND',
        `no approval gate for token ${resumeToken}`,
        startTime,
      );

    if (existing.status === 'rejected') {
      return {
        meta: dispatchMeta('mutate', 'orchestrate', 'reject', startTime),
        success: true,
        data: { ...existing, idempotent: true },
      };
    }
    if (existing.status === 'approved')
      return errorResult(
        'mutate',
        'orchestrate',
        'reject',
        'E_APPROVAL_ALREADY_DECIDED',
        `gate ${existing.approvalId} was already approved`,
        startTime,
      );

    const db = await acquirePlaybookDb();
    const { rejectGate } = await import('@cleocode/playbooks');
    const updated = rejectGate(db, resumeToken, approver, reason);
    return {
      meta: dispatchMeta('mutate', 'orchestrate', 'reject', startTime),
      success: true,
      data: updated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('E_APPROVAL_ALREADY_DECIDED'))
      return errorResult(
        'mutate',
        'orchestrate',
        'reject',
        'E_APPROVAL_ALREADY_DECIDED',
        message,
        startTime,
      );
    if (message.includes('E_APPROVAL_NOT_FOUND'))
      return errorResult(
        'mutate',
        'orchestrate',
        'reject',
        'E_APPROVAL_NOT_FOUND',
        message,
        startTime,
      );
    getLogger('domain:orchestrate').error({ operation: 'reject', err: error }, message);
    return handleErrorResult('mutate', 'orchestrate', 'reject', error, startTime);
  }
}
