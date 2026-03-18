/**
 * Performance Tests for Safety Layer
 *
 * Validates that safety mechanisms don't introduce unacceptable latency.
 *
 * Targets (from test strategy):
 * - Single write: <100ms (p95) with full safety
 * - Bulk write (50 tasks): <500ms
 * - Checkpoint: <50ms
 * - Verification: <50ms
 * - Sequence check: <10ms
 *
 * @task T4741
 * @epic T4732
 */
export {};
//# sourceMappingURL=performance-safety.test.d.ts.map