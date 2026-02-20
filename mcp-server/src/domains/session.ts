/**
 * Session Domain Handler
 *
 * Implements session operations for CLEO MCP server:
 * - Query (5): status, list, show, history, decision.log, context.drift
 * - Mutate (7): start, end, resume, suspend, gc, record.decision, record.assumption
 *
 * Focus operations (current/start/stop) have moved to the tasks domain
 * per API Terminology Standardization (T4732).
 *
 * @task T2930
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  sessionStatus as nativeSessionStatus,
  sessionList as nativeSessionList,
  sessionShow as nativeSessionShow,
  sessionStart as nativeSessionStart,
  sessionEnd as nativeSessionEnd,
  resolveProjectRoot,
  isProjectInitialized,
} from '../engine/index.js';
import { createCLIRequiredError, createNotInitializedError } from '../lib/mode-detector.js';
import type {
  Session,
  SessionStatusParams,
  SessionStatusResult,
  SessionListParams,
  SessionListResult,
  SessionShowParams,
  SessionShowResult,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionStartParams,
  SessionStartResult,
  SessionEndParams,
  SessionEndResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionSuspendParams,
  SessionSuspendResult,
  SessionGcParams,
  SessionGcResult,
} from '../types/index.js';

/**
 * Additional operation types
 */
interface SessionSwitchParams {
  sessionId: string;
}

interface SessionStatsParams {
  sessionId?: string;
}

interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  completedTasks: number;
  averageDuration: string;
}

/**
 * Session domain handler implementation
 */
export class SessionHandler implements DomainHandler {
  private executionMode: ResolvedMode;
  private projectRoot: string;

  constructor(private executor?: CLIExecutor, executionMode: ResolvedMode = 'cli') {
    this.executionMode = executionMode;
    this.projectRoot = resolveProjectRoot();
  }

  /**
   * Check if we should use native engine for this operation
   */
  private useNative(operation: string, gateway: GatewayType): boolean {
    if (this.executionMode === 'cli' && this.executor?.isAvailable()) {
      return false;
    }
    return canRunNatively('session', operation, gateway);
  }

