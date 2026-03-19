/**
 * Registry-Handler Parity Test
 *
 * Verifies that every operation in the OPERATIONS registry has a matching
 * handler case in the corresponding domain handler. An operation that returns
 * E_INVALID_OPERATION means the handler switch/case is missing that op.
 *
 * This test does NOT verify correctness of handler results -- only that each
 * registered operation is recognized by its domain handler (no "unsupported
 * operation" error).
 *
 * @task T5671
 */
export {};
//# sourceMappingURL=registry-parity.test.d.ts.map