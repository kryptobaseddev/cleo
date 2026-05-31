---
id: t11448-mcp-gateway-adapter
tasks: [T11448]
kind: feat
summary: Build @cleocode/runtime/gateway/mcp as a thin MCP transport adapter that routes tools/call through the gateway and generates tools/list from the OPERATIONS registry behind a default-deny mcpExposed flag, deprecating the standalone @cleocode/mcp-adapter
---

Add `@cleocode/runtime/gateway/mcp` — a thin Model Context Protocol transport adapter over the unified gateway (R3-T4). It serves MCP JSON-RPC over stdio and maps every `tools/call` onto a `source: 'mcp'` `DispatchRequest` routed through an injected `GatewayHandler` (built via `createGatewayHandler`), returning the LAFS envelope as the MCP tool result. `process.exit` and error-render stay in the adapter, never in the handlers.

`tools/list` is now generated from the canonical `OPERATIONS` registry behind a new **default-deny** `mcpExposed` boolean on `OperationDef` (`@cleocode/contracts`). Only operations that explicitly opt in are surfaced. The three sentient operations the standalone `@cleocode/mcp-adapter` exposed today (`status`, `propose.list`, `propose.enable`) are flagged `mcpExposed: true`, so the external tool SET (`cleo_sentient_status`, `cleo_sentient_propose_list`, `cleo_sentient_propose_enable`) is unchanged. A new `sentient.status` gateway op + `SentientHandler.status` op back the status tool so it now routes through the gateway like every other transport (the CLI `cleo sentient status` op label is preserved).

The standalone `@cleocode/mcp-adapter` is marked `@deprecated` in favour of the gateway-routed adapter (one deprecation cycle; existing consumers keep working). `@cleocode/runtime` retains NO `@cleocode/cleo` dependency.
