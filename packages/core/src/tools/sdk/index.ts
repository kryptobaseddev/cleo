/**
 * SDK Tools barrel — Category B harness-agnostic SDK utilities.
 *
 * Every adapter, harness, and orchestration pathway MUST import shared
 * infrastructure primitives from this barrel (or from `@cleocode/contracts`
 * directly for zero-dep callers).
 *
 * Sub-modules:
 *   isolation        — WorktreeIsolation: provisionIsolatedShell, validateAbsolutePath
 *   tool-resolver    — ToolResolver: resolveToolCommand, CANONICAL_TOOLS
 *   tool-cache       — ToolCache: runToolCached, acquireGlobalSlot
 *   manifest         — Manifest: pipelineManifestAppend (ADR-027 write primitive)
 *   spawn-primitives — SpawnPrimitives: buildAgentEnv, buildWorktreeSpawnResult
 *
 * Taxonomy note:
 *   Category A (Agent Tool) — LLM-callable tools, owned by T1737/T1739,
 *     located at `packages/core/src/tools/agents/`.
 *   Category B (SDK Tool)   — this barrel.
 *   Category C (Domain Utility) — CAAMP management ops at `tools/engine-ops.ts`.
 *
 * @arch See ADR-064 (SDK Tools taxonomy)
 * @task T1815
 * @epic T1768
 */

export type {
  AbsolutePathRules,
  AbsolutePathValidationResult,
  BoundaryContract,
  IsolationEnvKey,
  IsolationOptions,
  IsolationResult,
} from './isolation.js';
// WorktreeIsolation SDK Tool
export {
  ISOLATION_ENV_KEYS,
  provisionIsolatedShell,
  validateAbsolutePath,
} from './isolation.js';
export type { ManifestEntry } from './manifest.js';
// Manifest SDK Tool
export { pipelineManifestAppend } from './manifest.js';
// SpawnPrimitives SDK Tool
export { buildAgentEnv, buildWorktreeSpawnResult } from './spawn-primitives.js';
export type {
  AcquireSlotOptions,
  ReleaseSlotFn,
  RunToolOptions,
  ToolCacheEntry,
  ToolRunResult,
} from './tool-cache.js';
// ToolCache SDK Tool
export { acquireGlobalSlot, runToolCached } from './tool-cache.js';
export type {
  CanonicalTool,
  ResolutionSource,
  ResolvedToolCommand,
  ResolveToolResult,
} from './tool-resolver.js';
// ToolResolver SDK Tool
export { CANONICAL_TOOLS, resolveToolCommand } from './tool-resolver.js';
