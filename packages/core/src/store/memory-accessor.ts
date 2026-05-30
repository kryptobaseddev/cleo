/**
 * Data accessor for brain.db — CRUD operations for decisions, patterns,
 * learnings, and memory links.
 *
 * Wraps drizzle ORM queries over the brain.db singleton. All methods are
 * async (sqlite-proxy) and return typed rows from memory-schema.ts.
 *
 * @epic T5149
 * @task T5128
 */

import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type {
  BrainAttentionRow,
  BrainConsolidationEventRow,
  BrainDecisionRow,
  BrainLearningRow,
  BrainMemoryLinkRow,
  BrainModulatorInsert,
  BrainModulatorRow,
  BrainObservationRow,
  BrainPageEdgeRow,
  BrainPageNodeRow,
  BrainPatternRow,
  BrainStickyNoteRow,
  BrainWeightHistoryInsert,
  BrainWeightHistoryRow,
  NewBrainAttentionRow,
  NewBrainDecisionRow,
  NewBrainLearningRow,
  NewBrainMemoryLinkRow,
  NewBrainObservationRow,
  NewBrainPageEdgeRow,
  NewBrainPageNodeRow,
  NewBrainPatternRow,
  NewBrainStickyNoteRow,
} from './memory-schema.js';
import * as brainSchema from './memory-schema.js';
import { getBrainDb } from './memory-sqlite.js';
import { jsonbText } from './schema/jsonb.js';

export class BrainDataAccessor {
  constructor(private db: NodeSQLiteDatabase<typeof brainSchema>) {}

  // =========================================================================
  // Decisions CRUD
  // =========================================================================

  async addDecision(row: NewBrainDecisionRow): Promise<BrainDecisionRow> {
    await this.db.insert(brainSchema.brainDecisions).values(row);
    const result = await this.db
      .select()
      .from(brainSchema.brainDecisions)
      .where(eq(brainSchema.brainDecisions.id, row.id));
    return result[0]!;
  }

