/**
 * Integration tests for migration failure scenarios.
 *
 * Tests that the migration system handles failures safely:
 * - State machine tracks phases and supports resume after interruption
 * - Invalid JSON source files are rejected before destructive operations
 * - Completed/failed migrations cannot be re-run via the state machine
 * - Logger captures structured failure events
 * - File locking prevents concurrent migration attempts
 *
 * @task T4729
 * @epic T4454
 */
export {};
//# sourceMappingURL=migration-failure.integration.test.d.ts.map