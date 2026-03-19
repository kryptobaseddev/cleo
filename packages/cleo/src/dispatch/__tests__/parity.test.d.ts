/**
 * Dispatch Layer Parity Tests
 *
 * Validates that the dispatch layer's structural contracts hold end-to-end:
 *  1. Registry completeness — every OPERATIONS entry is well-formed
 *  2. ParamDef → MCP Schema derivation — buildMcpInputSchema correctness
 *  3. ParamDef → Commander derivation — buildCommanderArgs / buildCommanderOptionString
 *  4. Dispatch routing correctness — resolve() and validateRequiredParams()
 *  5. Schema utils — getOperationSchema() behaviour
 *
 * These tests are self-contained and do not spawn external processes.
 * Tests that would require a real DB are marked it.skip with a comment.
 *
 * @task T4905
 * @epic T4894
 */
export {};
//# sourceMappingURL=parity.test.d.ts.map
