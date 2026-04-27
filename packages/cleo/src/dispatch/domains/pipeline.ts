/**
 * Pipeline Domain Handler (Dispatch Layer)
 *
 * Consolidates legacy lifecycle and release domains into a single "pipeline"
 * domain with dot-prefixed operation names. All operations delegate to
 * native engine functions from the respective dispatch engines.
 *
 * Sub-domains:
 *   stage.*    - RCASD-IVTR+C lifecycle stage management
 *   release.*  - Release lifecycle (prepare, changelog, commit, tag, push)
 *   manifest.* - Research manifest (JSONL) operations
 *   phase.*    - Project phase management
 *   chain.*    - Warp-chain operations (T5405)
 *
 * Uses typed-handler pattern (Wave D · T975) for compile-time param narrowing.
 * Param extraction is type-safe via OpsFromCore<typeof coreOps> inference.
 * Zero `as string` / `as unknown` param casts in per-op code.
 *
 * @epic T4820
 * @task T1441 — OpsFromCore inference migration
 * @task T1435 — Wave 1 dispatch refactor
 */

import { execFileSync } from 'node:child_process';
import type { GateResult, WarpChain } from '@cleocode/contracts';
import {
  addChain,
  advanceInstance,
  buildStageGuidance,
  channelToDistTag,
  createInstance,
  describeChannel,
  formatStageGuidance,
  getLogger,
  getProjectRoot,
  isValidStage,
  type ListPhasesResult,
  listChains,
  paginate,
  type ReleaseListOptions,
  resolveChannelFromBranch,
  type Stage,
  showChain,
} from '@cleocode/core/internal';
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
  wrapCoreResult,
} from '../adapters/typed.js';
import {
  lifecycleCheck,
  lifecycleGateFail,
  lifecycleGatePass,
  lifecycleHistory,
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
  lifecycleStatus,
  phaseAdvance,
  phaseComplete,
  phaseDelete,
  phaseList,
  phaseRename,
  phaseSet,
  phaseShow,
  phaseStart,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestFind,
  pipelineManifestList,
  pipelineManifestShow,
  pipelineManifestStats,
  releaseCancel,
  releaseChangelogSince,
  releaseList,
  releaseRollback,
  releaseRollbackFull,
  releaseShip,
  releaseShow,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, getListParams, handleErrorResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// Core operation registry — single-param wrappers that bind projectRoot.
//
// Each wrapper captures getProjectRoot() at call time (not at module load) and
// maps the positional engine function into a single-object-param shape that
// OpsFromCore can infer. This is the canonical "thin dispatch" pattern used in
// session.ts and sentient.ts (Wave D · T975 / T1435).
// ---------------------------------------------------------------------------

// ---- Stage wrapper types ---------------------------------------------------

type StageValidateParams = { epicId: string; targetStage: string };
type StageStatusParams = { epicId: string };
type StageHistoryParams = { taskId: string };
type StageGuidanceParams = { stage?: string; epicId?: string; format?: string };
type StageRecordParams = { taskId: string; stage: string; status: string; notes?: string };
type StageSkipParams = { taskId: string; stage: string; reason: string };
type StageResetParams = { taskId: string; stage: string; reason: string };
type StageGatePassParams = { taskId: string; gateName: string; agent?: string; notes?: string };
type StageGateFailParams = { taskId: string; gateName: string; reason?: string };

// ---- Release wrapper types -------------------------------------------------

type ReleaseListParams = { status?: ReleaseListOptions['status']; limit?: number; offset?: number };
type ReleaseShowParams = { version: string };
type ReleaseChannelShowParams = Record<string, never>;
type ReleaseChangelogSinceParams = { sinceTag: string };
type ReleaseShipParams = {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
  bump?: boolean;
  force?: boolean;
};
type ReleaseCancelParams = { version: string };
type ReleaseRollbackParams = { version: string; reason?: string };
type ReleaseRollbackFullParams = {
  version: string;
  reason?: string;
  force?: boolean;
  unpublish?: boolean;
};

// ---- Manifest wrapper types ------------------------------------------------

type ManifestShowParams = { entryId: string };
type ManifestListParams = Parameters<typeof pipelineManifestList>[0];
type ManifestFindParams = { query: string; confidence?: number; limit?: number };
type ManifestStatsParams = { epicId?: string };
type ManifestAppendParams = { entry: Parameters<typeof pipelineManifestAppend>[0] };
type ManifestArchiveParams = { beforeDate: string };

// ---- Phase wrapper types ---------------------------------------------------

type PhaseShowParams = { phaseId?: string };
type PhaseListParams = Record<string, never>;
type PhaseSetParams = {
  phaseId: string;
  action?: string;
  rollback?: boolean;
  force?: boolean;
  dryRun?: boolean;
};
type PhaseAdvanceParams = { force?: boolean };
type PhaseRenameParams = { oldName: string; newName: string };
type PhaseDeleteParams = { phaseId: string; reassignTo?: string; force?: boolean };

// ---- Chain wrapper types ---------------------------------------------------

type ChainShowParams = { chainId: string };
type ChainListParams = { limit?: number; offset?: number };
type ChainAddParams = { chain: WarpChain };
type ChainInstantiateParams = {
  chainId: string;
  epicId: string;
  variables?: Record<string, unknown>;
  stageToTask?: Record<string, string>;
};
type ChainAdvanceParams = { instanceId: string; nextStage: string; gateResults?: GateResult[] };

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
// ---------------------------------------------------------------------------

async function stageValidateOp(params: StageValidateParams) {
  return lifecycleCheck(params.epicId, params.targetStage, getProjectRoot());
}

async function stageStatusOp(params: StageStatusParams) {
  return lifecycleStatus(params.epicId, getProjectRoot());
}

async function stageHistoryOp(params: StageHistoryParams) {
  return lifecycleHistory(params.taskId, getProjectRoot());
}

async function stageGuidanceOp(params: StageGuidanceParams) {
  // Perform the full guidance resolution here so OpsFromCore correctly infers
  // params as StageGuidanceParams (not a sentinel wrapper shape).
  let stage = params.stage;
  const epicId = params.epicId;
  const format = params.format ?? 'markdown';
  const projectRoot = getProjectRoot();

  if (!stage && epicId) {
    const statusResult = await lifecycleStatus(epicId, projectRoot);
    if (statusResult.success) {
      const data = statusResult.data as { currentStage?: string; activeStage?: string } | undefined;
      stage = data?.currentStage ?? data?.activeStage;
    }
  }

  return { _stage: stage, _format: format, _projectRoot: projectRoot };
}

async function stageRecordOp(params: StageRecordParams) {
  return lifecycleProgress(
    params.taskId,
    params.stage,
    params.status,
    params.notes,
    getProjectRoot(),
  );
}

async function stageSkipOp(params: StageSkipParams) {
  return lifecycleSkip(params.taskId, params.stage, params.reason, getProjectRoot());
}

async function stageResetOp(params: StageResetParams) {
  return lifecycleReset(params.taskId, params.stage, params.reason, getProjectRoot());
}

async function stageGatePassOp(params: StageGatePassParams) {
  return lifecycleGatePass(
    params.taskId,
    params.gateName,
    params.agent,
    params.notes,
    getProjectRoot(),
  );
}

async function stageGateFailOp(params: StageGateFailParams) {
  return lifecycleGateFail(params.taskId, params.gateName, params.reason, getProjectRoot());
}

async function releaseListOp(params: ReleaseListParams) {
  return releaseList(
    { status: params.status, limit: params.limit, offset: params.offset },
    getProjectRoot(),
  );
}

async function releaseShowOp(params: ReleaseShowParams) {
  return releaseShow(params.version, getProjectRoot());
}

async function releaseChannelShowOp(_params: ReleaseChannelShowParams) {
  let currentBranch = 'unknown';
  const projectRoot = getProjectRoot();
  try {
    currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: projectRoot,
    }).trim();
  } catch {
    // git not available or not a git repo — leave as 'unknown'
  }
  const resolvedChannel = resolveChannelFromBranch(currentBranch);
  const distTag = channelToDistTag(resolvedChannel);
  const description = describeChannel(resolvedChannel);
  return {
    success: true as const,
    data: { branch: currentBranch, channel: resolvedChannel, distTag, description },
  };
}

