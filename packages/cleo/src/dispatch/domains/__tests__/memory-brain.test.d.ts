/**
 * Memory Domain — Brain.db Backed Operations (Post-Cutover)
 *
 * Tests that the MemoryHandler correctly delegates to brain.db-backed
 * engine functions for all new memory domain operations after T5241 cutover.
 *
 * Updated for T5671 Wave changes: removed ops (show, stats, pattern.stats,
 * learning.stats, contradictions, superseded, unlink) that are no longer
 * in the handler.
 *
 * @task T5241
 * @epic T5149
 */
export {};
//# sourceMappingURL=memory-brain.test.d.ts.map
