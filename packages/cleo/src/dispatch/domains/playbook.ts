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
 * Param extraction is type-safe via OpsFromCore<typeof corePlaybook.playbookCoreOps>
 * inference (T1442 — T1435 Wave 1 dispatch refactor). Zero per-op Params/Result
 * imports from contracts.
 *
 * @task T935 — HITL CLI surface for cleo playbook + orchestrate approvals
 * @task T1442 — playbook dispatch OpsFromCore refactor
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PlaybookApproval, PlaybookRun, PlaybookRunStatus } from '@cleocode/contracts';
import type { playbook as corePlaybook } from '@cleocode/core';
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
import {
  defineTypedHandler,
  lafsError,
  lafsSuccess,
  type OpsFromCore,
  typedDispatch,
} from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { getListParams, handleErrorResult, unsupportedOp } from './_base.js';
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
// OpsFromCore type inference
// ---------------------------------------------------------------------------

type PlaybookOps = OpsFromCore<typeof corePlaybook.playbookCoreOps>;

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
// Typed inner handler (Wave D · T1442)
//
// The typed handler holds all per-op logic with fully-narrowed params via
// OpsFromCore<typeof corePlaybook.playbookCoreOps>. The outer DomainHandler
// class delegates to it so the registry sees the expected query/mutate
// interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _playbookTypedHandler = defineTypedHandler<PlaybookOps>('playbook', {
  // -----------------------------------------------------------------------
  // Query ops
  // -----------------------------------------------------------------------

  status: async (params: PlaybookOps['status'][0]) => {
    const runId = params.runId;
    if (!runId) {
      return lafsError('E_INVALID_INPUT', 'runId is required', 'status');
    }
    const db = await acquireDb();
    const run = getPlaybookRun(db, runId);
    if (run === null) {
      return lafsError('E_NOT_FOUND', `playbook run ${runId} not found`, 'status');
    }
    return lafsSuccess(run, 'status');
  },

  // SSoT-EXEMPT:db-injection+runtime-offset-pagination — listPlaybookRunsState only
  // supports LIMIT; offset must be applied client-side after fetch. acquireDb() returns
  // a DatabaseSync handle that cannot be represented as a wire-format param (ADR-057 D1).
  list: async (params: PlaybookOps['list'][0]) => {
    const statusFilter = normalizeListStatus(params.status);
    const epicId = typeof params.epicId === 'string' ? params.epicId : undefined;
    const { limit, offset } = getListParams(params as Record<string, unknown>);

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

    return lafsSuccess(envelope, 'list');
  },

  // SSoT-EXEMPT:file-load+parse — must resolve .cantbook from disk before any DB row
  // is written; parsePlaybook returns a non-wire-serializable definition object
  // (ADR-057 D1 exception).
  validate: async (params: PlaybookOps['validate'][0]) => {
    const file = params.file;
    const name = params.name;

    if (!file && !name) {
      return lafsError(
        'E_INVALID_INPUT',
        'Either file (path) or name (playbook name) is required',
        'validate',
      );
    }

    let source: string;
    let sourcePath: string;

    if (file) {
      // Absolute or relative file path.
      const resolved = resolvePath(file);
      if (!existsSync(resolved)) {
        return lafsError('E_NOT_FOUND', `playbook file not found: ${resolved}`, 'validate');
      }
      sourcePath = resolved;
      source = readFileSync(resolved, 'utf8');
    } else {
      // Resolve by name through the standard search path.
      const loaded = loadPlaybookByName(name!);
      if (loaded === null) {
        return lafsError(
          'E_NOT_FOUND',
          `playbook "${name}" not found in any search path`,
          'validate',
        );
      }
      sourcePath = loaded.sourcePath;
      source = loaded.source;
    }

    try {
      const { definition, sourceHash } = parsePlaybook(source);
      return lafsSuccess(
        {
          valid: true as const,
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
        'validate',
      );
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        return lafsError(
          err.code,
          `${err.message}${err.field ? ` [field=${err.field}]` : ''}`,
          'validate',
        );
      }
      return lafsError(
        'E_PLAYBOOK_PARSE',
        err instanceof Error ? err.message : String(err),
        'validate',
      );
    }
  },

  // -----------------------------------------------------------------------
  // Mutate ops
  // -----------------------------------------------------------------------

  // SSoT-EXEMPT:db-injection+file-load+executePlaybook — db is a DatabaseSync handle
  // (non-wire-serializable infrastructure per ADR-057 D1); file loading and
  // parsePlaybook return a non-wire-serializable PlaybookDefinition; executePlaybook
  // is the runtime state machine SSoT in @cleocode/playbooks and must remain here.
  run: async (params: PlaybookOps['run'][0]) => {
    const name = params.name;
    if (!name) {
      return lafsError('E_INVALID_INPUT', 'name is required', 'run');
    }
    let initialContext: Record<string, unknown>;
    try {
      initialContext = parseContextJson(params.context);
    } catch (err) {
      return lafsError('E_INVALID_INPUT', err instanceof Error ? err.message : String(err), 'run');
    }

    const loaded = loadPlaybookByName(name);
    if (loaded === null) {
      return lafsError('E_NOT_FOUND', `playbook "${name}" not found in any search path`, 'run');
    }

    // Parse + validate .cantbook via the canonical parser so syntax errors
    // surface before a DB row is ever written.
    let parsed: ReturnType<typeof parsePlaybook>;
    try {
      parsed = parsePlaybook(loaded.source);
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        return lafsError(
          err.code,
          `${err.message}${err.field ? ` [field=${err.field}]` : ''}`,
          'run',
        );
      }
      return lafsError('E_PLAYBOOK_PARSE', err instanceof Error ? err.message : String(err), 'run');
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
      return lafsError(code, message, 'run');
    }

    return lafsSuccess(
      {
        ...toRunEnvelope(result),
        playbookName: parsed.definition.name,
        playbookSource: loaded.sourcePath,
      },
      'run',
    );
  },

  // SSoT-EXEMPT:db-injection+gate-validation — db is a DatabaseSync handle (ADR-057 D1);
  // approval gate state machine requires loading playbook source + verifying hash
  // integrity; resumePlaybook is the runtime SSoT in @cleocode/playbooks.
  resume: async (params: PlaybookOps['resume'][0]) => {
    const runId = params.runId;
    if (!runId) {
      return lafsError('E_INVALID_INPUT', 'runId is required', 'resume');
    }
    const db = await acquireDb();
    const run = getPlaybookRun(db, runId);
    if (run === null) {
      return lafsError('E_NOT_FOUND', `playbook run ${runId} not found`, 'resume');
    }

    // The approval token lookup doubles as the "gate still pending?" guard.
    // Locate the most recent approval row for this run via the token stored
    // on the run's most recent approval; fall back to re-loading by runId
    // when no approval has been issued yet.
    const approvals = loadApprovalsForRun(db, runId);
    if (approvals.length === 0) {
      return lafsError(
        'E_APPROVAL_NOT_FOUND',
        `run ${runId} has no approval gates — nothing to resume`,
        'resume',
      );
    }
    // Newest approval first — sorted ascending by requested_at so pick tail.
    const latest = approvals[approvals.length - 1] as PlaybookApproval;
    if (latest.status === 'pending') {
      return lafsError(
        'E_APPROVAL_PENDING',
        `gate ${latest.approvalId} for run ${runId} is still pending — approve before resuming`,
        'resume',
      );
    }
    if (latest.status === 'rejected') {
      return lafsError(
        'E_APPROVAL_REJECTED',
        `gate ${latest.approvalId} was rejected${latest.reason ? ` (${latest.reason})` : ''}`,
        'resume',
      );
    }

    // Gate is approved — need the original playbook source to resume. The run
    // row carries `playbook_name` but not the source; re-resolve from the
    // on-disk search path so the hash is re-validated on every resume.
    const loaded = loadPlaybookByName(run.playbookName);
    if (loaded === null) {
      return lafsError(
        'E_NOT_FOUND',
        `playbook "${run.playbookName}" not found — cannot resume run ${runId}`,
        'resume',
      );
    }
    let parsed: ReturnType<typeof parsePlaybook>;
    try {
      parsed = parsePlaybook(loaded.source);
    } catch (err) {
      return lafsError(
        'E_PLAYBOOK_PARSE',
        err instanceof Error ? err.message : String(err),
        'resume',
      );
    }
    if (parsed.sourceHash !== run.playbookHash) {
      return lafsError(
        'E_PLAYBOOK_HASH_MISMATCH',
        `playbook "${run.playbookName}" source changed since run started (hash drift)`,
        'resume',
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
      return lafsSuccess(toRunEnvelope(result), 'resume');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(E_PLAYBOOK_RESUME_BLOCKED)) {
        return lafsError(E_PLAYBOOK_RESUME_BLOCKED, message, 'resume');
      }
      return lafsError('E_PLAYBOOK_RUNTIME', message, 'resume');
    }
  },
});

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['status', 'list', 'validate']);
const MUTATE_OPS = new Set<string>(['run', 'resume']);