async function releaseChangelogSinceOp(params: ReleaseChangelogSinceParams) {
  return releaseChangelogSince(params.sinceTag, getProjectRoot());
}

async function releaseShipOp(params: ReleaseShipParams) {
  return releaseShip(
    {
      version: params.version,
      epicId: params.epicId,
      remote: params.remote,
      dryRun: params.dryRun,
      bump: params.bump,
      force: params.force,
    },
    getProjectRoot(),
  );
}

async function releaseCancelOp(params: ReleaseCancelParams) {
  return releaseCancel(params.version, getProjectRoot());
}

async function releaseRollbackOp(params: ReleaseRollbackParams) {
  return releaseRollback(params.version, params.reason, getProjectRoot());
}

async function releaseRollbackFullOp(params: ReleaseRollbackFullParams) {
  return releaseRollbackFull(
    params.version,
    { reason: params.reason, force: params.force, unpublish: params.unpublish },
    getProjectRoot(),
  );
}

async function manifestShowOp(params: ManifestShowParams) {
  return pipelineManifestShow(params.entryId, getProjectRoot());
}

async function manifestListOp(params: ManifestListParams) {
  return pipelineManifestList(params, getProjectRoot());
}

async function manifestFindOp(params: ManifestFindParams) {
  return pipelineManifestFind(
    params.query,
    { confidence: params.confidence, limit: params.limit },
    getProjectRoot(),
  );
}

