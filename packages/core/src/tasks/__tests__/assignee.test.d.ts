/**
 * Tests for tasks.assignee column: claimTask / unclaimTask (B.1).
 *
 * Covers:
 * - Claim sets assignee on a previously unclaimed task
 * - Claim is idempotent for the same agent
 * - Claim fails when task is already claimed by a different agent
 * - Unclaim clears the assignee
 * - Unclaim is a no-op on an already unclaimed task
 * - claimTask / unclaimTask throw on non-existent task IDs
 * - Assignee persists through rowToTask round-trip
 */
export {};
//# sourceMappingURL=assignee.test.d.ts.map
