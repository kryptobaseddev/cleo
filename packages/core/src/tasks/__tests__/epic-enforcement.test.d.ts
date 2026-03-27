/**
 * Tests for epic lifecycle pipeline enforcement (T062).
 *
 * Covers:
 * - validateEpicCreation: min-5 AC, description required, mode gating
 * - validateChildStageCeiling: child stage must not exceed epic's stage
 * - validateEpicStageAdvancement: epic blocked by in-flight children
 * - findEpicAncestor: correct ancestor traversal
 * - Integration via addTask / updateTask
 *
 * @task T062
 * @epic T056
 */
export {};
//# sourceMappingURL=epic-enforcement.test.d.ts.map
