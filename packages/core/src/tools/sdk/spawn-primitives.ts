/**
 * SpawnPrimitives SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for harness-agnostic spawn environment construction.
 * Harness adapters that build agent spawn results or inject environment
 * variables MUST import `buildAgentEnv` and `buildWorktreeSpawnResult`
 * from this path.
 *
 * The implementation lives in `../../spawn/branch-lock.ts` (domain location);
 * this file is the SDK-surface barrier.
 *
 * Note: These symbols currently have zero external consumers outside core/spawn
 * (re-exported via internal.ts). They are promoted here for completeness and
 * to give future harness implementations a stable import path.
 *
 * T1817+ will update callers once ADR-064 is written.
 *
 * @arch See ADR-064 (Category B SDK Tool: SpawnPrimitives)
 * @task T1815
 * @epic T1768
 */
export { buildAgentEnv, buildWorktreeSpawnResult } from '../../spawn/branch-lock.js';