async function manifestStatsOp(params: ManifestStatsParams) {
  return pipelineManifestStats(params.epicId, getProjectRoot());
}

async function manifestAppendOp(params: ManifestAppendParams) {
  return pipelineManifestAppend(params.entry, getProjectRoot());
}

async function manifestArchiveOp(params: ManifestArchiveParams) {
  return pipelineManifestArchive(params.beforeDate, getProjectRoot());
}

async function phaseShowOp(params: PhaseShowParams) {
  return phaseShow(params.phaseId, getProjectRoot());
}

async function phaseListOp(_params: PhaseListParams) {
  return phaseList(getProjectRoot());
}

async function phaseSetOp(params: PhaseSetParams) {
  const { phaseId, action, rollback, force, dryRun } = params;
  const projectRoot = getProjectRoot();
  if (action === 'start') {
    return phaseStart(phaseId, projectRoot);
  }
  if (action === 'complete') {
    return phaseComplete(phaseId, projectRoot);
  }
  return phaseSet({ phaseId, rollback, force, dryRun }, projectRoot);
}

async function phaseAdvanceOp(params: PhaseAdvanceParams) {
  return phaseAdvance(params.force, getProjectRoot());
}

async function phaseRenameOp(params: PhaseRenameParams) {
  return phaseRename(params.oldName, params.newName, getProjectRoot());
}

async function phaseDeleteOp(params: PhaseDeleteParams) {
  return phaseDelete(
    params.phaseId,
    { reassignTo: params.reassignTo, force: params.force },
    getProjectRoot(),
  );
}

async function chainShowOp(params: ChainShowParams) {
  const chain = await showChain(params.chainId, getProjectRoot());
  // Return both chain and chainId so typed handler can produce E_NOT_FOUND.
  return { _chain: chain, _chainId: params.chainId };
}

async function chainListOp(_params: ChainListParams) {
  // Return raw chains; outer query() applies pagination to avoid LAFSPage type conflicts.
  const chains = await listChains(getProjectRoot());
  return { _chains: chains };
}

async function chainAddOp(params: ChainAddParams) {
  await addChain(params.chain, getProjectRoot());
  return { id: params.chain.id };
}

async function chainInstantiateOp(params: ChainInstantiateParams) {
  return createInstance(
    {
      chainId: params.chainId,
      epicId: params.epicId,
      variables: params.variables,
      stageToTask: params.stageToTask,
    },
    getProjectRoot(),
  );
}

async function chainAdvanceOp(params: ChainAdvanceParams) {
  return advanceInstance(
    params.instanceId,
    params.nextStage,
    params.gateResults ?? [],
    getProjectRoot(),
  );
}

// ---------------------------------------------------------------------------
// Core ops registry
// ---------------------------------------------------------------------------