  /**
   * Wrap a native engine result in DomainResponse format
   */
  private wrapNativeResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    operation: string,
    startTime: number
  ): DomainResponse {
    const duration_ms = Date.now() - startTime;
    if (result.success) {
      return {
        _meta: { gateway, domain: 'session', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: { gateway, domain: 'session', operation, version: '1.0.0', timestamp: new Date().toISOString(), duration_ms },
      success: false,
      error: { code: result.error?.code || 'E_UNKNOWN', message: result.error?.message || 'Unknown error' },
    };
  }

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'query')) {
      try {
        return this.queryNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_query', 'session', operation, error, startTime);
      }
    }

    // Require executor for CLI operations
    if (!this.executor || !this.executor.isAvailable()) {
      const err = createCLIRequiredError('session', operation);
      return this.wrapNativeResult(err, 'cleo_query', operation, startTime);
    }

    try {
      switch (operation) {
        case 'status':
          return await this.queryStatus(params as unknown as SessionStatusParams);
        case 'list':
          return await this.queryList(params as unknown as SessionListParams);
        case 'show':
          return await this.queryShow(params as unknown as SessionShowParams);
        case 'history':
          return await this.queryHistory(params as unknown as SessionHistoryParams);
        case 'stats':
          return await this.queryStats(params as unknown as SessionStatsParams);
        default:
          return this.createErrorResponse(
            'cleo_query',
            'session',
            operation,
            'E_INVALID_OPERATION',
            `Unknown query operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_query', 'session', operation, error, startTime);
    }
  }

  /**
   * Route query operations to native TypeScript engine
   */
  private queryNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): DomainResponse {
    if (!isProjectInitialized(this.projectRoot)) {
      return this.wrapNativeResult(createNotInitializedError(), 'cleo_query', operation, startTime);
    }

    switch (operation) {
      case 'status':
        return this.wrapNativeResult(nativeSessionStatus(this.projectRoot), 'cleo_query', operation, startTime);
      case 'list': {
        const p = params as unknown as SessionListParams;
        return this.wrapNativeResult(
          nativeSessionList(this.projectRoot, { active: p?.active, limit: p?.limit }),
          'cleo_query', operation, startTime
        );
      }
      case 'show': {
        const sessionId = (params as unknown as SessionShowParams)?.sessionId;
        if (!sessionId) {
          return this.createErrorResponse('cleo_query', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
        }
        return this.wrapNativeResult(nativeSessionShow(this.projectRoot, sessionId), 'cleo_query', operation, startTime);
      }
      default:
        return this.createErrorResponse('cleo_query', 'session', operation, 'E_INVALID_OPERATION', `No native handler for: ${operation}`, startTime);
    }
  }

  /**
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Native engine routing for supported operations
    if (this.useNative(operation, 'mutate')) {
      try {
        return await this.mutateNative(operation, params, startTime);
      } catch (error) {
        return this.handleError('cleo_mutate', 'session', operation, error, startTime);
      }
    }

    // Require executor for CLI operations
    if (!this.executor || !this.executor.isAvailable()) {
      const err = createCLIRequiredError('session', operation);
      return this.wrapNativeResult(err, 'cleo_mutate', operation, startTime);
    }

    try {
      switch (operation) {
        case 'start':
          return await this.mutateStart(params as unknown as SessionStartParams);
        case 'end':
          return await this.mutateEnd(params as unknown as SessionEndParams);
        case 'resume':
          return await this.mutateResume(params as unknown as SessionResumeParams);
        case 'suspend':
          return await this.mutateSuspend(params as unknown as SessionSuspendParams);
        case 'gc':
          return await this.mutateGc(params as unknown as SessionGcParams);
        default:
          return this.createErrorResponse(
            'cleo_mutate',
            'session',
            operation,
            'E_INVALID_OPERATION',
            `Unknown mutate operation: ${operation}`,
            startTime
          );
      }
    } catch (error) {
      return this.handleError('cleo_mutate', 'session', operation, error, startTime);
    }
  }

  /**
   * Route mutate operations to native TypeScript engine
   */
  private async mutateNative(
    operation: string,
    params: Record<string, unknown> | undefined,
    startTime: number
  ): Promise<DomainResponse> {
    if (!isProjectInitialized(this.projectRoot)) {
      return this.wrapNativeResult(createNotInitializedError(), 'cleo_mutate', operation, startTime);
    }

    switch (operation) {
      case 'start': {
        const p = params as unknown as SessionStartParams;
        if (!p?.scope) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT', 'scope is required', startTime);
        }
        const result = await nativeSessionStart(this.projectRoot, {
          scope: p.scope,
          name: p.name,
          autoStart: p.autoStart,
          startTask: p.startTask,
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'end': {
        const p = params as unknown as SessionEndParams;
        const result = await nativeSessionEnd(this.projectRoot, p?.notes);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      default:
        return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_OPERATION', `No native handler for: ${operation}`, startTime);
    }
  }

  /**
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'list', 'show', 'history', 'decision.log', 'context.drift'],
      mutate: [
        'start', 'end', 'resume',
        'suspend', 'gc',
        'record.decision', 'record.assumption',
      ],
    };
  }

  // ===== Query Operations =====

  /**
   * status - Get current session status
   * CLI: cleo session status
   */
  private async queryStatus(params: SessionStatusParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<SessionStatusResult>({
      domain: 'session',
      operation: 'status',
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'status', startTime);
  }

  /**
   * list - List all sessions
   * CLI: cleo session list [--status active|suspended|ended|all]
   */
  private async queryList(params: SessionListParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    // CLI uses --status <value>, not --active boolean flag
    if (params?.active === true) {
      flags.status = 'active';
    } else if (params?.active === false) {
      // active=false means show non-active sessions; default CLI shows all,
      // so we don't set a status filter (no CLI flag for "not active")
    }

    const result = await this.executor!.execute<SessionListResult>({
      domain: 'session',
      operation: 'list',
      flags,
    });

    // Apply limit post-processing since CLI doesn't support --limit
    if (result.success && params?.limit && result.data) {
      const data = result.data as unknown as Record<string, unknown>;
      if (data && typeof data === 'object' && Array.isArray(data.sessions)) {
        data.sessions = (data.sessions as unknown[]).slice(0, params.limit);
        data.count = (data.sessions as unknown[]).length;
      } else if (Array.isArray(result.data)) {
        result.data = (result.data as unknown as unknown[]).slice(0, params.limit) as SessionListResult;
      }
    }

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'list', startTime);
  }

  /**
   * show - Show session details
   * CLI: cleo session show <sessionId>
   */
  private async queryShow(params: SessionShowParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.sessionId) {
      return this.createErrorResponse(
        'cleo_query',
        'session',
        'show',
        'E_INVALID_INPUT',
        'sessionId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<SessionShowResult>({
      domain: 'session',
      operation: 'show',
      args: [params.sessionId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'show', startTime);
  }

  /**
   * history - Session history
   * CLI: cleo session history [--limit <n>]
   */
  private async queryHistory(params: SessionHistoryParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.limit) flags.limit = params.limit;

    const result = await this.executor!.execute<SessionHistoryResult>({
      domain: 'session',
      operation: 'history',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'history', startTime);
  }

  /**
   * stats - Session statistics
   * CLI: cleo session stats [<sessionId>]
   */
  private async queryStats(params: SessionStatsParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<SessionStats>({
      domain: 'session',
      operation: 'stats',
      args: params?.sessionId ? [params.sessionId] : [],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'stats', startTime);
  }

  // ===== Mutate Operations =====

  /**
   * start - Start new session
   * CLI: cleo session start --scope <scope> [--name <name>] [--auto-start] [--start-task <id>]
   */
  private async mutateStart(params: SessionStartParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.scope) {
      return this.createErrorResponse(
        'cleo_mutate',
        'session',
        'start',
        'E_INVALID_INPUT',
        'scope is required',
        startTime
      );
    }

    const flags: Record<string, unknown> = {
      json: true,
      scope: params.scope,
    };

    if (params?.name) flags.name = params.name;
    if (params?.autoStart) flags['auto-start'] = true;
    if (params?.startTask) flags['start-task'] = params.startTask;

    const result = await this.executor!.execute<SessionStartResult>({
      domain: 'session',
      operation: 'start',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'start', startTime);
  }

  /**
   * end - End current session
   * CLI: cleo session end [--note <note>]
   */
  private async mutateEnd(params: SessionEndParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.notes) flags.note = params.notes;

    const result = await this.executor!.execute<SessionEndResult>({
      domain: 'session',
      operation: 'end',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'end', startTime);
  }

  /**
   * resume - Resume existing session
   * CLI: cleo session resume <sessionId>
   */
  private async mutateResume(params: SessionResumeParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.sessionId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'session',
        'resume',
        'E_INVALID_INPUT',
        'sessionId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<SessionResumeResult>({
      domain: 'session',
      operation: 'resume',
      args: [params.sessionId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'resume', startTime);
  }

  /**
   * suspend - Suspend current session
   * CLI: cleo session suspend [--notes "..."]
   */
  private async mutateSuspend(params: SessionSuspendParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.notes) flags.notes = params.notes;

    const result = await this.executor!.execute<SessionSuspendResult>({
      domain: 'session',
      operation: 'suspend',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'suspend', startTime);
  }

  /**
   * gc - Garbage collect old sessions
   * CLI: cleo session gc [--older-than N]
   */
  private async mutateGc(params: SessionGcParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.olderThan) flags['older-than'] = params.olderThan;

    const result = await this.executor!.execute<SessionGcResult>({
      domain: 'session',
      operation: 'gc',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'gc', startTime);
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
    const duration_ms = Date.now() - startTime;

    if (result.success) {
      return {
        _meta: {
          gateway,
          domain,
          operation,
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          duration_ms,
        },
        success: true,
        data: result.data,
      };
    }

    return {
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms,
      },
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
      _meta: {
        gateway,
        domain,
        operation,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      },
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
