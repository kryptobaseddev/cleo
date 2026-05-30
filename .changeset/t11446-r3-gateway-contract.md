---
id: t11446-r3-gateway-contract
tasks: [T11446, T11254]
kind: feat
summary: Promote the CQRS gateway contract to @cleocode/contracts/gateway and widen Source to a 4-transport union (cli|mcp|rpc|http)
---

R3-T2 keystone for SG-RUNTIME-UNIFICATION. Zod-validated gateway contract (DispatchRequest/Response/Error/Meta + GatewayStreamEvent + GATEWAY_CONTRACT_VERSION) now lives in contracts so every transport adapter shares one validated shape. packages/cleo/src/dispatch/types.ts is a thin re-export shim (zero behavior change, tsc-proven). Unblocks the MCP/RPC/HTTP adapters (R3-T3..T6) and R8/R10 publish internalization.