const coreOps = {
  'stage.validate': stageValidateOp,
  'stage.status': stageStatusOp,
  'stage.history': stageHistoryOp,
  'stage.guidance': stageGuidanceOp,
  'stage.record': stageRecordOp,
  'stage.skip': stageSkipOp,
  'stage.reset': stageResetOp,
  'stage.gate.pass': stageGatePassOp,
  'stage.gate.fail': stageGateFailOp,
  'release.list': releaseListOp,
  'release.show': releaseShowOp,
  'release.channel.show': releaseChannelShowOp,
  'release.changelog.since': releaseChangelogSinceOp,
  'release.ship': releaseShipOp,
  'release.cancel': releaseCancelOp,
  'release.rollback': releaseRollbackOp,
  'release.rollback.full': releaseRollbackFullOp,
  'manifest.show': manifestShowOp,
  'manifest.list': manifestListOp,
  'manifest.find': manifestFindOp,
  'manifest.stats': manifestStatsOp,
  'manifest.append': manifestAppendOp,
  'manifest.archive': manifestArchiveOp,
  'phase.show': phaseShowOp,
  'phase.list': phaseListOp,
  'phase.set': phaseSetOp,
  'phase.advance': phaseAdvanceOp,
  'phase.rename': phaseRenameOp,
  'phase.delete': phaseDeleteOp,
  'chain.show': chainShowOp,
  'chain.list': chainListOp,
  'chain.add': chainAddOp,
  'chain.instantiate': chainInstantiateOp,
  'chain.advance': chainAdvanceOp,
} as const;

/** Inferred typed operation record for the pipeline domain (Wave D · T1441). */
export type PipelineOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1441)
// ---------------------------------------------------------------------------

