/**
 * Orchestrate Domain Handler
 *
 * Implements all 12 orchestration operations for CLEO MCP server:
 * - Query (6): status, ready, next, waves, context, progress
 * - Mutate (6): start, spawn, pause, resume, abort, analyze
 *
 * Each operation maps to corresponding CLEO orchestrator CLI commands.
 *
 * @task T2917
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { createGatewayMeta } from '../lib/gateway-meta.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  orchestrateStatus as nativeOrchestrateStatus,
  orchestrateAnalyze as nativeOrchestrateAnalyze,
  orchestrateReady as nativeOrchestrateReady,
  orchestrateNext as nativeOrchestrateNext,
  orchestrateWaves as nativeOrchestrateWaves,
  orchestrateContext as nativeOrchestrateContext,
  orchestrateSkillList as nativeOrchestrateSkillList,
  orchestrateValidate as nativeOrchestrateValidate,
  orchestrateSpawn as nativeOrchestrateSpawn,
  orchestrateStartup as nativeOrchestrateStartup,
  orchestrateBootstrap as nativeOrchestrateBootstrap,
  orchestrateUnblockOpportunities as nativeOrchestrateUnblockOpportunities,
  orchestrateCriticalPath as nativeOrchestrateCriticalPath,
  orchestrateParallelStart as nativeOrchestrateParallelStart,
  orchestrateParallelEnd as nativeOrchestrateParallelEnd,
  orchestrateCheck as nativeOrchestrateCheck,
  orchestrateSkillInject as nativeOrchestrateSkillInject,
  resolveProjectRoot,
} from '../engine/index.js';

/**
 * Query parameter types
 */
interface OrchestrateStatusParams {
  epicId: string;
}

interface OrchestrateReadyParams {
  epicId: string;
}

interface OrchestrateNextParams {
  epicId: string;
}

interface OrchestrateWavesParams {
  epicId: string;
}

interface OrchestrateContextParams {
  tokens?: number;
}

interface OrchestrateProgressParams {
  epicId: string;
}

/**
 * Mutate parameter types
 */
interface OrchestrateStartParams {
  epicId: string;
  name?: string;
  autoFocus?: boolean;
}

interface OrchestrateSpawnParams {
  taskId: string;
  skill?: string;
  model?: string;
}

interface OrchestratePauseParams {
  epicId: string;
  reason?: string;
}

interface OrchestrateResumeParams {
  epicId: string;
}

interface OrchestrateAbortParams {
  epicId: string;
  reason: string;
}

interface OrchestrateAnalyzeParams {
  epicId: string;
}

interface OrchestrateSkillListParams {
  filter?: string;
}

interface OrchestrateValidateParams {
  taskId: string;
}

interface OrchestrateParallelStartParams {
  epicId: string;
  wave: number;
}

interface OrchestrateParallelEndParams {
  epicId: string;
  wave: number;
}

/**
 * Result types
 */
interface OrchestrateStatus {
  epicId: string;
  state: 'idle' | 'running' | 'paused' | 'completed' | 'aborted';
  currentWave?: number;
  totalWaves?: number;
  completedTasks: number;
  remainingTasks: number;
  parallelActive: number;
}

interface OrchestrateReadyResult {
  epicId: string;
  wave: number;
  tasks: Array<{
    taskId: string;
    title: string;
    canSpawnParallel: boolean;
  }>;
}

interface OrchestrateNextResult {
  taskId: string;
  title: string;
  skill: string;
  priority: string;
  wave: number;
}

interface OrchestrateWavesResult {
  epicId: string;
  waves: Array<{
    wave: number;
    tasks: string[];
    parallelSafe: boolean;
  }>;
  criticalPath: string[];
}

interface OrchestrateContextResult {
  tokens: number;
  limit: number;
  percentage: number;
  status: 'ok' | 'medium' | 'high' | 'critical';
}

interface OrchestrateProgressResult {
  epicId: string;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  percentComplete: number;
}

interface OrchestrateStartResult {
  epicId: string;
  sessionId: string;
  state: string;
  initialWave: number;
}

interface OrchestrateSpawnResult {
  taskId: string;
  skill: string;
  prompt: string;
  metadata: {
    epicId: string;
    wave: number;
    tokensResolved: boolean;
  };
}

/**
 * Orchestrate domain handler implementation
 */
