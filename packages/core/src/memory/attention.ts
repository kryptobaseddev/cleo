/**
 * Tier-2 attention buffer — scope-keyed, decaying working memory (E2).
 *
 * This module is the core CRUD + scope-resolution layer behind
 * `cleo attention add` (alias `jot`), `cleo attention show/list`, and the
 * digest injected into `cleo focus` + the spawn-prompt PSYCHE-MEMORY block.
 *
 * ## Why scope-keying makes leakage impossible
 *
 * Every jot is stored as ONE row (never a JSON-blob aggregate) and is keyed to
 * the NARROWEST scope its writer resolves, ordered
 * `agent > task > epic > saga > session > global`
 * ({@link SCOPE_ORDER}). A reader resolves its OWN scope chain (its narrowest
 * scope plus the ancestors it shares) and the SQL query filters by exact
 * `(scope_kind, scope_id)` membership. An agent working task `T-A` therefore
 * never even SELECTs the agent/task-scoped rows an agent working `T-B` wrote —
 * visibility is by-construction (the scope key) rather than by-filter-after-
 * load. A broader-scope jot (an epic/saga both agents share) IS in both chains,
 * so shared context still flows. This is the structural guarantee proved by the
 * leakage test (T11375).
 *
 * ## Identity resolution (E0)
 *
 * Session + agent identity come from the env-first resolvers
 * ({@link resolveSessionIdFromEnv} / {@link resolveAgentIdFromEnv}) so a short-
 * lived `cleo` call inside a worktree attributes the jot to the agent's OWN
 * session — not "whoever touched the DB last". The current task comes from the
 * per-session `focus_state` ({@link readFocusState}); its epic/saga ancestors
 * are walked via the task `parentId` chain + saga membership (NO parallel
 * resolver is invented — `loadSingleTask` + `sagas/members` are reused).
 *
 * ## JSONB tags
 *
 * `tags` is a JSONB BLOB (E4 `jsonb<string[]>()`). Tag filtering runs in SQL via
 * `json_each(tags)`; whole-value reads project `json(tags)`. The raw BLOB is
 * NEVER `JSON.parse`-d (the on-disk encoding is version-unstable).
 *
 * @task T11372 — CRUD core module
 * @task T11373 — scope auto-resolution via E0 identity
 * @epic T11288 EP-TIER2-ATTENTION
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { randomBytes } from 'node:crypto';
import type {
  AttentionAddParams,
  AttentionItem,
  AttentionScopeKind,
} from '@cleocode/contracts/operations/attention';
import { resolveSagaMemberIds } from '../sagas/storage.js';
import { readFocusState } from '../sessions/focus-state-store.js';
import { resolveAgentIdFromEnv, resolveSessionIdFromEnv } from '../sessions/session-id.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainAttentionRow } from '../store/memory-schema.js';

/**
 * Scope kinds ordered NARROWEST → BROADEST. The auto-resolver keys a jot to the
 * first kind in this order whose id resolves; a reader's visible chain is every
 * resolvable `(kind, id)` at or above the writer's narrowest scope.
 *
 * @task T11372
 */
export const SCOPE_ORDER: readonly AttentionScopeKind[] = [
  'agent',
  'task',
  'epic',
  'saga',
  'session',
  'global',
] as const;

/**
 * Default decay floor below which an item is hidden from the open-items query.
 * `null`-decay items (the common case) are unaffected. Conservative default —
 * an explicit `decay_score` must be written for decay-based hiding to apply.
 *
 * @task T11372
 */
export const DEFAULT_DECAY_THRESHOLD = 0.1;

/**
 * One `(scope_kind, scope_id)` pair in a resolved scope chain.
 *
 * @task T11372
 */
export interface AttentionScope {
  kind: AttentionScopeKind;
  id: string;
}

/**
 * Fully-resolved attention identity for the calling agent.
 *
 * `chain` is ordered narrowest → broadest and is BOTH the write target
 * (`chain[0]`, or the requested escalation) AND the read visibility set.
 *
 * @task T11372
 */
