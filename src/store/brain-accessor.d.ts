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
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { BrainDecisionRow, BrainLearningRow, BrainMemoryLinkRow, BrainObservationRow, BrainPageEdgeRow, BrainPageNodeRow, BrainPatternRow, BrainStickyNoteRow, NewBrainDecisionRow, NewBrainLearningRow, NewBrainMemoryLinkRow, NewBrainObservationRow, NewBrainPageEdgeRow, NewBrainPageNodeRow, NewBrainPatternRow, NewBrainStickyNoteRow } from './brain-schema.js';
import * as brainSchema from './brain-schema.js';
export declare class BrainDataAccessor {
    private db;
    constructor(db: SqliteRemoteDatabase<typeof brainSchema>);
    addDecision(row: NewBrainDecisionRow): Promise<BrainDecisionRow>;
    getDecision(id: string): Promise<BrainDecisionRow | null>;
    findDecisions(params?: {
        type?: (typeof brainSchema.BRAIN_DECISION_TYPES)[number];
        confidence?: (typeof brainSchema.BRAIN_CONFIDENCE_LEVELS)[number];
        outcome?: (typeof brainSchema.BRAIN_OUTCOME_TYPES)[number];
        contextTaskId?: string;
        limit?: number;
    }): Promise<BrainDecisionRow[]>;
    updateDecision(id: string, updates: Partial<NewBrainDecisionRow>): Promise<void>;
    addPattern(row: NewBrainPatternRow): Promise<BrainPatternRow>;
    getPattern(id: string): Promise<BrainPatternRow | null>;
    findPatterns(params?: {
        type?: (typeof brainSchema.BRAIN_PATTERN_TYPES)[number];
        impact?: (typeof brainSchema.BRAIN_IMPACT_LEVELS)[number];
        minFrequency?: number;
        limit?: number;
    }): Promise<BrainPatternRow[]>;
    updatePattern(id: string, updates: Partial<NewBrainPatternRow>): Promise<void>;
    addLearning(row: NewBrainLearningRow): Promise<BrainLearningRow>;
    getLearning(id: string): Promise<BrainLearningRow | null>;
    findLearnings(params?: {
        minConfidence?: number;
        actionable?: boolean;
        limit?: number;
    }): Promise<BrainLearningRow[]>;
    updateLearning(id: string, updates: Partial<NewBrainLearningRow>): Promise<void>;
    addObservation(row: NewBrainObservationRow): Promise<BrainObservationRow>;
    getObservation(id: string): Promise<BrainObservationRow | null>;
    findObservations(params?: {
        type?: (typeof brainSchema.BRAIN_OBSERVATION_TYPES)[number];
        project?: string;
        sourceType?: (typeof brainSchema.BRAIN_OBSERVATION_SOURCE_TYPES)[number];
        sourceSessionId?: string;
        limit?: number;
    }): Promise<BrainObservationRow[]>;
    updateObservation(id: string, updates: Partial<NewBrainObservationRow>): Promise<void>;
    addLink(row: NewBrainMemoryLinkRow): Promise<void>;
    getLinksForMemory(memoryType: (typeof brainSchema.BRAIN_MEMORY_TYPES)[number], memoryId: string): Promise<BrainMemoryLinkRow[]>;
    getLinksForTask(taskId: string): Promise<BrainMemoryLinkRow[]>;
    removeLink(memoryType: (typeof brainSchema.BRAIN_MEMORY_TYPES)[number], memoryId: string, taskId: string, linkType: (typeof brainSchema.BRAIN_LINK_TYPES)[number]): Promise<void>;
    addStickyNote(row: NewBrainStickyNoteRow): Promise<BrainStickyNoteRow>;
    getStickyNote(id: string): Promise<BrainStickyNoteRow | null>;
    findStickyNotes(params?: {
        status?: (typeof brainSchema.BRAIN_STICKY_STATUSES)[number];
        color?: (typeof brainSchema.BRAIN_STICKY_COLORS)[number];
        priority?: (typeof brainSchema.BRAIN_STICKY_PRIORITIES)[number];
        limit?: number;
    }): Promise<BrainStickyNoteRow[]>;
    updateStickyNote(id: string, updates: Partial<NewBrainStickyNoteRow>): Promise<void>;
    deleteStickyNote(id: string): Promise<void>;
    addPageNode(node: NewBrainPageNodeRow): Promise<BrainPageNodeRow>;
    getPageNode(id: string): Promise<BrainPageNodeRow | null>;
    findPageNodes(params?: {
        nodeType?: (typeof brainSchema.BRAIN_NODE_TYPES)[number];
        limit?: number;
    }): Promise<BrainPageNodeRow[]>;
    removePageNode(id: string): Promise<void>;
    addPageEdge(edge: NewBrainPageEdgeRow): Promise<BrainPageEdgeRow>;
    getPageEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<BrainPageEdgeRow[]>;
    getNeighbors(nodeId: string, edgeType?: (typeof brainSchema.BRAIN_EDGE_TYPES)[number]): Promise<BrainPageNodeRow[]>;
    removePageEdge(fromId: string, toId: string, edgeType: (typeof brainSchema.BRAIN_EDGE_TYPES)[number]): Promise<void>;
}
/**
 * Factory: get a BrainDataAccessor backed by the brain.db singleton.
 */
export declare function getBrainAccessor(cwd?: string): Promise<BrainDataAccessor>;
//# sourceMappingURL=brain-accessor.d.ts.map