const _pipelineTypedHandler = defineTypedHandler<PipelineOps>('pipeline', {
  // -------------------------------------------------------------------------
  // Stage queries
  // -------------------------------------------------------------------------

  'stage.validate': async (params: PipelineOps['stage.validate'][0]) => {
    if (!params.epicId || !params.targetStage) {
      return lafsError('E_INVALID_INPUT', 'epicId and targetStage are required', 'stage.validate');
    }
    return wrapCoreResult(await coreOps['stage.validate'](params), 'stage.validate');
  },

  'stage.status': async (params: PipelineOps['stage.status'][0]) => {
    if (!params.epicId) {
      return lafsError('E_INVALID_INPUT', 'epicId is required', 'stage.status');
    }
    return wrapCoreResult(await coreOps['stage.status'](params), 'stage.status');
  },

  'stage.history': async (params: PipelineOps['stage.history'][0]) => {
    if (!params.taskId) {
      return lafsError('E_INVALID_INPUT', 'taskId is required', 'stage.history');
    }
    return wrapCoreResult(await coreOps['stage.history'](params), 'stage.history');
  },

  // SSoT-EXEMPT: sentinel-unwrap from stageGuidanceOp + isValidStage + buildStageGuidance
  // + formatStageGuidance — Core fn returns an intermediate sentinel shape; dispatch
  // cannot simply delegate and wrap — ADR-058
  'stage.guidance': async (params: PipelineOps['stage.guidance'][0]) => {
    // stage.guidance — stageGuidanceOp resolves the stage from epicId and returns
    // a { _stage, _format, _projectRoot } sentinel. Validation and guidance
    // building happen here after unwrapping.
    const {
      _stage: stage,
      _format: format,
      _projectRoot: projectRoot,
    } = await coreOps['stage.guidance'](params);

    if (!stage) {
      return lafsError(
        'E_INVALID_INPUT',
        'Either stage or epicId (with an active pipeline stage) is required',
        'stage.guidance',
      );
    }

    if (!isValidStage(stage)) {
      return lafsError('E_INVALID_INPUT', `Unknown stage: ${stage}`, 'stage.guidance');
    }

    const guidance = buildStageGuidance(stage as Stage, projectRoot);
    const data =
      format === 'json'
        ? { stage: guidance.stage, guidance }
        : {
            stage: guidance.stage,
            name: guidance.name,
            order: guidance.order,
            primarySkill: guidance.primarySkill,
            loadedSkills: guidance.loadedSkills,
            requiredGates: guidance.requiredGates,
            expectedArtifacts: guidance.expectedArtifacts,
            source: guidance.source,
            prompt: formatStageGuidance(guidance),
          };

    return lafsSuccess(data, 'stage.guidance');
  },

  // -------------------------------------------------------------------------
  // Stage mutations
  // -------------------------------------------------------------------------

  'stage.record': async (params: PipelineOps['stage.record'][0]) => {
    if (!params.taskId || !params.stage || !params.status) {
      return lafsError('E_INVALID_INPUT', 'taskId, stage, and status are required', 'stage.record');
    }
    return wrapCoreResult(await coreOps['stage.record'](params), 'stage.record');
  },

  'stage.skip': async (params: PipelineOps['stage.skip'][0]) => {
    if (!params.taskId || !params.stage || !params.reason) {
      return lafsError('E_INVALID_INPUT', 'taskId, stage, and reason are required', 'stage.skip');
    }
    return wrapCoreResult(await coreOps['stage.skip'](params), 'stage.skip');
  },

  'stage.reset': async (params: PipelineOps['stage.reset'][0]) => {
    if (!params.taskId || !params.stage || !params.reason) {
      return lafsError('E_INVALID_INPUT', 'taskId, stage, and reason are required', 'stage.reset');
    }
    return wrapCoreResult(await coreOps['stage.reset'](params), 'stage.reset');
  },

  'stage.gate.pass': async (params: PipelineOps['stage.gate.pass'][0]) => {
    if (!params.taskId || !params.gateName) {
      return lafsError('E_INVALID_INPUT', 'taskId and gateName are required', 'stage.gate.pass');
    }
    return wrapCoreResult(await coreOps['stage.gate.pass'](params), 'stage.gate.pass');
  },

  'stage.gate.fail': async (params: PipelineOps['stage.gate.fail'][0]) => {
    if (!params.taskId || !params.gateName) {
      return lafsError('E_INVALID_INPUT', 'taskId and gateName are required', 'stage.gate.fail');
    }
    return wrapCoreResult(await coreOps['stage.gate.fail'](params), 'stage.gate.fail');
  },

  // -------------------------------------------------------------------------
  // Release queries
  // -------------------------------------------------------------------------

  'release.list': async (params: PipelineOps['release.list'][0]) => {
    const result = await coreOps['release.list'](params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'release.list',
      );
    }
    // Embed engine page in data so outer query() can populate DispatchResponse.page.
    return lafsSuccess(
      { ...(result.data as Record<string, unknown> | undefined), _enginePage: result.page },
      'release.list',
    );
  },

  'release.show': async (params: PipelineOps['release.show'][0]) => {
    if (!params.version) {
      return lafsError('E_INVALID_INPUT', 'version is required', 'release.show');
    }
    return wrapCoreResult(await coreOps['release.show'](params), 'release.show');
  },

  // Always succeeds (git branch detection falls back to 'unknown') — no error path.
  'release.channel.show': async (_params: PipelineOps['release.channel.show'][0]) =>
    lafsSuccess((await coreOps['release.channel.show'](_params)).data, 'release.channel.show'),

  'release.changelog.since': async (params: PipelineOps['release.changelog.since'][0]) => {
    if (!params.sinceTag) {
      return lafsError('E_INVALID_INPUT', 'sinceTag is required', 'release.changelog.since');
    }
    return wrapCoreResult(
      await coreOps['release.changelog.since'](params),
      'release.changelog.since',
    );
  },

  // -------------------------------------------------------------------------
  // Release mutations
  // -------------------------------------------------------------------------

  'release.ship': async (params: PipelineOps['release.ship'][0]) => {
    if (!params.version || !params.epicId) {
      return lafsError('E_INVALID_INPUT', 'version and epicId are required', 'release.ship');
    }
    return wrapCoreResult(await coreOps['release.ship'](params), 'release.ship');
  },

  'release.cancel': async (params: PipelineOps['release.cancel'][0]) => {
    if (!params.version) {
      return lafsError('E_INVALID_INPUT', 'version is required', 'release.cancel');
    }
    return wrapCoreResult(await coreOps['release.cancel'](params), 'release.cancel');
  },

  'release.rollback': async (params: PipelineOps['release.rollback'][0]) => {
    if (!params.version) {
      return lafsError('E_INVALID_INPUT', 'version is required', 'release.rollback');
    }
    return wrapCoreResult(await coreOps['release.rollback'](params), 'release.rollback');
  },

  'release.rollback.full': async (params: PipelineOps['release.rollback.full'][0]) => {
    if (!params.version) {
      return lafsError('E_INVALID_INPUT', 'version is required', 'release.rollback.full');
    }
    return wrapCoreResult(await coreOps['release.rollback.full'](params), 'release.rollback.full');
  },

  // -------------------------------------------------------------------------
  // Manifest queries
  // -------------------------------------------------------------------------

  'manifest.show': async (params: PipelineOps['manifest.show'][0]) => {
    if (!params.entryId) {
      return lafsError('E_INVALID_INPUT', 'entryId is required', 'manifest.show');
    }
    return wrapCoreResult(await coreOps['manifest.show'](params), 'manifest.show');
  },

  'manifest.list': async (params: PipelineOps['manifest.list'][0]) => {
    const result = await coreOps['manifest.list'](params);
    if (!result.success) {
      return lafsError(
        String(result.error?.code ?? 'E_INTERNAL'),
        result.error?.message ?? 'Unknown error',
        'manifest.list',
      );
    }
    // Embed engine page in data so outer query() can populate DispatchResponse.page.
    return lafsSuccess(
      { ...(result.data as Record<string, unknown> | undefined), _enginePage: result.page },
      'manifest.list',
    );
  },

  'manifest.find': async (params: PipelineOps['manifest.find'][0]) => {
    if (!params.query) {
      return lafsError('E_INVALID_INPUT', 'query is required', 'manifest.find');
    }
    return wrapCoreResult(await coreOps['manifest.find'](params), 'manifest.find');
  },

  'manifest.stats': async (params: PipelineOps['manifest.stats'][0]) =>
    wrapCoreResult(await coreOps['manifest.stats'](params), 'manifest.stats'),

  // -------------------------------------------------------------------------
  // Manifest mutations
  // -------------------------------------------------------------------------

  'manifest.append': async (params: PipelineOps['manifest.append'][0]) => {
    if (!params.entry) {
      return lafsError('E_INVALID_INPUT', 'entry is required', 'manifest.append');
    }
    return wrapCoreResult(await coreOps['manifest.append'](params), 'manifest.append');
  },

  'manifest.archive': async (params: PipelineOps['manifest.archive'][0]) => {
    if (!params.beforeDate) {
      return lafsError(
        'E_INVALID_INPUT',
        'beforeDate is required (ISO-8601: YYYY-MM-DD)',
        'manifest.archive',
      );
    }
    return wrapCoreResult(await coreOps['manifest.archive'](params), 'manifest.archive');
  },

  // -------------------------------------------------------------------------
  // Phase queries
  // -------------------------------------------------------------------------

  'phase.show': async (params: PipelineOps['phase.show'][0]) =>
    wrapCoreResult(await coreOps['phase.show'](params), 'phase.show'),

  // Pagination is applied in PipelineHandler.query() for phase.list.
  'phase.list': async (_params: PipelineOps['phase.list'][0]) =>
    wrapCoreResult(await coreOps['phase.list'](_params), 'phase.list'),

  // -------------------------------------------------------------------------
  // Phase mutations
  // -------------------------------------------------------------------------

  'phase.set': async (params: PipelineOps['phase.set'][0]) => {
    if (!params.phaseId) {
      return lafsError('E_INVALID_INPUT', 'phaseId is required', 'phase.set');
    }
    return wrapCoreResult(await coreOps['phase.set'](params), 'phase.set');
  },

  'phase.advance': async (params: PipelineOps['phase.advance'][0]) =>
    wrapCoreResult(await coreOps['phase.advance'](params), 'phase.advance'),

  'phase.rename': async (params: PipelineOps['phase.rename'][0]) => {
    if (!params.oldName || !params.newName) {
      return lafsError('E_INVALID_INPUT', 'oldName and newName are required', 'phase.rename');
    }
    return wrapCoreResult(await coreOps['phase.rename'](params), 'phase.rename');
  },

  'phase.delete': async (params: PipelineOps['phase.delete'][0]) => {
    if (!params.phaseId) {
      return lafsError('E_INVALID_INPUT', 'phaseId is required', 'phase.delete');
    }
    return wrapCoreResult(await coreOps['phase.delete'](params), 'phase.delete');
  },

  // -------------------------------------------------------------------------
  // Chain queries
  // -------------------------------------------------------------------------

  'chain.show': async (params: PipelineOps['chain.show'][0]) => {
    if (!params.chainId) {
      return lafsError('E_INVALID_INPUT', 'chainId is required', 'chain.show');
    }
    const { _chain, _chainId } = await coreOps['chain.show'](params);
    if (!_chain) {
      return lafsError('E_NOT_FOUND', `Chain "${_chainId}" not found`, 'chain.show');
    }
    return lafsSuccess(_chain, 'chain.show');
  },

  'chain.list': async (params: PipelineOps['chain.list'][0]) => {
    // Returns raw chains; pagination is applied in PipelineHandler.query().
    return lafsSuccess(await coreOps['chain.list'](params), 'chain.list');
  },

  // -------------------------------------------------------------------------
  // Chain mutations
  // -------------------------------------------------------------------------

  'chain.add': async (params: PipelineOps['chain.add'][0]) => {
    if (!params.chain) {
      return lafsError('E_INVALID_INPUT', 'chain is required', 'chain.add');
    }
    return lafsSuccess(await coreOps['chain.add'](params), 'chain.add');
  },

  'chain.instantiate': async (params: PipelineOps['chain.instantiate'][0]) => {
    if (!params.chainId || !params.epicId) {
      return lafsError('E_INVALID_INPUT', 'chainId and epicId are required', 'chain.instantiate');
    }
    try {
      return lafsSuccess(await coreOps['chain.instantiate'](params), 'chain.instantiate');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes(`Chain "${params.chainId}" not found`) ||
        message.includes('FOREIGN KEY constraint failed') ||
        message.includes('SQLITE_CONSTRAINT_FOREIGNKEY')
      ) {
        return lafsError('E_NOT_FOUND', `Chain "${params.chainId}" not found`, 'chain.instantiate');
      }
      throw error;
    }
  },

  'chain.advance': async (params: PipelineOps['chain.advance'][0]) => {
    if (!params.instanceId || !params.nextStage) {
      return lafsError('E_INVALID_INPUT', 'instanceId and nextStage are required', 'chain.advance');
    }
    return lafsSuccess(await coreOps['chain.advance'](params), 'chain.advance');
  },
});