export interface ResolvedAttentionIdentity {
  /** Env-resolved session id, or `null`. */
  sessionId: string | null;
  /** Env-resolved agent id, or `null`. */
  agentId: string | null;
  /** Current task id from per-session focus_state, or `null`. */
  currentTaskId: string | null;
  /** Visible scope chain, narrowest → broadest. Always ends with `global`. */
  chain: AttentionScope[];
}

/**
 * Resolve the calling agent's attention identity + visible scope chain.
 *
 * Pure E0 + task-ancestry resolution; the chain is the leakage boundary.
 * Order (narrowest first): `agent` (CLEO_AGENT_ID) → `task` (focus_state
 * currentTask) → `epic` (task.parentId) → `saga` (epic's saga membership) →
 * `session` (CLEO_SESSION_ID) → `global`. Kinds whose id does not resolve are
 * skipped, but `global` is always present as the broadest fallback.
 *
 * @param projectRoot - Absolute project root.
 * @returns The resolved identity + visible scope chain.
 * @task T11372
 * @task T11373
 */
export async function resolveAttentionIdentity(
  projectRoot: string,
): Promise<ResolvedAttentionIdentity> {
  const sessionId = resolveSessionIdFromEnv();
  const agentId = resolveAgentIdFromEnv();

  const accessor = await getTaskAccessor(projectRoot);
  try {
    // Current task via per-session focus_state (env-aware, per-agent).
    const focus = await readFocusState(accessor, sessionId);
    const currentTaskId = focus?.currentTask ?? null;

    const chain: AttentionScope[] = [];

    if (agentId) chain.push({ kind: 'agent', id: agentId });

    // Walk task → epic → saga ancestry via parentId chain (no parallel resolver;
    // reuse loadSingleTask + saga membership per the decomposition guidance).
    if (currentTaskId) {
      chain.push({ kind: 'task', id: currentTaskId });
      const task = await accessor.loadSingleTask(currentTaskId).catch(() => null);
      const epicId = task?.parentId ?? null;
      if (epicId) {
        chain.push({ kind: 'epic', id: epicId });
        // The epic's parent (when it is a saga member) is the saga.
        const epic = await accessor.loadSingleTask(epicId).catch(() => null);
        const sagaCandidate = epic?.parentId ?? null;
        if (sagaCandidate) {
          // Confirm the candidate is genuinely a saga (its members include epicId).
          const memberIds = await resolveSagaMemberIds(accessor, sagaCandidate).catch(() => null);
          if (memberIds && memberIds.includes(epicId)) {
            chain.push({ kind: 'saga', id: sagaCandidate });
          }
        }
      }
    }

    if (sessionId) chain.push({ kind: 'session', id: sessionId });
    chain.push({ kind: 'global', id: 'global' });

    return { sessionId, agentId, currentTaskId, chain };
  } finally {
    await accessor.close();
  }
}

/**
 * Pick the write target scope from a resolved chain, honoring an optional
 * escalation. With no override the NARROWEST scope (`chain[0]`) is used; with
 * an override the matching kind in the chain is used (falling back to the
 * narrowest when the requested kind is not in the chain).
 *
 * @internal
 */
function pickWriteScope(
  chain: AttentionScope[],
  override: AttentionScopeKind | undefined,
): AttentionScope {
  if (override) {
    const match = chain.find((s) => s.kind === override);
    if (match) return match;
  }
  // chain always contains at least `global`.
  return chain[0] ?? { kind: 'global', id: 'global' };
}

/**
 * Generate a sortable, collision-resistant attention id (`att_<ts>_<hex>`).
 *
 * @internal
 */
function generateAttentionId(): string {
  const ts = Date.now().toString(36);
  const hex = randomBytes(4).toString('hex');
  return `att_${ts}_${hex}`;
}

/**
 * Map a DB row to the wire-format {@link AttentionItem}.
 *
 * `row.tags` was read via `json(col)` (see {@link BrainDataAccessor.findAttention}),
 * so it is already a parsed `string[]` — never the raw BLOB.
 *
 * @internal
 */
function rowToItem(row: BrainAttentionRow): AttentionItem {
  return {
    id: row.id,
    content: row.content,
    sessionId: row.sessionId ?? null,
    agentId: row.agentId ?? null,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    decayScore: row.decayScore ?? null,
    status: row.status,
  };
}

