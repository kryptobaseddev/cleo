/**
 * Focus Domain Handler (Dispatch Layer)
 *
 * Implements `cleo focus <id>` — a single-envelope orientation call that
 * replaces the 8-call pattern:
 *   1. tasks.show              → identity + scope + blockers
 *   2. tasks.saga.members/rollup → members (saga only), via taskRelates
 *   3. orchestrate.ready       → readyWave (epic / task with parent epic)
 *   4. docs store              → attachedDocs
 *   5. memory.find             → brainContext (scope-filtered, ≤ 3 each)
 *   6. git log --grep          → recentActivity (last 5 commits)
 *
 * All sub-calls run in parallel where possible via `Promise.allSettled`.
 * Failures are silently swallowed so a missing store never blocks `cleo focus`.
 *
 * Token budget: ≤ 1 500 tokens for typical task orientation.
 *
 * @task T9973
 * @epic T9964 E-ORIENT-V2
 */

import { execSync } from 'node:child_process';
import type {
  FocusAttachedDoc,
  FocusBlocker,
  FocusBrainContext,
  FocusIdentity,
  FocusReadyTask,
  FocusRecentCommit,
  FocusSagaMember,
  FocusShowResult,
} from '@cleocode/contracts/operations/focus';
import type { MemoryCompactHit } from '@cleocode/contracts/operations/memory';
import { getProjectRoot } from '@cleocode/core';
import {
  createAttachmentStore,
  memoryFind,
  orchestrateReady,
  taskRelates,
  taskShow,
} from '@cleocode/core/internal';
import { lafsSuccess } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the token weight of a value using the ~4 chars-per-token heuristic.
 *
 * @param value - Any serialisable value.
 *
 * @internal
 */
function roughTokenCount(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

/** Pattern for a valid CLEO task ID (`T####`). */
const TASK_ID_RE = /^T\d+$/i;

/**
 * Fetch up to 5 recent git commits mentioning `taskId` via `git log --grep`.
 *
 * Returns an empty array on any git failure so the envelope is never blocked.
 *
 * @param taskId      - Task ID to grep for in commit messages.
 * @param projectRoot - Absolute project root (must be a git repo root).
 *
 * @internal
 */
function fetchRecentActivity(taskId: string, projectRoot: string): FocusRecentCommit[] {
  try {
    const raw = execSync(`git log --grep="${taskId}" --pretty=format:"%H\t%s\t%aI" -n 5`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
    });
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        return {
          commitSha: parts[0] ?? '',
          message: parts[1] ?? '',
          date: parts[2] ?? '',
        };
      })
      .filter((c) => c.commitSha !== '');
  } catch {
    return [];
  }
}

/**
 * Collect task-scoped attachment entries from the docs store.
 *
 * Always resolves — returns `[]` on any failure.
 *
 * @param projectRoot - Absolute project root.
 * @param taskId      - Owner task ID.
 *
 * @internal
 */
