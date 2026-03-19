/**
 * CLI/MCP Parity Integration Tests
 *
 * Verifies that the CLI and MCP paths produce identical results for shared
 * operations. Both CLI and MCP ultimately route through the same domain
 * handlers (TasksHandler, SessionHandler, etc.), which delegate to the same
 * src/core/ functions.
 *
 * Test strategy:
 *   1. Direct domain handler parity — call handler.query()/handler.mutate()
 *      and dispatchRaw() for the same operation; assert identical data.
 *   2. CLI dispatch path — call dispatchRaw() and verify it reaches the same
 *      handler as MCP would via createDomainHandlers().
 *   3. Cross-adapter data identity — same mock engine function is called with
 *      identical args from both CLI and MCP code paths.
 *   4. MCP gateway normalization gap — document that handleMcpToolCall passes
 *      'cleo_query' as gateway but the registry expects 'query' (a real gap).
 *
 * Architecture under test:
 *   CLI:  dispatchRaw('query', domain, op, params)
 *           → getCliDispatcher() → Dispatcher (sanitizer mw)
 *           → TasksHandler.query(op, params)
 *           → task-engine fn → core/tasks/*
 *
 *   MCP:  handleMcpToolCall('cleo_query', domain, op, params)
 *           → getMcpDispatcher() → Dispatcher (sanitizer+rl+gates+protocol+audit mw)
 *           → same TasksHandler.query(op, params)  [same handler instance via createDomainHandlers()]
 *           → same task-engine fn → same core/tasks/*
 *
 * @task T4796
 * @epic T4654
 */
export {};
//# sourceMappingURL=cli-mcp-parity.integration.test.d.ts.map