  async getDecision(id: string): Promise<BrainDecisionRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainDecisions)
      .where(eq(brainSchema.brainDecisions.id, id));
    return result[0] ?? null;
  }

  async findDecisions(
    params: {
      type?: (typeof brainSchema.BRAIN_DECISION_TYPES)[number];
      confidence?: (typeof brainSchema.BRAIN_CONFIDENCE_LEVELS)[number];
      outcome?: (typeof brainSchema.BRAIN_OUTCOME_TYPES)[number];
      contextTaskId?: string;
      limit?: number;
      /**
       * T1830: when false (default), AGT-* agent dispatch rows
       * (`decision_category = 'agent_dispatch'`) are excluded from results.
       * Pass true to include all categories.
       */
      includeAgentDispatch?: boolean;
    } = {},
  ): Promise<BrainDecisionRow[]> {
    const conditions: SQL[] = [];

    if (params.type) {
      conditions.push(eq(brainSchema.brainDecisions.type, params.type));
    }
    if (params.confidence) {
      conditions.push(eq(brainSchema.brainDecisions.confidence, params.confidence));
    }
    if (params.outcome) {
      conditions.push(eq(brainSchema.brainDecisions.outcome, params.outcome));
    }
    if (params.contextTaskId) {
      conditions.push(eq(brainSchema.brainDecisions.contextTaskId, params.contextTaskId));
    }
    // T1830: exclude agent_dispatch rows unless explicitly opted-in
    if (!params.includeAgentDispatch) {
      conditions.push(ne(brainSchema.brainDecisions.decisionCategory, 'agent_dispatch'));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainDecisions)
      .orderBy(desc(brainSchema.brainDecisions.createdAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updateDecision(id: string, updates: Partial<NewBrainDecisionRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainDecisions)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainDecisions.id, id));
  }

  // =========================================================================
  // Patterns CRUD
  // =========================================================================

  async addPattern(row: NewBrainPatternRow): Promise<BrainPatternRow> {
    await this.db.insert(brainSchema.brainPatterns).values(row);
    const result = await this.db
      .select()
      .from(brainSchema.brainPatterns)
      .where(eq(brainSchema.brainPatterns.id, row.id));
    return result[0]!;
  }

  async getPattern(id: string): Promise<BrainPatternRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainPatterns)
      .where(eq(brainSchema.brainPatterns.id, id));
    return result[0] ?? null;
  }

  async findPatterns(
    params: {
      type?: (typeof brainSchema.BRAIN_PATTERN_TYPES)[number];
      impact?: (typeof brainSchema.BRAIN_IMPACT_LEVELS)[number];
      minFrequency?: number;
      limit?: number;
    } = {},
  ): Promise<BrainPatternRow[]> {
    const conditions: SQL[] = [];

    if (params.type) {
      conditions.push(eq(brainSchema.brainPatterns.type, params.type));
    }
    if (params.impact) {
      conditions.push(eq(brainSchema.brainPatterns.impact, params.impact));
    }
    if (params.minFrequency !== undefined) {
      conditions.push(gte(brainSchema.brainPatterns.frequency, params.minFrequency));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainPatterns)
      .orderBy(desc(brainSchema.brainPatterns.frequency));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updatePattern(id: string, updates: Partial<NewBrainPatternRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainPatterns)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainPatterns.id, id));
  }

  // =========================================================================
  // Learnings CRUD
  // =========================================================================

  async addLearning(row: NewBrainLearningRow): Promise<BrainLearningRow> {
    await this.db.insert(brainSchema.brainLearnings).values(row);
    const result = await this.db
      .select()
      .from(brainSchema.brainLearnings)
      .where(eq(brainSchema.brainLearnings.id, row.id));
    return result[0]!;
  }

  async getLearning(id: string): Promise<BrainLearningRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainLearnings)
      .where(eq(brainSchema.brainLearnings.id, id));
    return result[0] ?? null;
  }

  async findLearnings(
    params: { minConfidence?: number; actionable?: boolean; limit?: number } = {},
  ): Promise<BrainLearningRow[]> {
    const conditions: SQL[] = [];

    if (params.minConfidence !== undefined) {
      conditions.push(gte(brainSchema.brainLearnings.confidence, params.minConfidence));
    }
    if (params.actionable !== undefined) {
      conditions.push(eq(brainSchema.brainLearnings.actionable, params.actionable));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainLearnings)
      .orderBy(desc(brainSchema.brainLearnings.confidence));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updateLearning(id: string, updates: Partial<NewBrainLearningRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainLearnings)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainLearnings.id, id));
  }

  // =========================================================================
  // Observations CRUD
  // =========================================================================

  async addObservation(row: NewBrainObservationRow): Promise<BrainObservationRow> {
    await this.db.insert(brainSchema.brainObservations).values(row);
    const result = await this.db
      .select()
      .from(brainSchema.brainObservations)
      .where(eq(brainSchema.brainObservations.id, row.id));
    return result[0]!;
  }

  async getObservation(id: string): Promise<BrainObservationRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainObservations)
      .where(eq(brainSchema.brainObservations.id, id));
    return result[0] ?? null;
  }

  async findObservations(
    params: {
      type?: (typeof brainSchema.BRAIN_OBSERVATION_TYPES)[number];
      project?: string;
      sourceType?: (typeof brainSchema.BRAIN_OBSERVATION_SOURCE_TYPES)[number];
      sourceSessionId?: string;
      /** T417: filter by agent provenance name (Wave 8 mental models). */
      agent?: string;
      limit?: number;
    } = {},
  ): Promise<BrainObservationRow[]> {
    const conditions: SQL[] = [];

    if (params.type) {
      conditions.push(eq(brainSchema.brainObservations.type, params.type));
    }
    if (params.project) {
      conditions.push(eq(brainSchema.brainObservations.project, params.project));
    }
    if (params.sourceType) {
      conditions.push(eq(brainSchema.brainObservations.sourceType, params.sourceType));
    }
    if (params.sourceSessionId) {
      conditions.push(eq(brainSchema.brainObservations.sourceSessionId, params.sourceSessionId));
    }
    if (params.agent) {
      conditions.push(eq(brainSchema.brainObservations.agent, params.agent));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainObservations)
      .orderBy(desc(brainSchema.brainObservations.createdAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updateObservation(id: string, updates: Partial<NewBrainObservationRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainObservations)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainObservations.id, id));
  }

  // =========================================================================
  // Memory Links CRUD
  // =========================================================================

  async addLink(row: NewBrainMemoryLinkRow): Promise<void> {
    await this.db.insert(brainSchema.brainMemoryLinks).values(row);
  }

  async getLinksForMemory(
    memoryType: (typeof brainSchema.BRAIN_MEMORY_TYPES)[number],
    memoryId: string,
  ): Promise<BrainMemoryLinkRow[]> {
    return this.db
      .select()
      .from(brainSchema.brainMemoryLinks)
      .where(
        and(
          eq(brainSchema.brainMemoryLinks.memoryType, memoryType),
          eq(brainSchema.brainMemoryLinks.memoryId, memoryId),
        ),
      )
      .orderBy(asc(brainSchema.brainMemoryLinks.createdAt));
  }

  async getLinksForTask(taskId: string): Promise<BrainMemoryLinkRow[]> {
    return this.db
      .select()
      .from(brainSchema.brainMemoryLinks)
      .where(eq(brainSchema.brainMemoryLinks.taskId, taskId))
      .orderBy(asc(brainSchema.brainMemoryLinks.createdAt));
  }

  async removeLink(
    memoryType: (typeof brainSchema.BRAIN_MEMORY_TYPES)[number],
    memoryId: string,
    taskId: string,
    linkType: (typeof brainSchema.BRAIN_LINK_TYPES)[number],
  ): Promise<void> {
    await this.db
      .delete(brainSchema.brainMemoryLinks)
      .where(
        and(
          eq(brainSchema.brainMemoryLinks.memoryType, memoryType),
          eq(brainSchema.brainMemoryLinks.memoryId, memoryId),
          eq(brainSchema.brainMemoryLinks.taskId, taskId),
          eq(brainSchema.brainMemoryLinks.linkType, linkType),
        ),
      );
  }

  // =========================================================================
  // Sticky Notes CRUD
  // =========================================================================

  /**
   * Parse a `tags_json` text column into a deduplicated string-array.
   *
   * Used to keep the {@link brainSchema.stickyTags} junction in sync with the
   * legacy whole-array column. Invalid / non-array JSON yields an empty list.
   */
  private static parseStickyTags(tagsJson: string | null | undefined): string[] {
    if (!tagsJson) return [];
    try {
      const parsed: unknown = JSON.parse(tagsJson);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>();
      for (const t of parsed) {
        if (typeof t === 'string' && t.length > 0) seen.add(t);
      }
      return [...seen];
    } catch {
      return [];
    }
  }

  /**
   * Replace the junction rows for one sticky so they exactly mirror its tags.
   *
   * Delete-then-insert keeps `sticky_tags` authoritative without RMW races:
   * the prior tag set is dropped and the supplied set re-inserted. Called on
   * every sticky create/update (T11355).
   *
   * @param stickyId - The owning sticky note id.
   * @param tags - The full tag set the junction should reflect.
   */
  private async syncStickyTags(stickyId: string, tags: string[]): Promise<void> {
    await this.db
      .delete(brainSchema.stickyTags)
      .where(eq(brainSchema.stickyTags.stickyId, stickyId));
    if (tags.length === 0) return;
    await this.db.insert(brainSchema.stickyTags).values(tags.map((tag) => ({ stickyId, tag })));
  }

  async addStickyNote(row: NewBrainStickyNoteRow): Promise<BrainStickyNoteRow> {
    await this.db.insert(brainSchema.brainStickyNotes).values(row);
    await this.syncStickyTags(row.id, BrainDataAccessor.parseStickyTags(row.tagsJson));
    const result = await this.db
      .select()
      .from(brainSchema.brainStickyNotes)
      .where(eq(brainSchema.brainStickyNotes.id, row.id));
    return result[0]!;
  }

  async getStickyNote(id: string): Promise<BrainStickyNoteRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainStickyNotes)
      .where(eq(brainSchema.brainStickyNotes.id, id));
    return result[0] ?? null;
  }

  /**
   * Find sticky notes with optional column filters and an index-backed,
   * SQL-side tag filter via the {@link brainSchema.stickyTags} junction.
   *
   * When `tags` is supplied the query keeps only notes that contain ALL of the
   * requested tags (membership runs through a junction subquery, never a
   * load-all-then-JS-filter). The `limit` is applied at the SQL layer in every
   * case — including with a tag filter — so callers never over-fetch.
   *
   * @param params - Status/color/priority equality filters, an all-of `tags`
   *   membership filter, and an optional row `limit`.
   * @returns Matching sticky-note rows, newest first.
   */
  async findStickyNotes(
    params: {
      status?: (typeof brainSchema.BRAIN_STICKY_STATUSES)[number];
      color?: (typeof brainSchema.BRAIN_STICKY_COLORS)[number];
      priority?: (typeof brainSchema.BRAIN_STICKY_PRIORITIES)[number];
      tags?: string[];
      limit?: number;
    } = {},
  ): Promise<BrainStickyNoteRow[]> {
    const conditions: SQL[] = [];

    if (params.status) {
      conditions.push(eq(brainSchema.brainStickyNotes.status, params.status));
    }
    if (params.color) {
      conditions.push(eq(brainSchema.brainStickyNotes.color, params.color));
    }
    if (params.priority) {
      conditions.push(eq(brainSchema.brainStickyNotes.priority, params.priority));
    }

    // SQL-side tag membership: notes whose junction rows cover every requested
    // tag. GROUP BY + HAVING COUNT(DISTINCT tag) = N implements "contains ALL".
    if (params.tags && params.tags.length > 0) {
      const wantedTags = [...new Set(params.tags)];
      const matchingIds = this.db
        .select({ stickyId: brainSchema.stickyTags.stickyId })
        .from(brainSchema.stickyTags)
        .where(inArray(brainSchema.stickyTags.tag, wantedTags))
        .groupBy(brainSchema.stickyTags.stickyId)
        .having(sql`count(distinct ${brainSchema.stickyTags.tag}) = ${wantedTags.length}`);
      conditions.push(inArray(brainSchema.brainStickyNotes.id, matchingIds));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainStickyNotes)
      .orderBy(desc(brainSchema.brainStickyNotes.createdAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updateStickyNote(id: string, updates: Partial<NewBrainStickyNoteRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainStickyNotes)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainStickyNotes.id, id));
    // Keep the junction in sync when tags_json changes.
    if (updates.tagsJson !== undefined) {
      await this.syncStickyTags(id, BrainDataAccessor.parseStickyTags(updates.tagsJson));
    }
  }

  async deleteStickyNote(id: string): Promise<void> {
    // ON DELETE CASCADE removes junction rows, but PRAGMA foreign_keys may be
    // off on some handles — delete explicitly to guarantee no orphans.
    await this.db.delete(brainSchema.stickyTags).where(eq(brainSchema.stickyTags.stickyId, id));
    await this.db
      .delete(brainSchema.brainStickyNotes)
      .where(eq(brainSchema.brainStickyNotes.id, id));
  }

  // =========================================================================
  // Attention CRUD (T11372 · Epic T11288 — Tier-2 working memory)
  // =========================================================================

  /**
   * Insert one attention (jot) row.
   *
   * Row-per-item: each jot is its own row so it decays and scopes
   * independently. `tags` is a JSONB BLOB written via the {@link jsonb} helper
   * (`toDriver` wraps in `jsonb()`), never serialized TEXT. Reads MUST use
   * `json_each` / `json(col)` — never the raw BLOB.
   *
   * @param row - New attention row (scope already resolved by the caller).
   * @returns The persisted row (tags read back via `json(col)` to satisfy the
   *   JSONB read rule).
   * @task T11372
   */
  async addAttention(row: NewBrainAttentionRow): Promise<BrainAttentionRow> {
    await this.db.insert(brainSchema.brainAttention).values(row);
    return this.getAttention(row.id) as Promise<BrainAttentionRow>;
  }

  /**
   * Fetch one attention row by id, reading `tags` whole-value via `json(col)`.
   *
   * A plain `select()` of the JSONB column would hit the {@link jsonb}
   * `fromDriver` guard and throw, so `tags` is projected with `jsonbText`.
   *
   * @param id - Attention item id.
   * @returns The row, or `null` when absent.
   * @task T11372
   */
  async getAttention(id: string): Promise<BrainAttentionRow | null> {
    const rows = await this.selectAttention(eq(brainSchema.brainAttention.id, id));
    return rows[0] ?? null;
  }

  /**
   * List attention items for a scope set, applying live-item + tag filters
   * entirely in SQL (never load-all-then-JS-filter).
   *
   * Scope filtering is by exact `(scope_kind, scope_id)` pairs — the visible
   * scope chain the caller resolved (narrowest → broader ancestors). Because
   * visibility is the scope key, items outside the chain are never read, so
   * cross-agent leakage is impossible by construction.
   *
   * Tag filtering uses `json_each(tags)` membership ("contains ALL" requested
   * tags) — a GROUP BY + HAVING COUNT(DISTINCT) subquery, exactly mirroring the
   * index-backed sticky-tags pattern but over the JSONB column directly.
   *
   * The default (`openOnly`, the common path) excludes items that are
   * `consolidated`/`discarded`, past `expires_at`, or below `decayThreshold`.
   *
   * @param params - Scope chain, optional tag filter, liveness controls, limit.
   * @returns Matching rows, newest first, `tags` read via `json(col)`.
   * @task T11372
   */
  async findAttention(params: {
    /** Visible scope chain as `(kind, id)` pairs. Empty ⇒ no scope restriction. */
    scopes?: Array<{
      kind: (typeof brainSchema.BRAIN_ATTENTION_SCOPE_KINDS)[number];
      id: string;
    }>;
    /** "Contains ALL" tag membership filter via `json_each`. */
    tags?: string[];
    /** When true (default) only live `open` items are returned. */
    openOnly?: boolean;
    /** Decay floor; items with `decay_score < threshold` are excluded. */
    decayThreshold?: number;
    /** Reference time (unix ms) for the TTL predicate. Defaults to `Date.now()`. */
    now?: number;
    /** Max rows (SQL LIMIT — applied even with a tag filter). */
    limit?: number;
  }): Promise<BrainAttentionRow[]> {
    const conditions: SQL[] = [];
    const t = brainSchema.brainAttention;

    // Scope chain — exact (kind, id) membership. This is the leakage boundary.
    if (params.scopes && params.scopes.length > 0) {
      const scopeClauses = params.scopes.map((s) =>
        and(eq(t.scopeKind, s.kind), eq(t.scopeId, s.id)),
      );
      const combined = scopeClauses.length === 1 ? scopeClauses[0] : or(...scopeClauses);
      if (combined) conditions.push(combined);
    }

    // Liveness: open status + TTL not past + decay above threshold.
    if (params.openOnly !== false) {
      conditions.push(eq(t.status, 'open'));
      const nowMs = params.now ?? Date.now();
      // expires_at IS NULL OR expires_at > now
      const ttl = or(isNull(t.expiresAt), gt(t.expiresAt, nowMs));
      if (ttl) conditions.push(ttl);
      if (typeof params.decayThreshold === 'number') {
        // decay_score IS NULL OR decay_score >= threshold
        const decay = or(isNull(t.decayScore), gte(t.decayScore, params.decayThreshold));
        if (decay) conditions.push(decay);
      }
    }

    // Tag membership via json_each — contains ALL requested tags.
    if (params.tags && params.tags.length > 0) {
      const wanted = [...new Set(params.tags)];
      const matchingIds = this.db
        .select({ id: sql<string>`a.id` })
        .from(sql`${t} AS a, json_each(a.tags) AS je`)
        .where(inArray(sql`je.value`, wanted))
        .groupBy(sql`a.id`)
        .having(sql`count(distinct je.value) = ${wanted.length}`);
      conditions.push(inArray(t.id, matchingIds));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return this.selectAttention(where, params.limit);
  }

  /**
   * Sweep expired / decayed open items to `status = 'discarded'`.
   *
   * Idempotent: only flips rows that are currently `open` AND past
   * `expires_at` (or, when `decayThreshold` is given, below the floor). Returns
   * the number of rows discarded so callers can log the sweep.
   *
   * @param params - Reference time + optional decay floor.
   * @returns Count of rows transitioned to `discarded`.
   * @task T11372
   */
  async expireAttention(params: { now?: number; decayThreshold?: number } = {}): Promise<number> {
    const t = brainSchema.brainAttention;
    const nowMs = params.now ?? Date.now();
    const expiredByTtl = and(eq(t.status, 'open'), lt(t.expiresAt, nowMs));
    const clauses: SQL[] = [];
    if (expiredByTtl) clauses.push(expiredByTtl);
    if (typeof params.decayThreshold === 'number') {
      const decayed = and(eq(t.status, 'open'), lt(t.decayScore, params.decayThreshold));
      if (decayed) clauses.push(decayed);
    }
    const where = clauses.length === 1 ? clauses[0] : or(...clauses);
    // Count first so we can report without a RETURNING dependency.
    const before = await this.db
      .select({ id: t.id })
      .from(t)
      .where(where ?? sql`0`);
    if (before.length === 0) return 0;
    await this.db
      .update(t)
      .set({ status: 'discarded' })
      .where(where ?? sql`0`);
    return before.length;
  }

  /**
   * Set the lifecycle status of one attention item (e.g. `consolidated`).
   *
   * @param id - Attention item id.
   * @param status - New status.
   * @task T11372
   */
  async setAttentionStatus(
    id: string,
    status: (typeof brainSchema.BRAIN_ATTENTION_STATUSES)[number],
  ): Promise<void> {
    await this.db
      .update(brainSchema.brainAttention)
      .set({ status })
      .where(eq(brainSchema.brainAttention.id, id));
  }

  /**
   * Shared SELECT that projects `tags` whole-value via `json(col)` so the
   * JSONB `fromDriver` guard is never hit. Newest-first ordering.
   *
   * @internal
   */
  private async selectAttention(
    where: SQL | undefined,
    limit?: number,
  ): Promise<BrainAttentionRow[]> {
    const t = brainSchema.brainAttention;
    // Explicit projection: every JSONB-safe column plus `tags` read whole-value
    // via json(col) (jsonbText). The selected shape is field-identical to
    // BrainAttentionRow, so the awaited rows satisfy the declared return type
    // without an `as unknown as` cast — each field is typed by its column.
    let query = this.db
      .select({
        id: t.id,
        content: t.content,
        sessionId: t.sessionId,
        agentId: t.agentId,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
        // Whole-value JSONB read — emits canonical TEXT, parsed to string[].
        // Wrap the column in `sql` so the jsonbText helper receives an SQL
        // expression (its param type is SQL | SQL.Aliased, not a column).
        tags: jsonbText<string[]>(sql`${t.tags}`),
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        decayScore: t.decayScore,
        status: t.status,
      })
      .from(t)
      .orderBy(desc(t.createdAt));
    if (where) query = query.where(where) as typeof query;
    if (limit) query = query.limit(limit) as typeof query;
    const rows = await query;
    return rows.map(
      (r): BrainAttentionRow => ({
        id: r.id,
        content: r.content,
        sessionId: r.sessionId,
        agentId: r.agentId,
        scopeKind: r.scopeKind,
        scopeId: r.scopeId,
        tags: r.tags,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        decayScore: r.decayScore,
        status: r.status,
      }),
    );
  }

  // =========================================================================
  // PageIndex Node CRUD (T5383)
  // =========================================================================

  async addPageNode(node: NewBrainPageNodeRow): Promise<BrainPageNodeRow> {
    await this.db.insert(brainSchema.brainPageNodes).values(node);
    const result = await this.db
      .select()
      .from(brainSchema.brainPageNodes)
      .where(eq(brainSchema.brainPageNodes.id, node.id));
    return result[0]!;
  }

  async getPageNode(id: string): Promise<BrainPageNodeRow | null> {
    const result = await this.db
      .select()
      .from(brainSchema.brainPageNodes)
      .where(eq(brainSchema.brainPageNodes.id, id));
    return result[0] ?? null;
  }

  async findPageNodes(
    params: {
      nodeType?: (typeof brainSchema.BRAIN_NODE_TYPES)[number];
      minQualityScore?: number;
      limit?: number;
    } = {},
  ): Promise<BrainPageNodeRow[]> {
    const conditions: SQL[] = [];

    if (params.nodeType) {
      conditions.push(eq(brainSchema.brainPageNodes.nodeType, params.nodeType));
    }
    if (params.minQualityScore !== undefined) {
      conditions.push(gte(brainSchema.brainPageNodes.qualityScore, params.minQualityScore));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainPageNodes)
      .orderBy(desc(brainSchema.brainPageNodes.lastActivityAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async updatePageNode(id: string, updates: Partial<NewBrainPageNodeRow>): Promise<void> {
    await this.db
      .update(brainSchema.brainPageNodes)
      .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
      .where(eq(brainSchema.brainPageNodes.id, id));
  }

  async removePageNode(id: string): Promise<void> {
    // Remove associated edges first (both directions)
    await this.db
      .delete(brainSchema.brainPageEdges)
      .where(
        or(eq(brainSchema.brainPageEdges.fromId, id), eq(brainSchema.brainPageEdges.toId, id)),
      );
    // Remove the node
    await this.db.delete(brainSchema.brainPageNodes).where(eq(brainSchema.brainPageNodes.id, id));
  }

  // =========================================================================
  // PageIndex Edge CRUD (T5383)
  // =========================================================================

  async addPageEdge(edge: NewBrainPageEdgeRow): Promise<BrainPageEdgeRow> {
    await this.db.insert(brainSchema.brainPageEdges).values(edge);
    const result = await this.db
      .select()
      .from(brainSchema.brainPageEdges)
      .where(
        and(
          eq(brainSchema.brainPageEdges.fromId, edge.fromId),
          eq(brainSchema.brainPageEdges.toId, edge.toId),
          eq(brainSchema.brainPageEdges.edgeType, edge.edgeType),
        ),
      );
    return result[0]!;
  }

  async findPageEdges(
    params: {
      edgeType?: (typeof brainSchema.BRAIN_EDGE_TYPES)[number];
      provenance?: string;
      limit?: number;
    } = {},
  ): Promise<BrainPageEdgeRow[]> {
    const conditions: SQL[] = [];

    if (params.edgeType) {
      conditions.push(eq(brainSchema.brainPageEdges.edgeType, params.edgeType));
    }
    if (params.provenance) {
      conditions.push(eq(brainSchema.brainPageEdges.provenance, params.provenance));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainPageEdges)
      .orderBy(desc(brainSchema.brainPageEdges.createdAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
  }

  async getPageEdges(
    nodeId: string,
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<BrainPageEdgeRow[]> {
    if (direction === 'out') {
      return this.db
        .select()
        .from(brainSchema.brainPageEdges)
        .where(eq(brainSchema.brainPageEdges.fromId, nodeId))
        .orderBy(asc(brainSchema.brainPageEdges.createdAt));
    }
    if (direction === 'in') {
      return this.db
        .select()
        .from(brainSchema.brainPageEdges)
        .where(eq(brainSchema.brainPageEdges.toId, nodeId))
        .orderBy(asc(brainSchema.brainPageEdges.createdAt));
    }
    // both
    return this.db
      .select()
      .from(brainSchema.brainPageEdges)
      .where(
        or(
          eq(brainSchema.brainPageEdges.fromId, nodeId),
          eq(brainSchema.brainPageEdges.toId, nodeId),
        ),
      )
      .orderBy(asc(brainSchema.brainPageEdges.createdAt));
  }

  async getNeighbors(
    nodeId: string,
    edgeType?: (typeof brainSchema.BRAIN_EDGE_TYPES)[number],
  ): Promise<BrainPageNodeRow[]> {
    // Get edges from this node
    const conditions: SQL[] = [eq(brainSchema.brainPageEdges.fromId, nodeId)];
    if (edgeType) {
      conditions.push(eq(brainSchema.brainPageEdges.edgeType, edgeType));
    }

    const edges = await this.db
      .select()
      .from(brainSchema.brainPageEdges)
      .where(and(...conditions));

    if (edges.length === 0) return [];

    const neighborIds = edges.map((e) => e.toId);
    const nodes: BrainPageNodeRow[] = [];
    for (const nid of neighborIds) {
      const node = await this.getPageNode(nid);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  async removePageEdge(
    fromId: string,
    toId: string,
    edgeType: (typeof brainSchema.BRAIN_EDGE_TYPES)[number],
  ): Promise<void> {
    await this.db
      .delete(brainSchema.brainPageEdges)
      .where(
        and(
          eq(brainSchema.brainPageEdges.fromId, fromId),
          eq(brainSchema.brainPageEdges.toId, toId),
          eq(brainSchema.brainPageEdges.edgeType, edgeType),
        ),
      );
  }
}

/**
 * Factory: get a BrainDataAccessor backed by the brain.db singleton.
 */
export async function getBrainAccessor(cwd?: string): Promise<BrainDataAccessor> {
  const db = await getBrainDb(cwd);
  return new BrainDataAccessor(db);
}

// ============================================================================
// M4 PLASTICITY AUX TABLE ACCESSORS (T673-M4)
// Minimal writers — Wave 1+ workers wire the full call paths.
// ============================================================================

/**
 * Insert one row into brain_weight_history.
 * Called by writeWeightHistory() in brain-stdp.ts for each LTP, LTD, Hebbian,
 * or prune event that crosses the 1e-6 negligibility threshold.
 *
 * @param cwd - Project root (locates brain.db). Defaults to process.cwd().
 * @param input - Row data. `changedAt` defaults to SQLite datetime('now').
 * @returns The inserted row with its generated id.
 *
 * @task T697
 * @epic T673
 */
export async function insertWeightHistoryRow(
  cwd: string | undefined,
  input: BrainWeightHistoryInsert,
): Promise<BrainWeightHistoryRow> {
  const db = await getBrainDb(cwd);
  const result = await db.insert(brainSchema.brainWeightHistory).values(input).returning();
  return result[0]!;
}

/**
 * Insert one row into brain_modulators.
 * Called by backfillRewardSignals() for each task outcome it processes.
 * Both this INSERT and the retrieval_log UPDATE MUST run in the same logical
 * pass but in separate transactions (no ATTACH) — see spec §4.3.
 *
 * @param cwd - Project root (locates brain.db). Defaults to process.cwd().
 * @param input - Row data. `createdAt` defaults to SQLite datetime('now').
 * @returns The inserted row with its generated id.
 *
 * @task T699
 * @epic T673
 */
export async function insertModulatorRow(
  cwd: string | undefined,
  input: BrainModulatorInsert,
): Promise<BrainModulatorRow> {
  const db = await getBrainDb(cwd);
  const result = await db.insert(brainSchema.brainModulators).values(input).returning();
  return result[0]!;
}

/**
 * Open a consolidation event row in brain_consolidation_events.
 * Call this at the START of runConsolidation before any steps execute.
 * Returns the new row id — pass it to logConsolidationComplete() when done.
 *
 * @param cwd - Project root (locates brain.db).
 * @param trigger - What initiated this consolidation run.
 * @param sessionId - Active session ID, if any.
 * @returns The id of the newly inserted row.
 *
 * @task T701
 * @epic T673
 */
export async function logConsolidationStart(
  cwd: string | undefined,
  trigger: string,
  sessionId?: string,
): Promise<number> {
  const db = await getBrainDb(cwd);
  const result = await db
    .insert(brainSchema.brainConsolidationEvents)
    .values({
      trigger,
      sessionId: sessionId ?? null,
      // stepResultsJson is required NOT NULL — use empty object as placeholder
      // until logConsolidationComplete updates it with final step results.
      stepResultsJson: '{}',
      succeeded: true,
    })
    .returning({ id: brainSchema.brainConsolidationEvents.id });
  return result[0]!.id;
}

/**
 * Complete a consolidation event row by updating it with final results.
 * Call this at the END of runConsolidation after all steps complete.
 *
 * @param cwd - Project root (locates brain.db).
 * @param id - Row id returned by logConsolidationStart.
 * @param stats - JSON-serializable step results object.
 * @param durationMs - Total wall-clock duration in milliseconds.
 * @param succeeded - Whether the run completed without error.
 * @returns The updated row.
 *
 * @task T701
 * @epic T673
 */
export async function logConsolidationComplete(
  cwd: string | undefined,
  id: number,
  stats: Record<string, unknown>,
  durationMs: number,
  succeeded = true,
): Promise<BrainConsolidationEventRow> {
  const db = await getBrainDb(cwd);
  const result = await db
    .update(brainSchema.brainConsolidationEvents)
    .set({
      stepResultsJson: JSON.stringify(stats),
      durationMs,
      succeeded,
    })
    .where(eq(brainSchema.brainConsolidationEvents.id, id))
    .returning();
  return result[0]!;
}
