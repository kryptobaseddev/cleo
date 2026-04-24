/**
 * Playbook Domain Handler (Dispatch Layer)
 *
 * Exposes the four HITL playbook subcommands over the canonical dispatch
 * surface:
 *
 *  - `cleo playbook run <name>`    — mutate : load a `.cantbook` by name and
 *                                      drive `executePlaybook` through the
 *                                      runtime state machine (T930).
 *  - `cleo playbook list`           — query  : enumerate runs from
 *                                      `playbook_runs` with optional status
 *                                      filter.
 *  - `cleo playbook status <id>`   — query  : fetch a single run record.
 *  - `cleo playbook resume <id>`   — mutate : resume a paused run once its
 *                                      HITL gate has transitioned to
 *                                      `approved` (see T908 / W4-16).
 *
 * All responses conform to the LAFS envelope contract (ADR-039) via the
 * shared `_base.ts` helpers — `errorResult`, `handleErrorResult`, and
 * metadata wrappers. The handler never raises; every code path returns a
 * `DispatchResponse` with a structured error envelope on failure.
 *
 * Dependency posture (non-negotiable):
 *  - Uses `getDb` / `getNativeTasksDb` from `@cleocode/core/internal` to
 *    acquire a `DatabaseSync` handle without opening a second connection
 *    to `.cleo/tasks.db` (ADR-006 WAL safety).
 *  - Injects a default dispatcher for `agentic` nodes that routes through
 *    `orchestrateSpawnExecute` so the CLI path mirrors the same adapter
 *    registry used by `cleo orchestrate spawn-execute`.
 *  - Tests override the dispatcher via the `__playbookRuntimeOverrides`
 *    hook exposed below to keep integration tests hermetic.
 *
 * @task T935 — HITL CLI surface for cleo playbook + orchestrate approvals
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PlaybookApproval, PlaybookRun, PlaybookRunStatus } from '@cleocode/contracts';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  E_PLAYBOOK_RESUME_BLOCKED,
  E_PLAYBOOK_RUNTIME_INVALID,
  type ExecutePlaybookResult,
  executePlaybook,
  getPendingApprovals,
  getPlaybookApprovalByToken,
  getPlaybookRun,
  listPlaybookApprovals as listPlaybookApprovalsState,
  listPlaybookRuns as listPlaybookRunsState,
  PlaybookParseError,
  parsePlaybook,
  resumePlaybook,
} from '@cleocode/playbooks';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, getListParams, handleErrorResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// Injection overrides (tests)
// ---------------------------------------------------------------------------

/**
 * Runtime override surface consumed by integration tests.
 *
 * Tests set these to inject an in-memory {@link DatabaseSync} and a
 * deterministic dispatcher so the handler can be exercised without touching
 * the on-disk `tasks.db` or the spawn adapter registry. Production callers
 * never touch these fields — the handler falls back to canonical dependencies.
 *
 * @internal
 */
export interface PlaybookRuntimeOverrides {
  /** Pre-opened `node:sqlite` handle (with the T889 migration applied). */
  db?: _DatabaseSyncType;
  /** Dispatcher to invoke for `agentic` nodes. */
  dispatcher?: AgentDispatcher;
  /**
   * Directory resolver for starter playbooks. Defaults to
   * `packages/playbooks/starter` but tests can point to a fixture dir.
   */
  playbookBaseDirs?: readonly string[];
  /** Secret used for HMAC resume-token generation (tests pass a stable value). */
  approvalSecret?: string;
}

/**
 * Mutable override slot — tests assign before invoking the handler. Always
 * reset in `afterEach` to avoid bleed-over between test cases.
 *
 * @internal
 */
export const __playbookRuntimeOverrides: PlaybookRuntimeOverrides = {};

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** Run-envelope payload returned by `playbook.run` / `playbook.resume`. */
interface PlaybookRunEnvelope {
  runId: string;
  terminalStatus: ExecutePlaybookResult['terminalStatus'];
  finalContext: Record<string, unknown>;
  approvalToken?: string;
  failedNodeId?: string;
  exceededNodeId?: string;
  errorContext?: string;
}