// ---------------------------------------------------------------------------
// PlaybookHandler
// ---------------------------------------------------------------------------

/**
 * Canonical dispatch handler for the `playbook` domain.
 *
 * Delegates to the typed handler via `typedDispatch`, which performs the
 * single trust-boundary cast from `Record<string, unknown>` to the narrowed
 * `PlaybookOps[op][0]` type.
 *
 * Each CLI subcommand routes through exactly one of the four operations:
 *   - `query  playbook.status` → status
 *   - `query  playbook.list`   → list
 *   - `query  playbook.validate` → validate
 *   - `mutate playbook.run`    → run
 *   - `mutate playbook.resume` → resume
 *
 * @task T935
 * @task T1442 — OpsFromCore typed-dispatch migration
 */
export class PlaybookHandler implements DomainHandler {
  /**
   * Query gateway — `status`, `list`, and `validate`.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'playbook', operation, startTime);
    }
    try {
      const envelope = await typedDispatch(
        _playbookTypedHandler,
        operation as keyof PlaybookOps & string,
        params ?? {},
      );
      return {
        meta: dispatchMeta('query', 'playbook', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
    } catch (err) {
      return handleErrorResult('query', 'playbook', operation, err, startTime);
    }
  }

  /**
   * Mutate gateway — `run` and `resume`.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'playbook', operation, startTime);
    }
    try {
      const envelope = await typedDispatch(
        _playbookTypedHandler,
        operation as keyof PlaybookOps & string,
        params ?? {},
      );
      return {
        meta: dispatchMeta('mutate', 'playbook', operation, startTime),
        success: envelope.success,
        ...(envelope.success
          ? { data: envelope.data as unknown }
          : {
              error: {
                code:
                  envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
                message: envelope.error?.message ?? 'Unknown error',
              },
            }),
      };
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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exported helpers for orchestrate domain (approval/pending)
// ---------------------------------------------------------------------------

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
