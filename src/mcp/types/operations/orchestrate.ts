/**
 * Orchestrate Domain Operations (12 operations)
 *
 * Query operations: 7
 * Mutate operations: 5
 */

/**
 * Common orchestration types
 */
export interface Wave {
  wave: number;
  taskIds: string[];
  canRunParallel: boolean;
  dependencies: string[];
}

export interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  model?: string;
  protocols: string[];
}

/**
 * Query Operations
 */

// orchestrate.status
export interface OrchestrateStatusParams {
  epicId: string;
}
export interface OrchestrateStatusResult {
  epicId: string;
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  blockedTasks: number;
  currentWave: number;
  totalWaves: number;
  parallelCapacity: number;
}

// orchestrate.next
export interface OrchestrateNextParams {
  epicId: string;
}
export interface OrchestrateNextResult {
  taskId: string;
  title: string;
  recommendedSkill: string;
  reasoning: string;
}

// orchestrate.ready
export interface OrchestrateReadyParams {
  epicId: string;
}
export interface OrchestrateReadyResult {
  wave: number;
  taskIds: string[];
  parallelSafe: boolean;
}

// orchestrate.analyze
export interface OrchestrateAnalyzeParams {
  epicId: string;
}
export interface OrchestrateAnalyzeResult {
  waves: Wave[];
  criticalPath: string[];
  estimatedParallelism: number;
  bottlenecks: string[];
}

// orchestrate.context
export interface OrchestrateContextParams {
  tokens?: number;
}
export interface OrchestrateContextResult {
  currentTokens: number;
  maxTokens: number;
  percentUsed: number;
  level: 'safe' | 'medium' | 'high' | 'critical';
  recommendation: string;
}

// orchestrate.waves
export interface OrchestrateWavesParams {
  epicId: string;
}
export type OrchestrateWavesResult = Wave[];

// orchestrate.skill.list
export interface OrchestrateSkillListParams {
  filter?: string;
}
export type OrchestrateSkillListResult = SkillDefinition[];

// orchestrate.bootstrap
export interface OrchestrateBootstrapParams {
  speed?: 'fast' | 'full' | 'complete';
}
export interface BrainState {
  session?: { id: string; name: string; status: string; startedAt: string };
  currentTask?: { id: string; title: string; status: string };
  nextSuggestion?: { id: string; title: string; score: number };
  recentDecisions?: Array<{ id: string; decision: string; timestamp: string }>;
  blockers?: Array<{ taskId: string; title: string; blockedBy: string[] }>;
  progress?: { total: number; done: number; active: number; blocked: number; pending: number };
  contextDrift?: { score: number; factors: string[] };
  _meta: { speed: 'fast' | 'full' | 'complete'; generatedAt: string; version: string };
}

/**
 * Mutate Operations
 */

// orchestrate.startup
export interface OrchestrateStartupParams {
  epicId: string;
}
export interface OrchestrateStartupResult {
  epicId: string;
  status: OrchestrateStatusResult;
  analysis: OrchestrateAnalyzeResult;
  firstTask: OrchestrateNextResult;
}

// orchestrate.spawn
export interface OrchestrateSpawnParams {
  taskId: string;
  skill?: string;
  model?: string;
}
export interface OrchestrateSpawnResult {
  taskId: string;
  skill: string;
  model: string;
  prompt: string;
  metadata: {
    tokensUsed: number;
    protocolsInjected: string[];
    dependencies: string[];
  };
}

// orchestrate.validate
export interface OrchestrateValidateParams {
  taskId: string;
}
export interface OrchestrateValidateResult {
  taskId: string;
  ready: boolean;
  blockers: string[];
  lifecycleGate: 'passed' | 'failed' | 'pending';
  recommendations: string[];
}

// orchestrate.parallel.start
export interface OrchestrateParallelStartParams {
  epicId: string;
  wave: number;
}
export interface OrchestrateParallelStartResult {
  wave: number;
  taskIds: string[];
  started: string;
}

// orchestrate.parallel.end
export interface OrchestrateParallelEndParams {
  epicId: string;
  wave: number;
}
export interface OrchestrateParallelEndResult {
  wave: number;
  completed: number;
  failed: number;
  duration: string;
}
