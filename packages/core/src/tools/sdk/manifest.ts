/**
 * Manifest SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for subagent pipeline manifest writes (ADR-027).
 * Every subagent that appends a manifest entry MUST use `pipelineManifestAppend`
 * from this path.
 *
 * Only the write primitive (`pipelineManifestAppend`) is promoted to the SDK
 * surface. The query operations (`pipelineManifestList`, `pipelineManifestShow`,
 * etc.) remain Category C (CLI/domain utilities) in their current location.
 *
 * The implementation lives in `../../memory/pipeline-manifest-sqlite.ts`
 * (domain location); this file is the SDK-surface barrier.
 *
 * T1819 will fill this stub with the actual re-export once ADR-064 is written.
 *
 * @arch See ADR-064 (Category B SDK Tool: Manifest)
 * @task T1815
 * @epic T1768
 */
export type { ManifestEntry } from '../../memory/pipeline-manifest-sqlite.js';

export { pipelineManifestAppend } from '../../memory/pipeline-manifest-sqlite.js';
