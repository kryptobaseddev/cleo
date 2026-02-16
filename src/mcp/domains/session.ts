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
import { canRunNatively, type GatewayType } from '../engine/capability-matrix.js';
import type { ResolvedMode } from '../lib/mode-detector.js';
import {
  sessionStatus as nativeSessionStatus,
  sessionList as nativeSessionList,
  sessionShow as nativeSessionShow,
  focusGet as nativeFocusGet,
  focusSet as nativeFocusSet,
  focusClear as nativeFocusClear,
  sessionStart as nativeSessionStart,
  sessionEnd as nativeSessionEnd,
  sessionResume as nativeSessionResume,
  sessionGc as nativeSessionGc,
  sessionSuspend as nativeSessionSuspend,
  sessionHistory as nativeSessionHistory,
  sessionCleanup as nativeSessionCleanup,
  sessionRecordDecision as nativeSessionRecordDecision,
  sessionDecisionLog as nativeSessionDecisionLog,
  sessionContextDrift as nativeSessionContextDrift,
  sessionRecordAssumption as nativeSessionRecordAssumption,
  sessionStats as nativeSessionStats,
  sessionSwitch as nativeSessionSwitch,
  sessionArchive as nativeSessionArchive,
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
        case 'focus-show':
          return await this.queryFocusShow(params as unknown as SessionFocusGetParams);
        case 'focus.get':
          return await this.queryFocusShow(params as unknown as SessionFocusGetParams);
        case 'history':
          return await this.queryHistory(params as unknown as SessionHistoryParams);
        case 'stats':
          return await this.queryStats(params as unknown as SessionStatsParams);
        case 'decision-log':
          return this.queryNative('decision-log', params, startTime);
        case 'context-drift':
          return this.queryNative('context-drift', params, startTime);
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
      case 'focus-show':
      case 'focus.get':
        return this.wrapNativeResult(nativeFocusGet(this.projectRoot), 'cleo_query', operation, startTime);
      case 'history': {
        const p = params as unknown as SessionHistoryParams;
        return this.wrapNativeResult(
          nativeSessionHistory(this.projectRoot, { limit: p?.limit }),
          'cleo_query', operation, startTime
        );
      }
      case 'decision-log': {
        const p = params as Record<string, unknown> | undefined;
        return this.wrapNativeResult(
          nativeSessionDecisionLog(this.projectRoot, {
            sessionId: p?.sessionId as string | undefined,
            taskId: p?.taskId as string | undefined,
          }),
          'cleo_query', operation, startTime
        );
      }
      case 'context-drift': {
        const p = params as Record<string, unknown> | undefined;
        return this.wrapNativeResult(
          nativeSessionContextDrift(this.projectRoot, {
            sessionId: p?.sessionId as string | undefined,
          }),
          'cleo_query', operation, startTime
        );
      }
      case 'stats': {
        const p = params as unknown as SessionStatsParams;
        return this.wrapNativeResult(
          nativeSessionStats(this.projectRoot, p?.sessionId),
          'cleo_query', operation, startTime
        );
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
        case 'record-decision':
          return await this.mutateNative('record-decision', params, startTime);
        case 'record-assumption':
          return await this.mutateNative('record-assumption', params, startTime);
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
          autoFocus: p.autoFocus,
          focus: p.focus,
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'end': {
        const p = params as unknown as SessionEndParams;
        const result = await nativeSessionEnd(this.projectRoot, p?.notes);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'focus-set':
      case 'focus.set': {
        const taskId = (params as unknown as SessionFocusSetParams)?.taskId;
        if (!taskId) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
        }
        const result = await nativeFocusSet(this.projectRoot, taskId);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'focus-clear':
      case 'focus.clear': {
        const result = await nativeFocusClear(this.projectRoot);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'resume': {
        const p = params as unknown as SessionResumeParams;
        if (!p?.sessionId) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
        }
        const result = await nativeSessionResume(this.projectRoot, p.sessionId);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'gc': {
        const p = params as unknown as SessionGcParams;
        const maxAgeDays = p?.olderThan ? parseInt(String(p.olderThan), 10) : undefined;
        const result = await nativeSessionGc(this.projectRoot, maxAgeDays);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'suspend': {
        const p = params as unknown as SessionSuspendParams;
        // Suspend requires a sessionId; use current active session from todo.json
        const statusResult = nativeSessionStatus(this.projectRoot);
        const activeSessionId = (statusResult.data as any)?.session?.id;
        if (!activeSessionId) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_NO_ACTIVE_SESSION', 'No active session to suspend', startTime);
        }
        const result = await nativeSessionSuspend(this.projectRoot, activeSessionId, p?.notes);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'cleanup': {
        const result = await nativeSessionCleanup(this.projectRoot);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'record-decision': {
        const p = params as Record<string, unknown> | undefined;
        if (!p?.sessionId || !p?.taskId || !p?.decision || !p?.rationale) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT',
            'sessionId, taskId, decision, and rationale are required', startTime);
        }
        const result = nativeSessionRecordDecision(this.projectRoot, {
          sessionId: p.sessionId as string,
          taskId: p.taskId as string,
          decision: p.decision as string,
          rationale: p.rationale as string,
          alternatives: (p.alternatives as string[]) || [],
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'record-assumption': {
        const p = params as Record<string, unknown> | undefined;
        if (!p?.assumption || !p?.confidence) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT',
            'assumption and confidence are required', startTime);
        }
        const result = nativeSessionRecordAssumption(this.projectRoot, {
          sessionId: p.sessionId as string | undefined,
          taskId: p.taskId as string | undefined,
          assumption: p.assumption as string,
          confidence: p.confidence as 'high' | 'medium' | 'low',
        });
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'switch': {
        const p = params as unknown as SessionSwitchParams;
        if (!p?.sessionId) {
          return this.createErrorResponse('cleo_mutate', 'session', operation, 'E_INVALID_INPUT', 'sessionId is required', startTime);
        }
        const result = await nativeSessionSwitch(this.projectRoot, p.sessionId);
        return this.wrapNativeResult(result, 'cleo_mutate', operation, startTime);
      }
      case 'archive': {
        const p = params as unknown as SessionGcParams;
        const result = await nativeSessionArchive(this.projectRoot, p?.olderThan as string | undefined);
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
      query: ['status', 'list', 'show', 'focus-show', 'focus.get', 'history', 'stats', 'decision-log', 'context-drift'],
      mutate: [
        'start', 'end', 'resume', 'switch',
        'focus-set', 'focus.set',
        'focus-clear', 'focus.clear',
        'archive', 'cleanup',
        'suspend', 'gc',
        'record-decision', 'record-assumption',
      ],
    };
  }

  // ===== Query Operations =====

  /**
   * status - Get current session status
   * CLI: cleo session status
   */
  private async queryStatus(_params: SessionStatusParams): Promise<DomainResponse> {
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
  private async queryFocusShow(_params: SessionFocusGetParams): Promise<DomainResponse> {
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
  private async mutateFocusClear(_params: SessionFocusClearParams): Promise<DomainResponse> {
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
