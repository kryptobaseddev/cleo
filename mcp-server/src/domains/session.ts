/**
 * Session Domain Handler
 *
 * Implements all 17 session operations for CLEO MCP server:
 * - Query (7): status, list, show, focus-show, focus.get, history, stats
 * - Mutate (10): start, end, resume, switch, focus-set, focus.set, focus-clear, focus.clear, archive, cleanup, suspend, gc
 *
 * Each operation maps to corresponding CLEO CLI commands with proper
 * parameter validation and error handling.
 *
 * @task T2930
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import type {
  Session,
  FocusInfo,
  SessionStatusParams,
  SessionStatusResult,
  SessionListParams,
  SessionListResult,
  SessionShowParams,
  SessionShowResult,
  SessionFocusGetParams,
  SessionFocusGetResult,
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
  SessionFocusSetParams,
  SessionFocusSetResult,
  SessionFocusClearParams,
  SessionFocusClearResult,
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
  constructor(private executor?: CLIExecutor) {}

  /**
   * Query operations (read-only)
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Require executor for all operations
    if (!this.executor) {
      return this.createErrorResponse(
        'cleo_query',
        'session',
        operation,
        'E_NOT_INITIALIZED',
        'Session handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'status':
          return await this.queryStatus(params as unknown as SessionStatusParams);
        case 'list':
          return await this.queryList(params as unknown as SessionListParams);
        case 'show':
          return await this.queryShow(params as unknown as SessionShowParams);
        case 'focus-show':
          return await this.queryFocusShow(params as unknown as SessionFocusGetParams);
        case 'focus.get':
          return await this.queryFocusShow(params as unknown as SessionFocusGetParams);
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
   * Mutate operations (write)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    const startTime = Date.now();

    // Require executor for all operations
    if (!this.executor) {
      return this.createErrorResponse(
        'cleo_mutate',
        'session',
        operation,
        'E_NOT_INITIALIZED',
        'Session handler not initialized with executor',
        startTime
      );
    }

    try {
      switch (operation) {
        case 'start':
          return await this.mutateStart(params as unknown as SessionStartParams);
        case 'end':
          return await this.mutateEnd(params as unknown as SessionEndParams);
        case 'resume':
          return await this.mutateResume(params as unknown as SessionResumeParams);
        case 'switch':
          return await this.mutateSwitch(params as unknown as SessionSwitchParams);
        case 'focus-set':
          return await this.mutateFocusSet(params as unknown as SessionFocusSetParams);
        case 'focus-clear':
          return await this.mutateFocusClear(params as unknown as SessionFocusClearParams);
        case 'archive':
          return await this.mutateArchive(params as unknown as SessionGcParams);
        case 'cleanup':
          return await this.mutateCleanup(params as unknown as SessionGcParams);
        case 'suspend':
          return await this.mutateSuspend(params as unknown as SessionSuspendParams);
        case 'gc':
          return await this.mutateGc(params as unknown as SessionGcParams);
        case 'focus.set':
          return await this.mutateFocusSet(params as unknown as SessionFocusSetParams);
        case 'focus.clear':
          return await this.mutateFocusClear(params as unknown as SessionFocusClearParams);
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
   * Get supported operations
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'list', 'show', 'focus-show', 'focus.get', 'history', 'stats'],
      mutate: [
        'start', 'end', 'resume', 'switch',
        'focus-set', 'focus.set',
        'focus-clear', 'focus.clear',
        'archive', 'cleanup',
        'suspend', 'gc',
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
   * focus-show - Get current focused task
   * CLI: cleo focus show
   */
  private async queryFocusShow(params: SessionFocusGetParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<SessionFocusGetResult>({
      domain: 'focus',
      operation: 'show',
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_query', 'session', 'focus-show', startTime);
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
   * CLI: cleo session start --scope <scope> [--name <name>] [--auto-focus] [--focus <id>]
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
    if (params?.autoFocus) flags['auto-focus'] = true;
    if (params?.focus) flags.focus = params.focus;

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
   * switch - Switch to different session
   * CLI: cleo session switch <sessionId>
   */
  private async mutateSwitch(params: SessionSwitchParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.sessionId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'session',
        'switch',
        'E_INVALID_INPUT',
        'sessionId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<Session>({
      domain: 'session',
      operation: 'switch',
      args: [params.sessionId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'switch', startTime);
  }

  /**
   * focus-set - Set focused task
   * CLI: cleo focus set <taskId>
   */
  private async mutateFocusSet(params: SessionFocusSetParams): Promise<DomainResponse> {
    const startTime = Date.now();

    if (!params?.taskId) {
      return this.createErrorResponse(
        'cleo_mutate',
        'session',
        'focus-set',
        'E_INVALID_INPUT',
        'taskId is required',
        startTime
      );
    }

    const result = await this.executor!.execute<SessionFocusSetResult>({
      domain: 'focus',
      operation: 'set',
      args: [params.taskId],
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'focus-set', startTime);
  }

  /**
   * focus-clear - Clear focused task
   * CLI: cleo focus clear
   */
  private async mutateFocusClear(params: SessionFocusClearParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const result = await this.executor!.execute<SessionFocusClearResult>({
      domain: 'focus',
      operation: 'clear',
      flags: { json: true },
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'focus-clear', startTime);
  }

  /**
   * archive - Archive old sessions
   * CLI: cleo session archive [--older-than <date>]
   */
  private async mutateArchive(params: SessionGcParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.olderThan) flags['older-than'] = params.olderThan;

    const result = await this.executor!.execute<SessionGcResult>({
      domain: 'session',
      operation: 'archive',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'archive', startTime);
  }

  /**
   * cleanup - Clean up ended sessions
   * CLI: cleo session cleanup [--older-than <date>]
   */
  private async mutateCleanup(params: SessionGcParams): Promise<DomainResponse> {
    const startTime = Date.now();

    const flags: Record<string, unknown> = { json: true };
    if (params?.olderThan) flags['older-than'] = params.olderThan;

    const result = await this.executor!.execute<SessionGcResult>({
      domain: 'session',
      operation: 'cleanup',
      flags,
    });

    return this.wrapExecutorResult(result, 'cleo_mutate', 'session', 'cleanup', startTime);
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