/** List-envelope shape returned by `playbook.list`. */
interface PlaybookListEnvelope {
  /** Ordered from newest to oldest; pagination applied client-side. */
  runs: PlaybookRun[];
  count: number;
  total: number;
  /** Effective status filter (after `active|completed|pending` translation). */
  statusFilter?: PlaybookRunStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate the CLI-friendly status filter into the DB-level enum value.
 *
 * The task spec exposes `active|completed|pending` on the CLI which maps to
 * the canonical `PlaybookRunStatus` values:
 *  - `active`    → `running`
 *  - `completed` → `completed`
 *  - `pending`   → `paused`
 *
 * Unrecognised values are returned verbatim when they already match a valid
 * status; otherwise the caller receives `undefined` so the query proceeds
 * without filtering.
 *
 * @internal
 */
function normalizeListStatus(raw: unknown): PlaybookRunStatus | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const value = raw.trim().toLowerCase();
  switch (value) {
    case 'active':
    case 'running':
      return 'running';
    case 'pending':
    case 'paused':
      return 'paused';
    case 'completed':
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return undefined;
  }
}

/**
 * Resolve the list of directories to search for `<name>.cantbook` files.
 *
 * Order of precedence:
 *   1. `__playbookRuntimeOverrides.playbookBaseDirs` (tests only)
 *   2. `~/.local/share/cleo/playbooks` (user-installed)
 *   3. Sibling package starter dir (`packages/playbooks/starter`)
 *
 * @internal
 */
function resolvePlaybookDirs(): readonly string[] {
  if (__playbookRuntimeOverrides.playbookBaseDirs) {
    return __playbookRuntimeOverrides.playbookBaseDirs;
  }
  const globalDir = join(homedir(), '.local', 'share', 'cleo', 'playbooks');
  const here = dirname(fileURLToPath(import.meta.url));
  // Canonical source layout: packages/cleo/src/dispatch/domains/playbook.ts
  //                 → ../../../../playbooks/starter
  // Bundled layout:   packages/cleo/dist/cli/commands/... keep parallel fallback.
  const sourceStarter = resolvePath(here, '..', '..', '..', '..', 'playbooks', 'starter');
  const bundledStarter = resolvePath(here, '..', '..', '..', 'playbooks', 'starter');
  return [globalDir, sourceStarter, bundledStarter];
}

/**
 * Load and parse a `.cantbook` by name. Returns `null` if the file does not
 * exist in any of the resolved directories.
 *
 * @internal
 */
function loadPlaybookByName(name: string): { sourcePath: string; source: string } | null {
  const candidates = resolvePlaybookDirs();
  const fileName = name.endsWith('.cantbook') ? name : `${name}.cantbook`;
  for (const dir of candidates) {
    const full = join(dir, fileName);
    if (existsSync(full)) {
      return { sourcePath: full, source: readFileSync(full, 'utf8') };
    }
  }
  return null;
}

/**
 * Safe JSON.parse for the `--context` CLI flag. Returns the parsed object on
 * success, or throws a typed error carrying the parse reason on failure.
 *
 * @internal
 */
function parseContextJson(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') {
    throw new Error(`context must be a JSON object, got ${typeof raw}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('context JSON must decode to an object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid context JSON: ${message}`);
  }
}

/**
 * Acquire a `DatabaseSync` handle pointing at the project's `.cleo/tasks.db`.
 *
 * Prefers the override (test fixtures) then returns the shared singleton from
 * `@cleocode/core/internal`. The singleton is populated on first `getDb()`
 * call and re-used on every subsequent request so concurrent handlers share
 * the same handle (ADR-006 WAL safety).
 *
 * @internal
 */
async function acquireDb(): Promise<_DatabaseSyncType> {
  if (__playbookRuntimeOverrides.db) return __playbookRuntimeOverrides.db;
  const { getDb, getNativeDb } = await import('@cleocode/core/internal');
  await getDb();
  const native = getNativeDb();
  if (!native) {
    throw new Error('playbook dispatch: tasks.db singleton was not initialized by getDb()');
  }
  return native;
}

