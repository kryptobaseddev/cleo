/**
 * Memory Domain — Legacy Operation Name Rejection (Regression Tests)
 *
 * Verifies that OLD operation names that were renamed or moved during
 * the T5241 memory domain cutover now return E_INVALID_OPERATION from
 * the MemoryHandler. This prevents agents using stale operation names
 * from silently succeeding.
 *
 * @task T5241
 * @epic T5149
 */
export {};
//# sourceMappingURL=memory-legacy-rejection.test.d.ts.map
