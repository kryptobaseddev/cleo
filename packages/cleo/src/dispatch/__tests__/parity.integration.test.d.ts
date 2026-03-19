/**
 * Post-Consolidation Integration Parity Tests
 *
 * Verifies that key operations produce structurally correct results when
 * called through the dispatch layer. After the engine consolidation (T5099),
 * all engines live in src/dispatch/engines/.
 *
 * These tests validate:
 *  1. Key operations return EngineResult with correct shape
 *  2. Error paths return properly structured error results
 *  3. Barrel re-exports are functionally equivalent to direct dispatch imports
 *
 * Tests that require a real DB are skipped with explanation.
 *
 * @task T5099
 */
export {};
//# sourceMappingURL=parity.integration.test.d.ts.map