/**
 * Build a default {@link AgentDispatcher} that routes `agentic` nodes through
 * the existing spawn adapter. When tests override the dispatcher they bypass
 * this factory entirely.
 *
 * @internal
 */
async function buildDefaultDispatcher(): Promise<AgentDispatcher> {
  if (__playbookRuntimeOverrides.dispatcher) return __playbookRuntimeOverrides.dispatcher;
  const { orchestrateSpawnExecute } = await import('../lib/engine.js');
  const { getProjectRoot } = await import('@cleocode/core/internal');
  const projectRoot = getProjectRoot();
  return {
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      try {
        const result = await orchestrateSpawnExecute(
          input.taskId,
          /* adapterId */ undefined,
          /* protocolType */ undefined,
          projectRoot,
          /* tier */ undefined,
        );
        if (result.success) {
          return {
            status: 'success',
            output: {
              [`${input.nodeId}_spawn`]: true,
              nodeId: input.nodeId,
              agentId: input.agentId,
              dispatchData: result.data ?? null,
            },
          };
        }
        return {
          status: 'failure',
          output: {},
          error: result.error?.message ?? `spawn failed for ${input.agentId}`,
        };
      } catch (err) {
        return {
          status: 'failure',
          output: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Fold {@link ExecutePlaybookResult} into the handler's envelope shape, keeping
 * optional keys absent when unset so downstream JSON emitters stay terse.
 *
 * @internal
 */
function toRunEnvelope(result: ExecutePlaybookResult): PlaybookRunEnvelope {
  const envelope: PlaybookRunEnvelope = {
    runId: result.runId,
    terminalStatus: result.terminalStatus,
    finalContext: result.finalContext,
  };
  if (result.approvalToken !== undefined) envelope.approvalToken = result.approvalToken;
  if (result.failedNodeId !== undefined) envelope.failedNodeId = result.failedNodeId;
  if (result.exceededNodeId !== undefined) envelope.exceededNodeId = result.exceededNodeId;
  if (result.errorContext !== undefined) envelope.errorContext = result.errorContext;
  return envelope;
}

// ---------------------------------------------------------------------------
// PlaybookHandler
// ---------------------------------------------------------------------------

/**
 * Canonical dispatch handler for the `playbook` domain.
 *
 * Each CLI subcommand routes through exactly one of the four operations:
 *   - `query  playbook.status` → {@link PlaybookHandler.query}
 *   - `query  playbook.list`   → {@link PlaybookHandler.query}
 *   - `mutate playbook.run`    → {@link PlaybookHandler.mutate}
 *   - `mutate playbook.resume` → {@link PlaybookHandler.mutate}
 *
 * @task T935
 */
export class PlaybookHandler implements DomainHandler {
  /**
   * Query gateway — `status`, `list`, and `validate`.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'status':
          return this.handleStatus(params, startTime);
        case 'list':
          return this.handleList(params, startTime);
        case 'validate':
          return this.handleValidate(params, startTime);
        default:
          return errorResult(
            'query',
            'playbook',
            operation,
            'E_INVALID_OPERATION',
            `Unknown playbook query: ${operation}`,
            startTime,
          );
      }
    } catch (err) {
      return handleErrorResult('query', 'playbook', operation, err, startTime);
    }
  }

  /**
   * Mutate gateway — `run` and `resume`.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'run':
          return this.handleRun(params, startTime);
        case 'resume':
          return this.handleResume(params, startTime);
        default:
          return errorResult(
            'mutate',
            'playbook',
            operation,
            'E_INVALID_OPERATION',
            `Unknown playbook mutation: ${operation}`,
            startTime,
          );
      }
    } catch (err) {
      return handleErrorResult('mutate', 'playbook', operation, err, startTime);
    }
  }

  /**
   * Exposed operations for dispatcher introspection + parity tests.
   */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'list', 'validate'],
      mutate: ['run', 'resume'],
    };
  }

  // -----------------------------------------------------------------------
  // Operation implementations
  // -----------------------------------------------------------------------

  private async handleStatus(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const runId = params?.runId as string | undefined;
    if (!runId) {
      return errorResult(
        'query',
        'playbook',
        'status',
        'E_INVALID_INPUT',
        'runId is required',
        startTime,
      );
    }
    const db = await acquireDb();
    const run = getPlaybookRun(db, runId);
    if (run === null) {
      return errorResult(
        'query',
        'playbook',
        'status',
        'E_NOT_FOUND',
        `playbook run ${runId} not found`,
        startTime,
      );
    }
    return {
      meta: dispatchMeta('query', 'playbook', 'status', startTime),
      success: true,
      data: run,
    };
  }

  private async handleList(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const statusFilter = normalizeListStatus(params?.status);
    const epicId = typeof params?.epicId === 'string' ? params.epicId : undefined;
    const { limit, offset } = getListParams(params);

    const db = await acquireDb();
    const opts: Parameters<typeof listPlaybookRunsState>[1] = {};
    if (statusFilter !== undefined) opts.status = statusFilter;
    if (epicId !== undefined) opts.epicId = epicId;
    if (typeof limit === 'number') opts.limit = limit;
    const runs = listPlaybookRunsState(db, opts);

    // Offset is applied after fetch since listPlaybookRuns only supports LIMIT.
    const paged = typeof offset === 'number' ? runs.slice(offset) : runs;

    const envelope: PlaybookListEnvelope = {
      runs: paged,
      count: paged.length,
      total: runs.length,
    };
    if (statusFilter !== undefined) envelope.statusFilter = statusFilter;

    return {
      meta: dispatchMeta('query', 'playbook', 'list', startTime),
      success: true,
      data: envelope,
    };
  }

  /**
   * Validate a `.cantbook` file at an absolute path or a playbook name.
   *
   * Accepts either:
   *  - `file` — absolute or relative path to a `.cantbook` file on disk.
   *  - `name` — playbook name resolved through the standard search path.
   *
   * Returns a LAFS envelope with `valid: true` on success, or an error
   * envelope with `E_PLAYBOOK_PARSE` and the field/message on failure.
   * Exit code 70 is passed through from {@link PlaybookParseError}.
   *
   * @task T1261 PSYCHE E4
   */
  private async handleValidate(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const file = params?.file as string | undefined;
    const name = params?.name as string | undefined;

    if (!file && !name) {
      return errorResult(
        'query',
        'playbook',
        'validate',
        'E_INVALID_INPUT',
        'Either file (path) or name (playbook name) is required',
        startTime,
      );
    }

    let source: string;
    let sourcePath: string;

    if (file) {
      // Absolute or relative file path.
      const { existsSync, readFileSync } = await import('node:fs');
      const { resolve: resolvePath } = await import('node:path');
      const resolved = resolvePath(file);
      if (!existsSync(resolved)) {
        return errorResult(
          'query',
          'playbook',
          'validate',
          'E_NOT_FOUND',
          `playbook file not found: ${resolved}`,
          startTime,
        );
      }
      sourcePath = resolved;
      source = readFileSync(resolved, 'utf8');
    } else {
      // Resolve by name through the standard search path.
      const loaded = loadPlaybookByName(name!);
      if (loaded === null) {
        return errorResult(
          'query',
          'playbook',
          'validate',
          'E_NOT_FOUND',
          `playbook "${name}" not found in any search path`,
          startTime,
        );
      }
      sourcePath = loaded.sourcePath;
      source = loaded.source;
    }

    try {
      const { definition, sourceHash } = parsePlaybook(source);
      return {
        meta: dispatchMeta('query', 'playbook', 'validate', startTime),
        success: true,
        data: {
          valid: true,
          sourcePath,
          sourceHash,
          name: definition.name,
          version: definition.version,
          nodeCount: definition.nodes.length,
          edgeCount: definition.edges.length,
          hasRequires: definition.nodes.some((n) => n.requires !== undefined),
          hasEnsures: definition.nodes.some((n) => n.ensures !== undefined),
          hasErrorHandlers: (definition.error_handlers?.length ?? 0) > 0,
        },
      };
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        return errorResult(
          'query',
          'playbook',
          'validate',
          err.code,
          `${err.message}${err.field ? ` [field=${err.field}]` : ''}`,
          startTime,
        );
      }
      return errorResult(
        'query',
        'playbook',
        'validate',
        'E_PLAYBOOK_PARSE',
        err instanceof Error ? err.message : String(err),
        startTime,
      );
    }
  }

  private async handleRun(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const name = params?.name as string | undefined;
    if (!name) {
      return errorResult(
        'mutate',
        'playbook',
        'run',
        'E_INVALID_INPUT',
        'name is required',
        startTime,
      );
    }
    let initialContext: Record<string, unknown>;
    try {
      initialContext = parseContextJson(params?.context);
    } catch (err) {
      return errorResult(
        'mutate',
        'playbook',
        'run',
        'E_INVALID_INPUT',
        err instanceof Error ? err.message : String(err),
        startTime,
      );
    }

    const loaded = loadPlaybookByName(name);
    if (loaded === null) {
      return errorResult(
        'mutate',
        'playbook',
        'run',
        'E_NOT_FOUND',
        `playbook "${name}" not found in any search path`,
        startTime,
      );
    }

    // Parse + validate .cantbook via the canonical parser so syntax errors
    // surface before a DB row is ever written.
    let parsed: ReturnType<typeof parsePlaybook>;
    try {
      parsed = parsePlaybook(loaded.source);
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        return errorResult(
          'mutate',
          'playbook',
          'run',
          err.code,
          `${err.message}${err.field ? ` [field=${err.field}]` : ''}`,
          startTime,
        );
      }
      return errorResult(
        'mutate',
        'playbook',
        'run',
        'E_PLAYBOOK_PARSE',
        err instanceof Error ? err.message : String(err),
        startTime,
      );
    }

    const db = await acquireDb();
    const dispatcher = await buildDefaultDispatcher();
    let result: ExecutePlaybookResult;
    try {
      const { getProjectRoot } = await import('@cleocode/core/internal');
      const opts: Parameters<typeof executePlaybook>[0] = {
        db,
        playbook: parsed.definition,
        playbookHash: parsed.sourceHash,
        initialContext,
        dispatcher,
        projectRoot: getProjectRoot(),
      };
      if (__playbookRuntimeOverrides.approvalSecret !== undefined) {
        opts.approvalSecret = __playbookRuntimeOverrides.approvalSecret;
      }
      const epicIdRaw = initialContext['epicId'];
      if (typeof epicIdRaw === 'string') opts.epicId = epicIdRaw;
      const sessionIdRaw = initialContext['sessionId'];
      if (typeof sessionIdRaw === 'string') opts.sessionId = sessionIdRaw;
      result = await executePlaybook(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith(E_PLAYBOOK_RUNTIME_INVALID)
        ? E_PLAYBOOK_RUNTIME_INVALID
        : 'E_PLAYBOOK_RUNTIME';
      return errorResult('mutate', 'playbook', 'run', code, message, startTime);
    }

    return {
      meta: dispatchMeta('mutate', 'playbook', 'run', startTime),
      success: true,
      data: {
        ...toRunEnvelope(result),
        playbookName: parsed.definition.name,
        playbookSource: loaded.sourcePath,
      },
    };
  }

  private async handleResume(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const runId = params?.runId as string | undefined;
    if (!runId) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_INVALID_INPUT',
        'runId is required',
        startTime,
      );
    }
    const db = await acquireDb();
    const run = getPlaybookRun(db, runId);
    if (run === null) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_NOT_FOUND',
        `playbook run ${runId} not found`,
        startTime,
      );
    }

    // The approval token lookup doubles as the "gate still pending?" guard.
    // Locate the most recent approval row for this run via the token stored
    // on the run's most recent approval; fall back to re-loading by runId
    // when no approval has been issued yet.
    const approvals = loadApprovalsForRun(db, runId);
    if (approvals.length === 0) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_APPROVAL_NOT_FOUND',
        `run ${runId} has no approval gates — nothing to resume`,
        startTime,
      );
    }
    // Newest approval first — sorted ascending by requested_at so pick tail.
    const latest = approvals[approvals.length - 1] as PlaybookApproval;
    if (latest.status === 'pending') {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_APPROVAL_PENDING',
        `gate ${latest.approvalId} for run ${runId} is still pending — approve before resuming`,
        startTime,
      );
    }
    if (latest.status === 'rejected') {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_APPROVAL_REJECTED',
        `gate ${latest.approvalId} was rejected${latest.reason ? ` (${latest.reason})` : ''}`,
        startTime,
      );
    }

    // Gate is approved — need the original playbook source to resume. The run
    // row carries `playbook_name` but not the source; re-resolve from the
    // on-disk search path so the hash is re-validated on every resume.
    const loaded = loadPlaybookByName(run.playbookName);
    if (loaded === null) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_NOT_FOUND',
        `playbook "${run.playbookName}" not found — cannot resume run ${runId}`,
        startTime,
      );
    }
    let parsed: ReturnType<typeof parsePlaybook>;
    try {
      parsed = parsePlaybook(loaded.source);
    } catch (err) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_PLAYBOOK_PARSE',
        err instanceof Error ? err.message : String(err),
        startTime,
      );
    }
    if (parsed.sourceHash !== run.playbookHash) {
      return errorResult(
        'mutate',
        'playbook',
        'resume',
        'E_PLAYBOOK_HASH_MISMATCH',
        `playbook "${run.playbookName}" source changed since run started (hash drift)`,
        startTime,
      );
    }

    const dispatcher = await buildDefaultDispatcher();
    try {
      const opts: Parameters<typeof resumePlaybook>[0] = {
        db,
        playbook: parsed.definition,
        approvalToken: latest.token,
        dispatcher,
      };
      if (__playbookRuntimeOverrides.approvalSecret !== undefined) {
        opts.approvalSecret = __playbookRuntimeOverrides.approvalSecret;
      }
      const result = await resumePlaybook(opts);
      return {
        meta: dispatchMeta('mutate', 'playbook', 'resume', startTime),
        success: true,
        data: toRunEnvelope(result),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(E_PLAYBOOK_RESUME_BLOCKED)) {
        return errorResult(
          'mutate',
          'playbook',
          'resume',
          E_PLAYBOOK_RESUME_BLOCKED,
          message,
          startTime,
        );
      }
      return errorResult('mutate', 'playbook', 'resume', 'E_PLAYBOOK_RUNTIME', message, startTime);
    }
  }
}