export class OrchestrateHandler implements DomainHandler {
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(private executor?: CLIExecutor, executionMode: ResolvedMode = 'cli') {
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor?.isAvailable()) {
      return false;
    }
    return canRunNatively('orchestrate', operation, gateway);
  }

  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    if (result.success) {
      return {
        _meta: createGatewayMeta(gateway, 'orchestrate', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: createGatewayMeta(gateway, 'orchestrate', operation, startTime),
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  private async queryNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): Promise<DomainResponse> {
    switch (operation) {
      case 'status':
        return this.wrapNativeResult(await nativeOrchestrateStatus(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'analyze':
        return this.wrapNativeResult(await nativeOrchestrateAnalyze(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'ready':
        return this.wrapNativeResult(await nativeOrchestrateReady(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'next':
        return this.wrapNativeResult(await nativeOrchestrateNext(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'waves':
        return this.wrapNativeResult(await nativeOrchestrateWaves(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'context':
        return this.wrapNativeResult(await nativeOrchestrateContext(params?.epicId as string, this.projectRoot), 'cleo_query', operation, startTime);
      case 'skill.list':
        return this.wrapNativeResult(nativeOrchestrateSkillList(this.projectRoot), 'cleo_query', operation, startTime);
      case 'bootstrap':
        return this.wrapNativeResult(await nativeOrchestrateBootstrap(this.projectRoot, params as { speed?: 'fast' | 'full' | 'complete' }), 'cleo_query', operation, startTime);
      case 'critical-path':
        return this.wrapNativeResult(await nativeOrchestrateCriticalPath(this.projectRoot), 'cleo_query', operation, startTime);
      case 'unblock-opportunities':
        return this.wrapNativeResult(await nativeOrchestrateUnblockOpportunities(this.projectRoot), 'cleo_query', operation, startTime);
      default:
        return this.createErrorResponse('cleo_query', 'orchestrate', operation, 'E_INVALID_OPERATION', `Unknown native query operation: ${operation}`, startTime);
    }
  }

  private async mutateNative(operation: string, params: Record<string, unknown> | undefined, startTime: number): Promise<DomainResponse> {
    switch (operation) {
      case 'startup':
        return this.wrapNativeResult(await nativeOrchestrateStartup(params?.epicId as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'spawn':
        return this.wrapNativeResult(await nativeOrchestrateSpawn(params?.taskId as string, params?.skill as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'validate':
        return this.wrapNativeResult(await nativeOrchestrateValidate(params?.taskId as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'parallel.start':
        return this.wrapNativeResult(await nativeOrchestrateParallelStart(params?.epicId as string, params?.wave as number, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'parallel.end':
        return this.wrapNativeResult(nativeOrchestrateParallelEnd(params?.epicId as string, params?.wave as number, this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'check':
        return this.wrapNativeResult(await nativeOrchestrateCheck(this.projectRoot), 'cleo_mutate', operation, startTime);
      case 'skill.inject':
        return this.wrapNativeResult(nativeOrchestrateSkillInject(params?.skill as string, this.projectRoot), 'cleo_mutate', operation, startTime);
      default:
        return this.createErrorResponse('cleo_mutate', 'orchestrate', operation, 'E_INVALID_OPERATION', `Unknown native mutate operation: ${operation}`, startTime);
    }
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (this.useNative(operation, 'query')) {
      try {
        return await this.queryNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_query', 'orchestrate', operation, error, startTime);
      }
    }

    if (!this.executor || !this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'orchestrate.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'status':
          return await this.queryStatus(params as unknown as OrchestrateStatusParams);
        case 'ready':
          return await this.queryReady(params as unknown as OrchestrateReadyParams);
        case 'next':
          return await this.queryNext(params as unknown as OrchestrateNextParams);
        case 'waves':
          return await this.queryWaves(params as unknown as OrchestrateWavesParams);
        case 'context':
          return await this.queryContext(params as unknown as OrchestrateContextParams);
        case 'progress':
          return await this.queryProgress(params as unknown as OrchestrateProgressParams);
        case 'skill.list':
          return await this.querySkillList(params as unknown as OrchestrateSkillListParams);
        case 'analyze':
          return await this.queryAnalyze(params as unknown as OrchestrateAnalyzeParams);
        case 'bootstrap':
          // bootstrap is always native-only, no CLI fallback
          return this.wrapNativeResult(await nativeOrchestrateBootstrap(this.projectRoot, params as { speed?: 'fast' | 'full' | 'complete' }), 'cleo_query', 'bootstrap', startTime);
        case 'critical-path':
          // critical-path is always native-only, no CLI fallback
          return this.wrapNativeResult(await nativeOrchestrateCriticalPath(this.projectRoot), 'cleo_query', 'critical-path', startTime);
        case 'unblock-opportunities':
          // unblock-opportunities is always native-only, no CLI fallback
          return this.wrapNativeResult(await nativeOrchestrateUnblockOpportunities(this.projectRoot), 'cleo_query', 'unblock-opportunities', startTime);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'orchestrate', operation, error, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    if (this.useNative(operation, 'mutate')) {
      try {
        return this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'orchestrate', operation, error, startTime);
      }
    }

    if (!this.executor || !this.executor.isAvailable()) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        operation,
        'E_CLI_REQUIRED',
        `Operation 'orchestrate.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
        startTime
      );
    }

    try {
      switch (operation) {
        case 'start':
          return await this.mutateStart(params as unknown as OrchestrateStartParams);
        case 'spawn':
          return await this.mutateSpawn(params as unknown as OrchestrateSpawnParams);
        case 'pause':
          return await this.mutatePause(params as unknown as OrchestratePauseParams);
        case 'resume':
          return await this.mutateResume(params as unknown as OrchestrateResumeParams);
        case 'abort':
          return await this.mutateAbort(params as unknown as OrchestrateAbortParams);
        case 'analyze':
          return await this.mutateAnalyze(params as unknown as OrchestrateAnalyzeParams);
        case 'validate':
          return await this.mutateValidate(params as unknown as OrchestrateValidateParams);
        case 'parallel.start':
          return await this.mutateParallelStart(params as unknown as OrchestrateParallelStartParams);
        case 'parallel.end':
          return await this.mutateParallelEnd(params as unknown as OrchestrateParallelEndParams);
        case 'startup':
          return await this.mutateStart(params as unknown as OrchestrateStartParams);
        case 'check':
          return this.mutateNative('check', params, startTime);
        case 'skill.inject':
          return this.mutateNative('skill.inject', params, startTime);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'orchestrate', operation, error, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'ready', 'next', 'waves', 'context', 'progress', 'skill.list', 'analyze', 'bootstrap', 'critical-path', 'unblock-opportunities'],
      mutate: ['start', 'spawn', 'pause', 'resume', 'abort', 'analyze', 'validate', 'parallel.start', 'parallel.end', 'startup', 'check', 'skill.inject'],
    };
  }

  // ===== Query Operations =====

  /**
   * status - Get orchestrator status
   * CLI: cleo orchestrator status --epic <id>
   */
  private async queryStatus(params: OrchestrateStatusParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'status',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<OrchestrateStatus>({
      domain: 'orchestrator',
      operation: 'status',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'status', startTime);
  }

  /**
   * ready - Get ready-to-spawn tasks
   * CLI: cleo orchestrator ready --epic <id>
   */
  private async queryReady(params: OrchestrateReadyParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'ready',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<OrchestrateReadyResult>({
      domain: 'orchestrator',
      operation: 'ready',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'ready', startTime);
  }

  /**
   * next - Get next task to spawn
   * CLI: cleo orchestrator next --epic <id>
   */
  private async queryNext(params: OrchestrateNextParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'next',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<OrchestrateNextResult>({
      domain: 'orchestrator',
      operation: 'next',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'next', startTime);
  }

  /**
   * waves - Get dependency waves
   * CLI: cleo orchestrator waves --epic <id>
   */
  private async queryWaves(params: OrchestrateWavesParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'waves',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<OrchestrateWavesResult>({
      domain: 'orchestrator',
      operation: 'waves',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'waves', startTime);
  }

  /**
   * context - Get orchestrator context usage
   * CLI: cleo orchestrator context [--tokens <n>]
   */
  private async queryContext(params: OrchestrateContextParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.tokens) flags.tokens = params.tokens;

    const result = await this.executor!.execute<OrchestrateContextResult>({
      domain: 'orchestrator',
      operation: 'context',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'context', startTime);
  }

  /**
   * progress - Get progress report
   * CLI: cleo orchestrator progress --epic <id>
   */
  private async queryProgress(params: OrchestrateProgressParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'progress',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<OrchestrateProgressResult>({
      domain: 'orchestrator',
      operation: 'progress',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'progress', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * start - Start orchestrator for epic
   * CLI: cleo orchestrator start --epic <id> [--name <name>] [--auto-focus]
   */
  private async mutateStart(params: OrchestrateStartParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'start',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = {
      epic: params.epicId,
      json: true,
    };

    if (params?.name) flags.name = params.name;
    if (params?.autoFocus) flags['auto-focus'] = true;

    const result = await this.executor!.execute<OrchestrateStartResult>({
      domain: 'orchestrator',
      operation: 'start',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'start', startTime);
  }

  /**
   * spawn - Spawn subagent for task
   * CLI: cleo orchestrator spawn <taskId> [--skill <skill>] [--model <model>]
   */
  private async mutateSpawn(params: OrchestrateSpawnParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'spawn',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = { json: true };
    if (params?.skill) flags.skill = params.skill;
    if (params?.model) flags.model = params.model;

    const result = await this.executor!.execute<OrchestrateSpawnResult>({
      domain: 'orchestrator',
      operation: 'spawn',
      args: [params.taskId],
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'spawn', startTime);
  }

  /**
   * pause - Pause orchestration
   * CLI: cleo orchestrator pause --epic <id> [--reason <reason>]
   */
  private async mutatePause(params: OrchestratePauseParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'pause',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = {
      epic: params.epicId,
      json: true,
    };

    if (params?.reason) flags.reason = params.reason;

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'pause',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'pause', startTime);
  }

  /**
   * resume - Resume orchestration
   * CLI: cleo orchestrator resume --epic <id>
   */
  private async mutateResume(params: OrchestrateResumeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'resume',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'resume',
      flags: { epic: params.epicId, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'resume', startTime);
  }

  /**
   * abort - Abort orchestration
   * CLI: cleo orchestrator abort --epic <id> --reason <reason>
   */
  private async mutateAbort(params: OrchestrateAbortParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'abort',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    if (!params?.reason) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'abort',
        'E_INVALID_INPUT',
        'reason is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'abort',
      flags: { epic: params.epicId, reason: params.reason, json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'abort', startTime);
  }

  /**
   * analyze - Analyze dependencies
   * CLI: cleo orchestrator analyze <epicId>
   */
  private async mutateAnalyze(params: OrchestrateAnalyzeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'analyze',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'analyze',
      args: [params.epicId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'analyze', startTime);
  }

  /**
   * skill.list - List available skills
   * CLI: cleo skill list [--filter <filter>]
   */
  private async querySkillList(params: OrchestrateSkillListParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.filter) flags.filter = params.filter;

    const result = await this.executor!.execute({
      domain: 'skill',
      operation: 'list',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'skill.list', startTime);
  }

  /**
   * analyze (query) - Analyze dependencies (read-only)
   * CLI: cleo orchestrator analyze <epicId>
   */
  private async queryAnalyze(params: OrchestrateAnalyzeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId) {
      return this.createErrorResponse(
        'cleo_query',
        'orchestrate',
        'analyze',
        'E_INVALID_INPUT',
        'epicId is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'analyze',
      args: [params.epicId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'orchestrate', 'analyze', startTime);
  }

  /**
   * validate - Validate spawn readiness
   * CLI: cleo orchestrator validate <taskId>
   */
  private async mutateValidate(params: OrchestrateValidateParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'validate',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'validate',
      args: [params.taskId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'validate', startTime);
  }

  /**
   * parallel.start - Start parallel wave
   * CLI: cleo orchestrator parallel start <epicId> <wave>
   */
  private async mutateParallelStart(params: OrchestrateParallelStartParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || params?.wave === undefined) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'parallel.start',
        'E_INVALID_INPUT',
        'epicId and wave are required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'parallel',
      args: ['start', params.epicId, String(params.wave)],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'parallel.start', startTime);
  }

  /**
   * parallel.end - End parallel wave
   * CLI: cleo orchestrator parallel end <epicId> <wave>
   */
  private async mutateParallelEnd(params: OrchestrateParallelEndParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.epicId || params?.wave === undefined) {
      return this.createErrorResponse(
        'cleo_mutate',
        'orchestrate',
        'parallel.end',
        'E_INVALID_INPUT',
        'epicId and wave are required',
        startTime
      );
    }

    const result = await this.executor!.execute({
      domain: 'orchestrator',
      operation: 'parallel',
      args: ['end', params.epicId, String(params.wave)],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'orchestrate', 'parallel.end', startTime);
  }

  // ===== Helper Methods =====

  /**
   * Wrap executor result in DomainResponse format
   */
  private wrapExecutorResult(
    result: any,
    gateway: string,
    domain: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    if (result.success) {
      return {
        _meta: createGatewayMeta(gateway, domain, operation, startTime),
        success: true,
        data: result.data,
      };
    }

    return {
      _meta: createGatewayMeta(gateway, domain, operation, startTime),
      success: false,
      error: result.error,
    };
  }

  /**
   * Create error response
   */
  private createErrorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number
  ): DomainResponse {
    return {
      _meta: createGatewayMeta(gateway, domain, operation, startTime),
      success: false,
      error: {
        code,
        message,
      },
    };
  }

  /**
   * Handle unexpected errors
   */
  private handleError(
    gateway: string,
    domain: string,
    operation: string,
    error: unknown,
    startTime: number
  ): DomainResponse {
    return this.createErrorResponse(
      gateway,
      domain,
      operation,
      'E_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime
    );
  }
}
