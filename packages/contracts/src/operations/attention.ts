/**
 * Attention Domain Operations Contract (Tier-2 working memory).
 *
 * The attention buffer is a per-agent, scope-keyed, decaying working-memory
 * layer. `cleo attention add` (alias `jot`) writes ONE item, auto-keyed to the
 * narrowest scope the writing agent resolves (agent > task > epic > saga >
 * session > global) via the E0 env-first identity resolvers. Because visibility
 * is the scope key itself, an agent working task `T-A` can never read the
 * agent/task-scoped items written by an agent working `T-B` — cross-agent
 * leakage is structurally impossible (Epic T11288).
 *
 * CLI identifiers start with `attention.*` and route through the `attention`
 * domain handler. These operation types are the wire-format API contract.
 *
 * @task T11373 — Attention CLI + dispatch op
 * @epic T11288 EP-TIER2-ATTENTION
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 * @see packages/core/src/memory/attention.ts
 * @see packages/cleo/src/dispatch/domains/attention.ts
 */

/**
 * Scope-kind taxonomy for attention items, ordered NARROWEST → BROADEST.
 *
 * Mirrors `BRAIN_ATTENTION_SCOPE_KINDS` in the brain schema; declared here so
 * the wire contract does not depend on the core schema module.
 */
export type AttentionScopeKind = 'agent' | 'task' | 'epic' | 'saga' | 'session' | 'global';

/** Lifecycle status of an attention item. */
export type AttentionStatus = 'open' | 'consolidated' | 'discarded';

/**
 * One attention item in wire format.
 *
 * Returned by `add`, `show`, and `list`. `tags` is always a parsed string
 * array (decoded from the JSONB column via `json(col)`), never the raw BLOB.
 */
export interface AttentionItem {
  /** Stable item id (`att_<ts>_<hex>`). */
  id: string;
  /** The jot content. */
  content: string;
  /** Resolved session id of the writer, if any. */
  sessionId: string | null;
  /** Resolved agent identity of the writer, if any. */
  agentId: string | null;
  /** Narrowest scope kind the item was keyed to. */
  scopeKind: AttentionScopeKind;
  /** Id of the bound scope (task/epic/saga id, agent id, session id, or `global`). */
  scopeId: string;
  /** Parsed tag list (decoded from the JSONB column). */
  tags: string[];
  /** Creation time, unix epoch milliseconds. */
  createdAt: number;
  /** Optional hard TTL, unix epoch milliseconds. */
  expiresAt: number | null;
  /** Optional decay score in `[0, 1]`. */
  decayScore: number | null;
  /** Lifecycle status. */
  status: AttentionStatus;
}

/**
 * Parameters for `attention.add` (alias `jot`).
 *
 * Identity (`sessionId`/`agentId`) and the current task are resolved server-
 * side from the environment (E0) — callers do NOT pass them by default. The
 * optional `scope` override escalates the auto-resolved narrowest scope.
 */
export interface AttentionAddParams {
  /** The jot content. Required, non-empty. */
  content: string;
  /** Optional tags to attach. */
  tags?: string[];
  /**
   * Optional explicit scope override. When omitted the narrowest resolvable
   * scope is used. Accepts a scope kind to escalate to (e.g. `epic`, `saga`).
   */
  scope?: AttentionScopeKind;
  /** Optional TTL in seconds from now (sets `expiresAt`). */
  ttlSeconds?: number;
}

/**
 * Parameters for `attention.list` / `attention.show`.
 *
 * With no flags the resolved scope chain (narrowest + visible ancestors) of the
 * calling agent is used. `--scope` restricts to one kind; `--tag` filters by
 * "contains ALL" membership.
 */
export interface AttentionListParams {
  /** Restrict to one scope kind. */
  scope?: AttentionScopeKind;
  /** "Contains ALL" tag filter. */
  tags?: string[];
  /** Include non-open items too (default: open only). */
  includeAll?: boolean;
  /** Max rows. */
  limit?: number;
}

/** Result of `attention.add`. */
export interface AttentionAddResult {
  /** The persisted item. */
  item: AttentionItem;
}

/** Result of `attention.list` / `attention.show`. */
export interface AttentionListResult {
  /** Matching items, newest first. */
  items: AttentionItem[];
  /** Total returned (== items.length; the digest carries the live count). */
  total: number;
  /** The scope chain the items were resolved against (for transparency). */
  resolvedScopes: Array<{ kind: AttentionScopeKind; id: string }>;
}
