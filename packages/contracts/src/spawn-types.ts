/**
 * CLEO Spawn Adapter Types
 *
 * Type definitions for the spawn adapter system that wraps/extends
 * CAAMP SpawnAdapter interface. Self-contained version for contracts
 * (no dependency on @cleocode/caamp).
 *
 * @task T5236
 * @phase 1B
 */

import type { LeadDeniedTool } from './operations/orchestrate.js';

/**
 * Provider identifier for spawn operations.
 */
export type Provider = string;

/**
 * CAAMP-compatible spawn options (inlined for zero-dep contracts).
 */
export interface CAAMPSpawnOptions {
  /**
   * Capacity-aware routing hint — the id of the least-loaded registered agent
   * (Wave 6-C/D). Declared explicitly because `spawn-ops.ts` both writes it
   * and reads it back for the `SubagentStart`/`SubagentStop` payloads; under
   * the bare index signature it resolved to `unknown`, so
   * `options?.preferredAgent ?? \`worker-${taskId}\`` widened to `{}` and the
   * agentId silently lost its type. @task T12071
   */
  preferredAgent?: string;
  [key: string]: unknown;
}

/**
 * CAAMP-compatible spawn result (inlined for zero-dep contracts).
 */
export interface CAAMPSpawnResult {
  instanceId: string;
  output: string;
  exitCode: number;
  [key: string]: unknown;
}

/**
 * CLEO-specific spawn context
 * Extends CAAMP options with CLEO task and protocol metadata
 */
export interface CLEOSpawnContext {
  /** Task ID being spawned */
  taskId: string;

  /** Protocol to use for the spawned task */
  protocol: string;

  /** Fully-resolved prompt to send to subagent */
  prompt: string;

  /** Provider to use for spawning */
  provider: Provider;

  /** CAAMP-compatible spawn options */
  options: CAAMPSpawnOptions;

  /** Project root or working directory for provider-specific files and process execution */
  workingDirectory?: string;

  /** Token resolution information for the prompt */
  tokenResolution?: TokenResolution;

  /**
   * Tools to remove from the spawned agent; set only for a lead spawn under
   * the lead/worker split. The spawn bridge forwards it as
   * `SpawnContext.leadDeniedTools` and refuses the spawn with
   * `E_LEAD_TOOLS_UNSTRIPPED` when the provider does not declare
   * `leadToolStrip: 'enforced'`. Absent or empty for a worker spawn.
   *
   * @task T14357
   */
  leadDeniedTools?: readonly LeadDeniedTool[];
}

/**
 * CLEO spawn result
 * Extends CAAMP SpawnResult with CLEO-specific timing and metadata
 */
export interface CLEOSpawnResult extends CAAMPSpawnResult {
  /** Task ID that was spawned */
  taskId: string;

  /** Provider ID used for the spawn */
  providerId: string;

  /** Timing information for the spawn operation */
  timing: {
    /** ISO timestamp when spawn started */
    startTime: string;
    /** ISO timestamp when spawn completed (if finished) */
    endTime?: string;
    /** Duration in milliseconds */
    durationMs?: number;
  };

  /**
   * Terminal (or in-flight) state of the spawned agent.
   *
   * Declared explicitly because `spawn-ops.ts` reads `result.status` to build
   * the `SubagentStop` hook payload. Inherited from `CAAMPSpawnResult`'s bare
   * `[key: string]: unknown` it resolved to `unknown`, so the value flowed
   * into a typed payload field unchecked — and it does not even share that
   * field's vocabulary ('completed' here vs 'complete' there). @task T12071
   */
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** Reference to manifest entry if output was captured */
  manifestEntryId?: string;
}

/**
 * Spawn adapter interface
 * Wraps CAAMP SpawnAdapter with CLEO-specific context and result types
 */
export interface CLEOSpawnAdapter {
  /** Unique identifier for this adapter instance */
  readonly id: string;

  /** Provider ID this adapter uses */
  readonly providerId: string;

  /**
   * Check if this adapter can spawn in the current environment
   * @returns Promise resolving to true if spawning is possible
   */
  canSpawn(): Promise<boolean>;

  /**
   * Execute a spawn using the provider's native mechanism
   * @param context - Fully-resolved spawn context
   * @returns Promise resolving to spawn result
   * @throws SpawnExecutionError if spawn fails
   */
  spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult>;

  /**
   * List currently running spawns
   * @returns Promise resolving to array of running spawn results
   */
  listRunning(): Promise<CLEOSpawnResult[]>;

  /**
   * Terminate a running spawn
   * @param instanceId - ID of the spawn instance to terminate
   * @returns Promise that resolves when termination is complete
   */
  terminate(instanceId: string): Promise<void>;
}

/**
 * Token resolution information for prompt processing
 */
export interface TokenResolution {
  /** Array of resolved token identifiers */
  resolved: string[];
  /** Array of unresolved token identifiers */
  unresolved: string[];
  /** Total number of tokens processed */
  totalTokens: number;
}

/**
 * Spawn status values
 */
export type SpawnStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
