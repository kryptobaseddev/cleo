/**
 * Spawn adapter interface for provider-neutral subagent orchestration.
 *
 * This is an interface-only module — no concrete implementations yet.
 * CLEO will consume this interface to build provider-specific adapters.
 *
 * @remarks
 * T380/ADR-041: `SpawnOptions.isolate: boolean` has been superseded by
 * `SpawnOptions.worktree: WorktreeHandle`. The boolean alias is kept for one
 * release cycle (removal target: v2026.5.x) so existing callers compile
 * without changes during the migration window.
 */

import type { WorktreeHandle } from '@cleocode/cant';
import type { Provider } from '../../types.js';

/**
 * Options for spawning a subagent.
 *
 * @remarks
 * When `worktree` is present, the spawn adapter MUST bind the child process
 * cwd to `worktree.path` and export the following environment variables:
 *   - `CLEO_WORKTREE_ROOT`   = worktree.path
 *   - `CLEO_WORKTREE_BRANCH` = worktree.branch
 *   - `CLEO_PROJECT_HASH`    = worktree.projectHash
 *
 * See ADR-041 §D2 and ULTRAPLAN §14 for the full isolation contract.
 *
 * @task T380
 * @public
 */
export interface SpawnOptions {
  /** The prompt or instruction to give the spawned agent. */
  prompt: string;
  /** Model to use for the spawned agent. @defaultValue undefined */
  model?: string;
  /** Tools to make available to the spawned agent. @defaultValue undefined */
  tools?: string[];
  /** Timeout in milliseconds for the spawned agent. @defaultValue undefined */
  timeout?: number;
  /**
   * Git worktree handle that provides physical + logical isolation for the
   * spawned subagent (ADR-041 §D1).
   *
   * @remarks
   * When set, the adapter MUST pass `cwd: worktree.path` to the child process
   * and export `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, and
   * `CLEO_PROJECT_HASH` into its environment so that path resolvers inside
   * the worker direct DB I/O to the correct worktree directory.
   *
   * Supersedes the deprecated {@link SpawnOptions.isolate} boolean which
   * carried no data and could not drive cwd binding or env-var injection.
   *
   * @defaultValue undefined
   * @task T380
   */
  worktree?: WorktreeHandle;
  /**
   * Whether to isolate the spawned agent (e.g. in a worktree).
   *
   * @deprecated Use `worktree` instead. The boolean flag has no associated
   *   data and cannot drive cwd binding or env-var injection. Pass a
   *   {@link WorktreeHandle} via `worktree` to achieve isolation.
   *   Removal target: v2026.5.x.
   *
   * @defaultValue undefined
   */
  isolate?: boolean;
}

/**
 * Result from a spawn operation.
 *
 * @public
 */
export interface SpawnResult {
  /** Unique identifier for the spawned agent instance. */
  instanceId: string;
  /** Current status of the spawned agent. */
  status: 'running' | 'completed' | 'failed';
  /** Output produced by the spawned agent. @defaultValue undefined */
  output?: string;
}

/**
 * Provider-neutral interface for spawning and managing subagents.
 *
 * Concrete implementations will be provider-specific (e.g. ClaudeCodeSpawnAdapter,
 * CodexSpawnAdapter) and registered by CLEO's orchestration layer.
 *
 * @public
 */
export interface SpawnAdapter {
  /** Check if a provider supports spawning via this adapter. */
  canSpawn(provider: Provider): boolean;
  /** Spawn a new subagent for the given provider. */
  spawn(provider: Provider, options: SpawnOptions): Promise<SpawnResult>;
  /** List currently running subagent instances. */
  listRunning(provider: Provider): Promise<SpawnResult[]>;
  /** Terminate a running subagent instance. */
  terminate(provider: Provider, instanceId: string): Promise<void>;
}
