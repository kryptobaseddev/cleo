---
id: t11259-r8-mcp-adapter-to-runtime-gateway
tasks: [T11259, T11510, T11511]
kind: refactor
summary: R8 — Delete standalone @cleocode/mcp-adapter; MCP transport consolidated into @cleocode/runtime/gateway/mcp
---

Removes the standalone `packages/mcp-adapter` package (source and workspace entry). The MCP stdio adapter is now fully integrated into `@cleocode/runtime/gateway/mcp` (R3-T4 · T11448), routing every `tools/call` through the unified `createGatewayHandler` at `source: "mcp"` rather than calling `@cleocode/core` directly. The external tool surface (3 sentient tools) is unchanged — generated from the OPERATIONS registry behind the default-deny `mcpExposed` flag.

Publish surface remains at 18 (mcp-adapter was already excluded from the npm publish list in E1 · T11399).