// ---------------------------------------------------------------------------
// PipelineHandler
// ---------------------------------------------------------------------------

/**
 * Pipeline domain handler.
 *
 * Delegates all operations to the typed inner handler via `typedDispatch`.
 * Special cases:
 * - `stage.guidance` — resolved in the typed handler (stage-from-epicId logic).
 * - `phase.list` / `chain.list` — pagination applied in this outer handler to avoid
 *   LAFSPage type incompatibility between `@cleocode/lafs` and `@cleocode/contracts`.
 *
 * @task T1441 — OpsFromCore inference migration (Wave D · T1435)
 */
export class PipelineHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    const queryOps = new Set<string>([
      'stage.validate',
      'stage.status',
      'stage.history',
      'stage.guidance',
      'manifest.show',
      'manifest.list',
      'manifest.find',
      'manifest.stats',
      'release.list',
      'release.show',
      'release.channel.show',
      'release.changelog.since',
      'phase.show',
      'phase.list',
      'chain.show',
      'chain.list',
    ]);

    if (!queryOps.has(operation)) {
      return errorResult(
        'query',
        'pipeline',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline query: ${operation}`,
        startTime,
      );
    }

    try {
      const envelope = await typedDispatch(
        _pipelineTypedHandler,
        operation as keyof PipelineOps & string,
        params ?? {},
      );

      if (!envelope.success) {
        return {
          meta: dispatchMeta('query', 'pipeline', operation, startTime),
          success: false,
          error: {
            code: envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
            message: envelope.error?.message ?? 'Unknown error',
          },
        };
      }

      // phase.list — re-apply pagination so DispatchResponse.page is populated.
      if (operation === 'phase.list') {
        const rawData = envelope.data as unknown;
        const listData = rawData as ListPhasesResult & Record<string, unknown>;
        const phases = ((listData as { phases?: unknown[] } | undefined)?.phases ??
          []) as unknown[];
        const total =
          (listData as { summary?: { total?: number } } | undefined)?.summary?.total ??
          phases.length;
        const { limit, offset } = getListParams(params);
        const page = paginate(phases, limit, offset);

        return {
          meta: dispatchMeta('query', 'pipeline', operation, startTime),
          success: true,
          data: {
            ...listData,
            phases: page.items,
            total,
            filtered: total,
          },
          page: page.page,
        };
      }

      // chain.list — apply pagination to raw chains returned by typed handler.
      if (operation === 'chain.list') {
        const rawData = envelope.data as unknown as { _chains: unknown[] };
        const chains = rawData._chains ?? [];
        const { limit, offset } = getListParams(params);
        const page = paginate(chains, limit, offset);

        return {
          meta: dispatchMeta('query', 'pipeline', operation, startTime),
          success: true,
          data: {
            chains: page.items,
            total: chains.length,
            filtered: chains.length,
          },
          page: page.page,
        };
      }

      // Extract _enginePage embedded by typed handler ops (e.g. manifest.list, release.list)
      // so the DispatchResponse.page field is populated for pagination-aware consumers.
      const envelopeData = envelope.data as Record<string, unknown> | undefined;
      const enginePage = envelopeData?._enginePage as import('@cleocode/lafs').LAFSPage | undefined;
      const responseData =
        envelopeData?._enginePage !== undefined
          ? (({ _enginePage: _p, ...rest }) => rest)(
              envelopeData as Record<string, unknown> & { _enginePage: unknown },
            )
          : envelopeData;

      return {
        meta: dispatchMeta('query', 'pipeline', operation, startTime),
        success: true,
        data: responseData as unknown,
        ...(enginePage ? { page: enginePage } : {}),
      };
    } catch (error) {
      getLogger('domain:pipeline').error(
        { gateway: 'query', domain: 'pipeline', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'pipeline', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    const mutateOps = new Set<string>([
      'stage.record',
      'stage.skip',
      'stage.reset',
      'stage.gate.pass',
      'stage.gate.fail',
      'release.ship',
      'release.cancel',
      'release.rollback',
      'release.rollback.full',
      'manifest.append',
      'manifest.archive',
      'phase.set',
      'phase.advance',
      'phase.rename',
      'phase.delete',
      'chain.add',
      'chain.instantiate',
      'chain.advance',
    ]);

    if (!mutateOps.has(operation)) {
      return errorResult(
        'mutate',
        'pipeline',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline mutation: ${operation}`,
        startTime,
      );
    }

    try {
      const envelope = await typedDispatch(
        _pipelineTypedHandler,
        operation as keyof PipelineOps & string,
        params ?? {},
      );

      return {
        meta: dispatchMeta('mutate', 'pipeline', operation, startTime),
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
      getLogger('domain:pipeline').error(
        { gateway: 'mutate', domain: 'pipeline', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'pipeline', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'stage.validate',
        'stage.status',
        'stage.history',
        'stage.guidance',
        'manifest.show',
        'manifest.list',
        'manifest.find',
        'manifest.stats',
        'release.list',
        'release.show',
        'release.channel.show',
        'release.changelog.since',
        'phase.show',
        'phase.list',
        'chain.show',
        'chain.list',
      ],
      mutate: [
        'stage.record',
        'stage.skip',
        'stage.reset',
        'stage.gate.pass',
        'stage.gate.fail',
        'release.ship',
        'release.cancel',
        'release.rollback',
        'release.rollback.full',
        'manifest.append',
        'manifest.archive',
        'phase.set',
        'phase.advance',
        'phase.rename',
        'phase.delete',
        'chain.add',
        'chain.instantiate',
        'chain.advance',
      ],
    };
  }
}
