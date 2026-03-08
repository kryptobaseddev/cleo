/**
 * CLEO Spawn Adapter Types
 *
 * Type definitions for the spawn adapter system that wraps/extends
 * CAAMP 1.6.0 SpawnAdapter interface.
 *
 * @task T5236
 * @phase 1B
 */

// Import from CAAMP
import type {
  SpawnAdapter as CAAMPSpawnAdapter,
  SpawnOptions as CAAMPSpawnOptions,
  SpawnResult as CAAMPSpawnResult,
  Provider,
} from '@cleocode/caamp';

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

// Re-export CAAMP types for convenience
export type { CAAMPSpawnAdapter, CAAMPSpawnOptions, CAAMPSpawnResult, Provider };