async function fetchAttachedDocs(projectRoot: string, taskId: string): Promise<FocusAttachedDoc[]> {
  try {
    const store = createAttachmentStore();
    const metas = await store.listByOwner('task', taskId, projectRoot);
    const entries: FocusAttachedDoc[] = [];
    for (const meta of metas) {
      const extras = await store.getExtras(meta.id, projectRoot);
      entries.push({
        attachmentId: meta.id,
        kind: meta.attachment.kind,
        ...(extras?.slug != null ? { slug: extras.slug } : {}),
        ...(extras?.type != null ? { type: extras.type } : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Fetch scope-filtered brain context — up to 3 entries per category.
 *
 * Queries observations, decisions, and learnings in parallel, each scoped
 * to the task ID query. Returns `undefined` on complete failure so the
 * envelope field is omitted cleanly.
 *
 * @param taskId - Task ID to use as the search query.
 *
 * @internal
 */
async function fetchBrainContext(taskId: string): Promise<FocusBrainContext | undefined> {
  try {
    const [obsResult, decResult, lrnResult] = await Promise.allSettled([
      memoryFind({ query: taskId, limit: 3, tables: ['observations'] }),
      memoryFind({ query: taskId, limit: 3, tables: ['decisions'] }),
      memoryFind({ query: taskId, limit: 3, tables: ['learnings'] }),
    ]);

    const toHits = (
      r: PromiseSettledResult<Awaited<ReturnType<typeof memoryFind>>>,
    ): MemoryCompactHit[] => {
      if (r.status !== 'fulfilled' || !r.value.success) return [];
      const data = r.value.data as { results?: MemoryCompactHit[] } | undefined;
      return (data?.results ?? []).slice(0, 3);
    };

    return {
      observations: toHits(obsResult),
      learnings: toHits(lrnResult),
      decisions: toHits(decResult),
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve Saga member Epics with titles and statuses using `taskRelates`.
 *
 * @param projectRoot - Absolute project root.
 * @param sagaId      - Saga identifier.
 *
 * @internal
 */
async function fetchSagaMembersWithTitles(
  projectRoot: string,
  sagaId: string,
): Promise<FocusSagaMember[]> {
  try {
    const relResult = await taskRelates(projectRoot, sagaId);
    if (!relResult.success) return [];

    const memberIds = (relResult.data?.relations ?? [])
      .filter((r) => r.type === 'groups')
      .map((r) => r.taskId);

    if (memberIds.length === 0) return [];

    const showResults = await Promise.allSettled(
      memberIds.map((epicId) => taskShow(projectRoot, epicId)),
    );

    return showResults
      .map((r, i) => {
        const epicId = memberIds[i] ?? '';
        if (r.status !== 'fulfilled' || !r.value.success) {
          return { epicId, title: epicId, status: 'unknown' };
        }
        const t = r.value.data!.task;
        return { epicId: t.id, title: t.title, status: t.status };
      })
      .filter((m) => m.epicId !== '');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core aggregator
// ---------------------------------------------------------------------------

/** Opaque error shape returned when the target entity cannot be loaded. */
interface FocusError {
  error: { code: string; message: string };
}

/**
 * Build the focus envelope for a given task, epic, or saga ID.
 *
 * @param id          - Task / Epic / Saga identifier.
 * @param projectRoot - Absolute project root.
 *
 * @internal
 */
async function buildFocusEnvelope(
  id: string,
  projectRoot: string,
): Promise<FocusShowResult | FocusError> {
  // ── 1. Core task record ───────────────────────────────────────────────────
  const showResult = await taskShow(projectRoot, id);
  if (!showResult.success) {
    return {
      error: {
        code: showResult.error?.code?.toString() ?? 'E_NOT_FOUND',
        message: showResult.error?.message ?? `Task not found: ${id}`,
      },
    };
  }

  const task = showResult.data!.task;

  // ── 2. Determine entity tier ──────────────────────────────────────────────
  const labels = Array.isArray(task.labels) ? (task.labels as string[]) : [];
  const isSaga = labels.includes('saga');
  const isEpic = task.type === 'epic' && !isSaga;
  const entityType = isSaga ? 'saga' : isEpic ? 'epic' : 'task';

  // ── 3. Identity ───────────────────────────────────────────────────────────
  const identity: FocusIdentity = {
    id: task.id,
    title: task.title,
    type: entityType,
    status: task.status,
    ...(task.parentId != null ? { parentId: task.parentId } : {}),
  };

  // ── 4. Scope ──────────────────────────────────────────────────────────────
  const scope: { sagaId?: string; epicId?: string; taskId?: string } = {};
  if (entityType === 'task') {
    scope.taskId = task.id;
    if (task.parentId) scope.epicId = task.parentId;
  } else if (entityType === 'epic') {
    scope.epicId = task.id;
  } else {
    scope.sagaId = task.id;
  }

  // ── 5. Blockers (sequential — N is typically small) ───────────────────────
  const blockers: FocusBlocker[] = [];

  // Honour explicit `blockedBy` first
  const explicitBlockers: string[] = Array.isArray(task.blockedBy)
    ? (task.blockedBy as string[])
    : [];

  // Fall back to unresolved `depends` entries
  const unresolvedDepends: string[] = [];
  if (explicitBlockers.length === 0 && Array.isArray(task.depends)) {
    for (const depId of task.depends as string[]) {
      const dRes = await taskShow(projectRoot, depId).catch(() => null);
      if (dRes?.success && dRes.data) {
        const s = dRes.data.task.status;
        if (s !== 'done' && s !== 'cancelled') {
          unresolvedDepends.push(depId);
          blockers.push({
            id: depId,
            title: dRes.data.task.title,
            reason: `dependency not resolved (status: ${s})`,
          });
        }
      }
    }
  }

  if (explicitBlockers.length > 0) {
    await Promise.allSettled(
      explicitBlockers.map(async (bid) => {
        const bRes = await taskShow(projectRoot, bid).catch(() => null);
        blockers.push({
          id: bid,
          title: bRes?.success ? (bRes.data?.task.title ?? bid) : bid,
          reason: bRes?.success ? (bRes.data?.task.status ?? 'unknown') : 'unknown',
        });
      }),
    );
  }

  // ── 6. Parent epic for ready wave ─────────────────────────────────────────
  const epicIdForReady =
    entityType === 'epic'
      ? task.id
      : entityType === 'task' && task.parentId
        ? task.parentId
        : undefined;

  // ── 7. Parallel sub-calls ─────────────────────────────────────────────────
  const [sagaMembersResult, readyResult, docsResult, brainResult] = await Promise.allSettled([
    isSaga
      ? fetchSagaMembersWithTitles(projectRoot, id)
      : Promise.resolve(undefined as FocusSagaMember[] | undefined),

    epicIdForReady && TASK_ID_RE.test(epicIdForReady)
      ? orchestrateReady(epicIdForReady, projectRoot)
      : Promise.resolve(null),

    fetchAttachedDocs(projectRoot, id),

    fetchBrainContext(id),
  ]);

  // ── 8. Recent git activity (sync, cheap) ──────────────────────────────────
  const recentActivity = fetchRecentActivity(id, projectRoot);

  // ── 9. Assemble result ────────────────────────────────────────────────────

  const members: FocusSagaMember[] | undefined =
    sagaMembersResult.status === 'fulfilled' && sagaMembersResult.value != null
      ? sagaMembersResult.value
      : undefined;

  let readyWave: FocusReadyTask[] | undefined;
  if (readyResult.status === 'fulfilled' && readyResult.value?.success) {
    const rData = readyResult.value.data as
      | { readyTasks?: Array<{ id: string; title: string; priority: string; depends: string[] }> }
      | undefined;
    const rTasks = rData?.readyTasks ?? [];
    if (rTasks.length > 0) {
      readyWave = rTasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        depends: t.depends,
      }));
    }
  }

  const attachedDocs: FocusAttachedDoc[] | undefined =
    docsResult.status === 'fulfilled' && docsResult.value.length > 0 ? docsResult.value : undefined;

  const brainContext: FocusBrainContext | undefined =
    brainResult.status === 'fulfilled' ? brainResult.value : undefined;

  const envelope: FocusShowResult = {
    identity,
    scope,
    ...(members != null ? { members } : {}),
    blockers,
    ...(readyWave != null ? { readyWave } : {}),
    ...(attachedDocs != null ? { attachedDocs } : {}),
    ...(recentActivity.length > 0 ? { recentActivity } : {}),
    ...(brainContext != null ? { brainContext } : {}),
    tokensEstimated: 0,
  };

  envelope.tokensEstimated = roughTokenCount(envelope);
  return envelope;
}

// ---------------------------------------------------------------------------
// Domain handler
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['show']);

/**
 * Domain handler for `cleo focus` — single-envelope task orientation.
 *
 * Aggregates identity, scope, members, blockers, readyWave, attachedDocs,
 * recentActivity, and brainContext into one LAFS response, replacing 8
 * sequential CLI calls with a single parallel dispatch.
 *
 * There are no mutate operations in this domain.
 *
 * @task T9973
 * @epic T9964
 */
export class FocusHandler implements DomainHandler {
  /**
   * Execute a read-only focus query operation.
   *
   * @param operation - Operation name (`'show'`).
   * @param params    - Raw params (must contain `id: string`).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'focus', operation, startTime);
    }

    try {
      const id = typeof params?.['id'] === 'string' ? params['id'].trim() : '';
      if (!id) {
        return {
          meta: dispatchMeta('query', 'focus', operation, startTime),
          success: false,
          error: { code: 'E_INVALID_INPUT', message: 'id is required (e.g. cleo focus T9973)' },
        };
      }

      const projectRoot = getProjectRoot();
      const result = await buildFocusEnvelope(id, projectRoot);

      if ('error' in result) {
        return {
          meta: dispatchMeta('query', 'focus', operation, startTime),
          success: false,
          error: result.error,
        };
      }

      // Use lafsSuccess so consumers get the canonical envelope shape.
      const wrapped = lafsSuccess(result, 'focus.show');
      return {
        meta: dispatchMeta('query', 'focus', operation, startTime),
        success: true,
        data: wrapped.data,
      };
    } catch (error) {
      return handleErrorResult('query', 'focus', operation, error, startTime);
    }
  }

  /**
   * The focus domain has no mutate operations.
   *
   * @param operation - Always unsupported.
   * @param _params   - Unused.
   */
  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    return unsupportedOp('mutate', 'focus', operation, startTime);
  }

  /** Declared operations for introspection. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return { query: ['show'], mutate: [] };
  }
}
