/**
 * Data accessor for brain.db — CRUD operations for decisions, patterns,
 * learnings, and memory links.
 *
 * Wraps drizzle ORM queries over the brain.db singleton. All methods are
 * async (sqlite-proxy) and return typed rows from brain-schema.ts.
 *
 * @epic T5149
 * @task T5128
 */

import type { SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gte, or } from 'drizzle-orm';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type {
  BrainDecisionRow,
  BrainLearningRow,
  BrainMemoryLinkRow,
  BrainObservationRow,
  BrainPageEdgeRow,
  BrainPageNodeRow,
  BrainPatternRow,
  BrainStickyNoteRow,
  NewBrainDecisionRow,
  NewBrainLearningRow,
  NewBrainMemoryLinkRow,
  NewBrainObservationRow,
  NewBrainPageEdgeRow,
  NewBrainPageNodeRow,
  NewBrainPatternRow,
  NewBrainStickyNoteRow,
} from './brain-schema.js';
import * as brainSchema from './brain-schema.js';
import { getBrainDb } from './brain-sqlite.js';

export class BrainDataAccessor {
  constructor(private db: SqliteRemoteDatabase<typeof brainSchema>) {}

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

  async addStickyNote(row: NewBrainStickyNoteRow): Promise<BrainStickyNoteRow> {
    await this.db.insert(brainSchema.brainStickyNotes).values(row);
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

  async findStickyNotes(
    params: {
      status?: (typeof brainSchema.BRAIN_STICKY_STATUSES)[number];
      color?: (typeof brainSchema.BRAIN_STICKY_COLORS)[number];
      priority?: (typeof brainSchema.BRAIN_STICKY_PRIORITIES)[number];
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
  }

  async deleteStickyNote(id: string): Promise<void> {
    await this.db
      .delete(brainSchema.brainStickyNotes)
      .where(eq(brainSchema.brainStickyNotes.id, id));
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
    params: { nodeType?: (typeof brainSchema.BRAIN_NODE_TYPES)[number]; limit?: number } = {},
  ): Promise<BrainPageNodeRow[]> {
    const conditions: SQL[] = [];

    if (params.nodeType) {
      conditions.push(eq(brainSchema.brainPageNodes.nodeType, params.nodeType));
    }

    let query = this.db
      .select()
      .from(brainSchema.brainPageNodes)
      .orderBy(desc(brainSchema.brainPageNodes.createdAt));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (params.limit) {
      query = query.limit(params.limit) as typeof query;
    }

    return query;
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
