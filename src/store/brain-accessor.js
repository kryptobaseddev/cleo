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
import { and, asc, desc, eq, gte, or } from 'drizzle-orm';
import * as brainSchema from './brain-schema.js';
import { getBrainDb } from './brain-sqlite.js';
export class BrainDataAccessor {
    db;
    constructor(db) {
        this.db = db;
    }
    // =========================================================================
    // Decisions CRUD
    // =========================================================================
    async addDecision(row) {
        await this.db.insert(brainSchema.brainDecisions).values(row);
        const result = await this.db
            .select()
            .from(brainSchema.brainDecisions)
            .where(eq(brainSchema.brainDecisions.id, row.id));
        return result[0];
    }
    async getDecision(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainDecisions)
            .where(eq(brainSchema.brainDecisions.id, id));
        return result[0] ?? null;
    }
    async findDecisions(params = {}) {
        const conditions = [];
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
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async updateDecision(id, updates) {
        await this.db
            .update(brainSchema.brainDecisions)
            .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
            .where(eq(brainSchema.brainDecisions.id, id));
    }
    // =========================================================================
    // Patterns CRUD
    // =========================================================================
    async addPattern(row) {
        await this.db.insert(brainSchema.brainPatterns).values(row);
        const result = await this.db
            .select()
            .from(brainSchema.brainPatterns)
            .where(eq(brainSchema.brainPatterns.id, row.id));
        return result[0];
    }
    async getPattern(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainPatterns)
            .where(eq(brainSchema.brainPatterns.id, id));
        return result[0] ?? null;
    }
    async findPatterns(params = {}) {
        const conditions = [];
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
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async updatePattern(id, updates) {
        await this.db
            .update(brainSchema.brainPatterns)
            .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
            .where(eq(brainSchema.brainPatterns.id, id));
    }
    // =========================================================================
    // Learnings CRUD
    // =========================================================================
    async addLearning(row) {
        await this.db.insert(brainSchema.brainLearnings).values(row);
        const result = await this.db
            .select()
            .from(brainSchema.brainLearnings)
            .where(eq(brainSchema.brainLearnings.id, row.id));
        return result[0];
    }
    async getLearning(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainLearnings)
            .where(eq(brainSchema.brainLearnings.id, id));
        return result[0] ?? null;
    }
    async findLearnings(params = {}) {
        const conditions = [];
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
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async updateLearning(id, updates) {
        await this.db
            .update(brainSchema.brainLearnings)
            .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
            .where(eq(brainSchema.brainLearnings.id, id));
    }
    // =========================================================================
    // Observations CRUD
    // =========================================================================
    async addObservation(row) {
        await this.db.insert(brainSchema.brainObservations).values(row);
        const result = await this.db
            .select()
            .from(brainSchema.brainObservations)
            .where(eq(brainSchema.brainObservations.id, row.id));
        return result[0];
    }
    async getObservation(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainObservations)
            .where(eq(brainSchema.brainObservations.id, id));
        return result[0] ?? null;
    }
    async findObservations(params = {}) {
        const conditions = [];
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
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async updateObservation(id, updates) {
        await this.db
            .update(brainSchema.brainObservations)
            .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
            .where(eq(brainSchema.brainObservations.id, id));
    }
    // =========================================================================
    // Memory Links CRUD
    // =========================================================================
    async addLink(row) {
        await this.db.insert(brainSchema.brainMemoryLinks).values(row);
    }
    async getLinksForMemory(memoryType, memoryId) {
        return this.db
            .select()
            .from(brainSchema.brainMemoryLinks)
            .where(and(eq(brainSchema.brainMemoryLinks.memoryType, memoryType), eq(brainSchema.brainMemoryLinks.memoryId, memoryId)))
            .orderBy(asc(brainSchema.brainMemoryLinks.createdAt));
    }
    async getLinksForTask(taskId) {
        return this.db
            .select()
            .from(brainSchema.brainMemoryLinks)
            .where(eq(brainSchema.brainMemoryLinks.taskId, taskId))
            .orderBy(asc(brainSchema.brainMemoryLinks.createdAt));
    }
    async removeLink(memoryType, memoryId, taskId, linkType) {
        await this.db
            .delete(brainSchema.brainMemoryLinks)
            .where(and(eq(brainSchema.brainMemoryLinks.memoryType, memoryType), eq(brainSchema.brainMemoryLinks.memoryId, memoryId), eq(brainSchema.brainMemoryLinks.taskId, taskId), eq(brainSchema.brainMemoryLinks.linkType, linkType)));
    }
    // =========================================================================
    // Sticky Notes CRUD
    // =========================================================================
    async addStickyNote(row) {
        await this.db.insert(brainSchema.brainStickyNotes).values(row);
        const result = await this.db
            .select()
            .from(brainSchema.brainStickyNotes)
            .where(eq(brainSchema.brainStickyNotes.id, row.id));
        return result[0];
    }
    async getStickyNote(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainStickyNotes)
            .where(eq(brainSchema.brainStickyNotes.id, id));
        return result[0] ?? null;
    }
    async findStickyNotes(params = {}) {
        const conditions = [];
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
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async updateStickyNote(id, updates) {
        await this.db
            .update(brainSchema.brainStickyNotes)
            .set({ ...updates, updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
            .where(eq(brainSchema.brainStickyNotes.id, id));
    }
    async deleteStickyNote(id) {
        await this.db
            .delete(brainSchema.brainStickyNotes)
            .where(eq(brainSchema.brainStickyNotes.id, id));
    }
    // =========================================================================
    // PageIndex Node CRUD (T5383)
    // =========================================================================
    async addPageNode(node) {
        await this.db.insert(brainSchema.brainPageNodes).values(node);
        const result = await this.db
            .select()
            .from(brainSchema.brainPageNodes)
            .where(eq(brainSchema.brainPageNodes.id, node.id));
        return result[0];
    }
    async getPageNode(id) {
        const result = await this.db
            .select()
            .from(brainSchema.brainPageNodes)
            .where(eq(brainSchema.brainPageNodes.id, id));
        return result[0] ?? null;
    }
    async findPageNodes(params = {}) {
        const conditions = [];
        if (params.nodeType) {
            conditions.push(eq(brainSchema.brainPageNodes.nodeType, params.nodeType));
        }
        let query = this.db
            .select()
            .from(brainSchema.brainPageNodes)
            .orderBy(desc(brainSchema.brainPageNodes.createdAt));
        if (conditions.length > 0) {
            query = query.where(and(...conditions));
        }
        if (params.limit) {
            query = query.limit(params.limit);
        }
        return query;
    }
    async removePageNode(id) {
        // Remove associated edges first (both directions)
        await this.db
            .delete(brainSchema.brainPageEdges)
            .where(or(eq(brainSchema.brainPageEdges.fromId, id), eq(brainSchema.brainPageEdges.toId, id)));
        // Remove the node
        await this.db.delete(brainSchema.brainPageNodes).where(eq(brainSchema.brainPageNodes.id, id));
    }
    // =========================================================================
    // PageIndex Edge CRUD (T5383)
    // =========================================================================
    async addPageEdge(edge) {
        await this.db.insert(brainSchema.brainPageEdges).values(edge);
        const result = await this.db
            .select()
            .from(brainSchema.brainPageEdges)
            .where(and(eq(brainSchema.brainPageEdges.fromId, edge.fromId), eq(brainSchema.brainPageEdges.toId, edge.toId), eq(brainSchema.brainPageEdges.edgeType, edge.edgeType)));
        return result[0];
    }
    async getPageEdges(nodeId, direction = 'both') {
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
            .where(or(eq(brainSchema.brainPageEdges.fromId, nodeId), eq(brainSchema.brainPageEdges.toId, nodeId)))
            .orderBy(asc(brainSchema.brainPageEdges.createdAt));
    }
    async getNeighbors(nodeId, edgeType) {
        // Get edges from this node
        const conditions = [eq(brainSchema.brainPageEdges.fromId, nodeId)];
        if (edgeType) {
            conditions.push(eq(brainSchema.brainPageEdges.edgeType, edgeType));
        }
        const edges = await this.db
            .select()
            .from(brainSchema.brainPageEdges)
            .where(and(...conditions));
        if (edges.length === 0)
            return [];
        const neighborIds = edges.map((e) => e.toId);
        const nodes = [];
        for (const nid of neighborIds) {
            const node = await this.getPageNode(nid);
            if (node)
                nodes.push(node);
        }
        return nodes;
    }
    async removePageEdge(fromId, toId, edgeType) {
        await this.db
            .delete(brainSchema.brainPageEdges)
            .where(and(eq(brainSchema.brainPageEdges.fromId, fromId), eq(brainSchema.brainPageEdges.toId, toId), eq(brainSchema.brainPageEdges.edgeType, edgeType)));
    }
}
/**
 * Factory: get a BrainDataAccessor backed by the brain.db singleton.
 */
export async function getBrainAccessor(cwd) {
    const db = await getBrainDb(cwd);
    return new BrainDataAccessor(db);
}
//# sourceMappingURL=brain-accessor.js.map