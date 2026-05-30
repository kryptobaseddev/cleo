---
id: t11452-freeze-gateway-contract
tasks: [T11452, T11254]
kind: test
summary: Freeze gateway-contract v1.0 — lock the full contract surface (version + 4 transports + all frozen shapes) + spec doc
---

R3-T8. Adds the gateway-contract v1.0 FREEZE block to gateway-contract.test.ts locking GATEWAY_CONTRACT_VERSION=1.0.0 + GATEWAY_SOURCES + the frozen field sets of DispatchError/DispatchResponseMeta/GatewayStreamEvent (request/response already snapshotted in R3-T2). Any breaking change fails the snapshot + requires a version bump. Versioned spec registered (slug gateway-contract-v1) documenting the contract, 4 adapters (cli/mcp/rpc/http), process-per-scope, the supervisor-ipc-v1.0-separate-freeze boundary, and the freeze policy.
