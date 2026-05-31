---
id: t11455-decouple-domain-handler-subgraph
tasks: [T11455]
kind: refactor
summary: Decouple the domain-handler subgraph from cleo-internals — relocate the shared handler dependencies (engine barrel, engine-error/exit-codes, template-parser, nexus-decorator, job-manager-accessor/background-jobs, path constants) into @cleocode/runtime/gateway so the runtime can assemble the handler map without importing @cleocode/cleo
---

Relocate the shared handler dependencies that previously coupled the 27 domain handlers in `packages/cleo/src/dispatch/domains/` to cleo-internal `engines/` / `lib/` / `cli/paths` / `nexus-decorator` into `@cleocode/runtime/gateway` (mirroring the R3-T3 dispatcher/registry/meta relocation). The domain handlers now import only from `@cleocode/runtime`/`@cleocode/core`/`@cleocode/contracts`; thin re-export shims remain at every old cleo-internal path for zero behavior change. This is the R3-K1 keystone that unblocks the T11448 (MCP), T11449 (CLI-RPC), and T11450 (Studio HTTP+SSE) transport adapters, which were `V_UNMET_DEP` until the handler subgraph could be assembled without `@cleocode/cleo`.