/**
 * Write one attention item, auto-scoped to the calling agent's resolved
 * identity (or the requested escalation).
 *
 * @param projectRoot - Absolute project root.
 * @param params - Content, optional tags, optional scope escalation + TTL.
 * @returns The persisted item.
 * @throws {Error} When `content` is empty after trimming.
 * @task T11372
 * @task T11373
 */
export async function addAttention(
  projectRoot: string,
  params: AttentionAddParams,
): Promise<AttentionItem> {
  const content = params.content?.trim();
  if (!content) {
    throw new Error('attention content is required');
  }

  const identity = await resolveAttentionIdentity(projectRoot);
  const scope = pickWriteScope(identity.chain, params.scope);

  const expiresAt =
    typeof params.ttlSeconds === 'number' && params.ttlSeconds > 0
      ? Date.now() + params.ttlSeconds * 1000
      : null;

  const accessor = await getBrainAccessor(projectRoot);
  const row = await accessor.addAttention({
    id: generateAttentionId(),
    content,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    scopeKind: scope.kind,
    scopeId: scope.id,
    tags: params.tags && params.tags.length > 0 ? [...new Set(params.tags)] : [],
    ...(expiresAt !== null ? { expiresAt } : {}),
    status: 'open',
  });
  return rowToItem(row);
}

/**
 * Options for {@link listAttention}.
 *
 * @task T11372
 */
export interface ListAttentionOptions {
  /** Restrict to one scope kind from the resolved chain. */
  scope?: AttentionScopeKind;
  /** "Contains ALL" tag membership filter (SQL `json_each`). */
  tags?: string[];
  /** When true, include non-open items too (default: open only). */
  includeAll?: boolean;
  /** Max rows. */
  limit?: number;
  /** Reference time (unix ms) for the TTL predicate. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Result of {@link listAttention}: the matching items plus the scope chain they
 * were resolved against (for transparency / digest rendering).
 *
 * @task T11372
 */
export interface ListAttentionResult {
  items: AttentionItem[];
  resolvedScopes: AttentionScope[];
}

/**
 * List the calling agent's visible attention items.
 *
 * By default returns LIVE (`open`, not expired, not decayed-out) items across
 * the agent's full visible scope chain. `scope` narrows to one kind; `tags`
 * filters by "contains ALL" membership; `includeAll` lifts the open-only gate.
 * Filtering happens entirely in SQL — never load-all-then-JS-filter.
 *
 * @param projectRoot - Absolute project root.
 * @param options - Scope/tag/liveness filters + limit.
 * @returns The matching items + the resolved scope chain.
 * @task T11372
 */
export async function listAttention(
  projectRoot: string,
  options: ListAttentionOptions = {},
): Promise<ListAttentionResult> {
  const identity = await resolveAttentionIdentity(projectRoot);
  const scopes = options.scope
    ? identity.chain.filter((s) => s.kind === options.scope)
    : identity.chain;

  const accessor = await getBrainAccessor(projectRoot);
  const rows = await accessor.findAttention({
    scopes,
    tags: options.tags,
    openOnly: options.includeAll !== true,
    decayThreshold: DEFAULT_DECAY_THRESHOLD,
    now: options.now,
    limit: options.limit,
  });
  return { items: rows.map(rowToItem), resolvedScopes: scopes };
}

/**
 * Sweep expired / decayed open items to `discarded`.
 *
 * Thin pass-through to the accessor sweep so callers (CLI, focus path, a future
 * consolidation job) share one TTL/decay policy. Idempotent.
 *
 * @param projectRoot - Absolute project root.
 * @param options - Reference time + decay floor (default {@link DEFAULT_DECAY_THRESHOLD}).
 * @returns Count of rows transitioned to `discarded`.
 * @task T11372
 */
export async function expireAttention(
  projectRoot: string,
  options: { now?: number; decayThreshold?: number } = {},
): Promise<number> {
  const accessor = await getBrainAccessor(projectRoot);
  return accessor.expireAttention({
    now: options.now,
    decayThreshold: options.decayThreshold ?? DEFAULT_DECAY_THRESHOLD,
  });
}
