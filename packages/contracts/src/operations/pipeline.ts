/**
 * Pipeline Domain Operations
 *
 * Contract types for the pipeline domain: stage lifecycle, release, manifest,
 * phase, and warp-chain operations. All param/result types here are inferred
 * via `OpsFromCore<typeof coreOps>` in the dispatch layer — this file exists
 * for documentation and for downstream consumers that need explicit types.
 *
 * @task T1441 — OpsFromCore inference migration
 * @task T1435 — Wave 1 dispatch refactor
 */

/**
 * Re-exported for convenience — all pipeline params and results flow through
 * the dispatch layer as plain objects. Downstream callers that need explicit
 * types can import from here.
 *
 * @remarks
 * The canonical source of truth is `OpsFromCore<typeof coreOps>` inside
 * `packages/cleo/src/dispatch/domains/pipeline.ts`. This file only exports
 * well-named aliases for documentation purposes.
 */

// ---------------------------------------------------------------------------
// Stage sub-domain param types
// ---------------------------------------------------------------------------

/** Parameters for `pipeline.stage.validate` (query). */
export interface PipelineStageValidateParams {
  epicId: string;
  targetStage: string;
}

/** Parameters for `pipeline.stage.status` (query). */
export interface PipelineStageStatusParams {
  epicId: string;
}

/** Parameters for `pipeline.stage.history` (query). */
export interface PipelineStageHistoryParams {
  taskId: string;
}

/** Parameters for `pipeline.stage.guidance` (query). */
export interface PipelineStageGuidanceParams {
  stage?: string;
  epicId?: string;
  format?: string;
}

/** Parameters for `pipeline.stage.record` (mutate). */
export interface PipelineStageRecordParams {
  taskId: string;
  stage: string;
  status: string;
  notes?: string;
}

/** Parameters for `pipeline.stage.skip` (mutate). */
export interface PipelineStageSkipParams {
  taskId: string;
  stage: string;
  reason: string;
}

/** Parameters for `pipeline.stage.reset` (mutate). */
export interface PipelineStageResetParams {
  taskId: string;
  stage: string;
  reason: string;
}

/** Parameters for `pipeline.stage.gate.pass` (mutate). */
export interface PipelineStageGatePassParams {
  taskId: string;
  gateName: string;
  agent?: string;
  notes?: string;
}

/** Parameters for `pipeline.stage.gate.fail` (mutate). */
export interface PipelineStageGateFailParams {
  taskId: string;
  gateName: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Release sub-domain param types
// ---------------------------------------------------------------------------

/** Release status filter union. */
export type PipelineReleaseStatus = 'draft' | 'in_progress' | 'shipped' | 'cancelled';

/** Parameters for `pipeline.release.list` (query). */
export interface PipelineReleaseListParams {
  status?: PipelineReleaseStatus;
  limit?: number;
  offset?: number;
}

/** Parameters for `pipeline.release.show` (query). */
export interface PipelineReleaseShowParams {
  version: string;
}

/** Parameters for `pipeline.release.channel.show` (query). */
export type PipelineReleaseChannelShowParams = Record<string, never>;

/** Parameters for `pipeline.release.changelog.since` (query). */
export interface PipelineReleaseChangelogSinceParams {
  sinceTag: string;
}

/** Parameters for `pipeline.release.ship` (mutate). */
export interface PipelineReleaseShipParams {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
  bump?: boolean;
  force?: boolean;
}

/** Parameters for `pipeline.release.cancel` (mutate). */
export interface PipelineReleaseCancelParams {
  version: string;
}

/** Parameters for `pipeline.release.rollback` (mutate). */
export interface PipelineReleaseRollbackParams {
  version: string;
  reason?: string;
}

/** Parameters for `pipeline.release.rollback.full` (mutate). */
export interface PipelineReleaseRollbackFullParams {
  version: string;
  reason?: string;
  force?: boolean;
  unpublish?: boolean;
}

// ---------------------------------------------------------------------------
// Manifest sub-domain param types
// ---------------------------------------------------------------------------

/** Parameters for `pipeline.manifest.show` (query). */
export interface PipelineManifestShowParams {
  entryId: string;
}

/** Parameters for `pipeline.manifest.list` (query). */
export interface PipelineManifestListParams {
  status?: string;
  taskId?: string;
  epicId?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/** Parameters for `pipeline.manifest.find` (query). */
export interface PipelineManifestFindParams {
  query: string;
  confidence?: number;
  limit?: number;
}

/** Parameters for `pipeline.manifest.stats` (query). */
export interface PipelineManifestStatsParams {
  epicId?: string;
}

/** Parameters for `pipeline.manifest.append` (mutate). */
export interface PipelineManifestAppendParams {
  entry: Record<string, unknown>;
}

/** Parameters for `pipeline.manifest.archive` (mutate). */
export interface PipelineManifestArchiveParams {
  beforeDate: string;
}

// ---------------------------------------------------------------------------
// Phase sub-domain param types
// ---------------------------------------------------------------------------

/** Parameters for `pipeline.phase.show` (query). */
export interface PipelinePhaseShowParams {
  phaseId?: string;
}

/** Parameters for `pipeline.phase.list` (query). */
export type PipelinePhaseListParams = Record<string, never>;

/** Parameters for `pipeline.phase.set` (mutate). */
export interface PipelinePhaseSetParams {
  phaseId: string;
  action?: string;
  rollback?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

/** Parameters for `pipeline.phase.advance` (mutate). */
export interface PipelinePhaseAdvanceParams {
  force?: boolean;
}

/** Parameters for `pipeline.phase.rename` (mutate). */
export interface PipelinePhaseRenameParams {
  oldName: string;
  newName: string;
}

/** Parameters for `pipeline.phase.delete` (mutate). */
export interface PipelinePhaseDeleteParams {
  phaseId: string;
  reassignTo?: string;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Chain sub-domain param types
// ---------------------------------------------------------------------------

/** Parameters for `pipeline.chain.show` (query). */
export interface PipelineChainShowParams {
  chainId: string;
}

/** Parameters for `pipeline.chain.list` (query). */
export interface PipelineChainListParams {
  limit?: number;
  offset?: number;
}

/** Parameters for `pipeline.chain.add` (mutate). */
export interface PipelineChainAddParams {
  chain: Record<string, unknown>;
}

/** Parameters for `pipeline.chain.instantiate` (mutate). */
export interface PipelineChainInstantiateParams {
  chainId: string;
  epicId: string;
  variables?: Record<string, unknown>;
  stageToTask?: Record<string, string>;
}

/** Parameters for `pipeline.chain.advance` (mutate). */
export interface PipelineChainAdvanceParams {
  instanceId: string;
  nextStage: string;
  gateResults?: unknown[];
}
