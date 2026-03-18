/**
 * Spawn provider interface for CLEO provider adapters.
 *
 * @task T5240
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
}

export interface SpawnResult {
  instanceId: string;
  taskId: string;
  providerId: string;
  output: string;
  exitCode: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: string;
  endTime?: string;
}
