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

import { eq, and, gte, desc, asc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getBrainDb } from './brain-sqlite.js';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as brainSchema from './brain-schema.js';
import type {
  BrainDecisionRow,
  NewBrainDecisionRow,
  BrainPatternRow,
  NewBrainPatternRow,
  BrainLearningRow,
  NewBrainLearningRow,
  BrainMemoryLinkRow,
  NewBrainMemoryLinkRow,
} from './brain-schema.js';

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

  async findDecisions(params: {
    type?: typeof brainSchema.BRAIN_DECISION_TYPES[number];
    confidence?: typeof brainSchema.BRAIN_CONFIDENCE_LEVELS[number];
    outcome?: typeof brainSchema.BRAIN_OUTCOME_TYPES[number];
    contextTaskId?: string;
    limit?: number;
  } = {}): Promise<BrainDecisionRow[]> {
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

  async findPatterns(params: {
    type?: typeof brainSchema.BRAIN_PATTERN_TYPES[number];
    impact?: typeof brainSchema.BRAIN_IMPACT_LEVELS[number];
    minFrequency?: number;
    limit?: number;
  } = {}): Promise<BrainPatternRow[]> {
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

  async findLearnings(params: {
    minConfidence?: number;
    actionable?: boolean;
    limit?: number;
  } = {}): Promise<BrainLearningRow[]> {
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
  // Memory Links CRUD
  // =========================================================================

  async addLink(row: NewBrainMemoryLinkRow): Promise<void> {
    await this.db.insert(brainSchema.brainMemoryLinks).values(row);
  }

  async getLinksForMemory(
    memoryType: typeof brainSchema.BRAIN_MEMORY_TYPES[number],
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
    memoryType: typeof brainSchema.BRAIN_MEMORY_TYPES[number],
    memoryId: string,
    taskId: string,
    linkType: typeof brainSchema.BRAIN_LINK_TYPES[number],
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
}

/**
 * Factory: get a BrainDataAccessor backed by the brain.db singleton.
 */
export async function getBrainAccessor(cwd?: string): Promise<BrainDataAccessor> {
  const db = await getBrainDb(cwd);
  return new BrainDataAccessor(db);
}