/**
 * Load all approval rows for a run, ordered ascending by `requested_at`
 * (canonical query in state.ts). Thin wrapper so the handler's intent
 * reads clearly at the call site.
 *
 * @internal
 */
function loadApprovalsForRun(db: _DatabaseSyncType, runId: string): PlaybookApproval[] {
  return listPlaybookApprovalsState(db, runId);
}

/**
 * Pure helper to support orchestrate.approve / orchestrate.reject / pending
 * from the orchestrate domain without re-opening a second handle. Exposed so
 * the orchestrate handler can reuse exactly the same DB acquisition path.
 *
 * @internal
 */
export async function acquirePlaybookDb(): Promise<_DatabaseSyncType> {
  return acquireDb();
}

/**
 * Exported pass-through for orchestrate.pending so the orchestrate handler
 * can enumerate gates without importing `@cleocode/playbooks` at the top of
 * the file (avoids creating a second import-site for the same symbols).
 *
 * @internal
 */
export async function listPendingApprovalsForDispatch(): Promise<PlaybookApproval[]> {
  const db = await acquireDb();
  return getPendingApprovals(db);
}

/**
 * Exported pass-through for orchestrate.approve — looks up the gate by its
 * resume token so callers can inspect it before deciding on approve/reject.
 *
 * @internal
 */
export async function lookupApprovalByTokenForDispatch(
  token: string,
): Promise<PlaybookApproval | null> {
  const db = await acquireDb();
  return getPlaybookApprovalByToken(db, token);
}
