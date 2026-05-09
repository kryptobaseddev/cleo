/**
 * Spawn provider interface for CLEO provider adapters.
 *
 * @task T5240
 * @task T9214 — orchestrator-defer waiver field (W4 UX hardening)
 */

export interface AdapterSpawnProvider {
  canSpawn(): Promise<boolean>;
  spawn(context: SpawnContext): Promise<SpawnResult>;
  listRunning(): Promise<SpawnResult[]>;
  terminate(instanceId: string): Promise<void>;
}

export interface SpawnContext {
  taskId: string;
  prompt: string;
  workingDirectory?: string;
  options?: Record<string, unknown>;
  /**
   * Atomicity scope declaration for the spawned worker.
   *
   * When set to `'orchestrator-defer'`, a tier-1+ orchestrator signals that
   * the spawned worker will declare its own file scope at commit time. This
   * bypasses `E_ATOMICITY_NO_SCOPE` for the child task while preserving
   * auditability via the `atomicity_waiver` field in the returned
   * {@link AtomicityResult}.
   *
   * MUST NOT be set by tier-0 (direct user / CLI) callers — only by
   * orchestrators making delegated tier-1 dispatch calls.
   *
   * @task T9214
   */
  scope?: 'orchestrator-defer';
}

export interface SpawnResult {
  instanceId: string;
  taskId: string;
  providerId: string;
  /** Output captured from the spawned process. Optional for detached/fire-and-forget spawns. */
  output?: string;
  /** Exit code of the spawned process. Optional for detached/fire-and-forget spawns. */
  exitCode?: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: string;
  endTime?: string;
  /** Error message when status is 'failed'. Contains details about what went wrong. */
  error?: string;
}
