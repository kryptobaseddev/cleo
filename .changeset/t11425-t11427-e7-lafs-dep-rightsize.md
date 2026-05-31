---
id: t11425-t11427-e7-lafs-dep-rightsize
tasks: [T11425, T11426, T11427]
kind: refactor
summary: "lafs: retire @a2a-js/sdk + express from CLEO-core runtime closure; update boundary.ts + ADR-039"
---

T11425: `@a2a-js/sdk` moved from `dependencies` to `devDependencies` + optional
`peerDependencies` in `packages/lafs/package.json`. Runtime A2A value re-exports
removed from the main `@cleocode/lafs` index; A2A types remain (compile-erased).
The `/a2a` subpath is unchanged and fully usable for product-only consumers.
Removes the `packages/cleo/vitest.config.ts` T9965 workaround that aliased
`@a2a-js/sdk` to `lafs/node_modules` in worktrees.

T11426: `express` moved from `dependencies` to `devDependencies` + optional
`peerDependencies`. Express is only type-imported in `a2a/extensions.ts`
(compile-erased) and referenced in JSDoc examples in `health/` and `shutdown/`
— zero production CLEO consumers instantiate an Express app through lafs.
T11243 daemon uses its own HTTP layer; no reuse intent confirmed.

T11427: `packages/contracts/src/boundary.ts` lafs module entry updated to reflect
the realized E7 design: contracts=type-SSoT, core=runtime+validate-SSoT,
lafs=external-spec-SDK with lafs-napi hot-path wired, conformance-as-CI-gate,
a2a/ops product-only with optional peer deps. ADR-039 amended (T11427 section)
documenting the canonical role partitioning, hot-path validator, conformance gate,
and A2A product-only isolation.

No CLEO-core package (core, cleo, cleo-os, contracts, runtime) depends on
`@a2a-js/sdk` or `express` at runtime. CI: build + test + `cleo check arch`
must remain green.
