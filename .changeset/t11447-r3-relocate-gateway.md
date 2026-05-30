---
id: t11447-r3-relocate-gateway
tasks: [T11447, T11254]
kind: refactor
summary: Relocate the CQRS Dispatcher core to @cleocode/runtime/gateway (subpath) with cleo re-export shims — zero behavior change
---

R3-T3 for SG-RUNTIME-UNIFICATION. Moves the transport-agnostic dispatch core (Dispatcher + registry + meta + pipeline/compose) from packages/cleo/src/dispatch into packages/runtime/src/gateway (mirrors @cleocode/runtime/daemon). Adds createGatewayHandler/GatewayHandler entrypoint. No cycle (runtime already deps core); Dispatcher is injection-based so domain handlers + transport middleware stay in cleo. cleo/dispatch/{dispatcher,registry,lib-meta,middleware-pipeline}.ts are thin re-export shims so the CLI adapter + getCliDispatcher + ~18 registry consumers compile unchanged. Verified: runtime+cleo build clean, live dispatch smoke (tasks.exists) OK, arch 5/5, json-stream-hygiene + contracts-fan-out + cli-boundary pass.
