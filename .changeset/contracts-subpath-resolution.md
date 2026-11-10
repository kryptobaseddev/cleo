---
id: contracts-subpath-resolution
tasks: [T14412]
kind: fix
summary: "every @cleocode/contracts subpath now names one source file; new arch gate 44 keeps vitest and dist resolution in step"
---

Vitest reads `src/<subpath>.ts` (else `src/<subpath>/index.ts`) for a
`@cleocode/contracts/<subpath>` import, while Node resolves the contracts
`exports` map onto `dist/`. A module `x.ts` beside a directory `x/` let the two
disagree: in #2772 `@cleocode/contracts/config.js` read `src/config.ts` under
vitest and `dist/config/index.js` in the build, so the tests passed and the
build broke.

- The four collisions are gone. `gateway.ts`, `memory.ts` and `tasks.ts` moved
  to `gateway/index.ts`, `memory/index.ts` and `tasks/index.ts`; `config.ts`
  (the config types) moved to `config/types.ts`, since `config/index.ts` is the
  public `@cleocode/contracts/config` surface. Every public subpath and the
  package root export the same symbols as before; `./memory`, `./memory.js`,
  `./tasks` and `./tasks.js` gained explicit exports pointing at the moved
  modules.
- Arch gate 44 (`scripts/lint-contracts-subpath-resolution.mjs`, run by
  `cleo check arch` and CI) fails on any `x.ts` beside `x/` under
  `packages/contracts/src`, and on any subpath import whose `import` or `types`
  target is not the compiled form of the source vitest reads, or is not
  exported. Pure static; no build needed.
