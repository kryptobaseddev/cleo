---
id: t9939-build-cant-before-caamp
tasks: [T9939]
kind: fix
summary: "build.mjs declares cant as a hard prereq of caamp via explicit PACKAGE_DEPS map (T9939)"
---

`caamp`'s tsup DTS step imports `@cleocode/cant` (via
`rollup-plugin-dts` resolving `@cleocode/cant` declarations on disk). The
previous wave structure in `build.mjs` ordered cant before caamp via
comments only — a future refactor could silently break the ordering and
produce a confusing `TS2307: Cannot find module '@cleocode/cant'` deep
inside tsup's DTS output. Contributors hit this during T9853 hotfix prep
and had to manually `pnpm --filter @cleocode/cant run build` before
`pnpm run build` worked.

Fix:

- New module `scripts/build-deps.mjs` declaring the canonical
  `PACKAGE_DEPS` map. Each entry maps a `packages/<pkg>/dist/` label to
  the list of internal dist labels that MUST exist before that build
  starts. The `cant -> caamp` edge is now data, not a comment.
- New helper `assertDepsReady(label)` in `build.mjs` runs immediately
  before every `buildPkg(...)` and before each raw `esbuild.build(...)`
  call in waves 5, 6, and 8. Throws `E_BUILD_DEP_MISSING` with an
  actionable message if any declared dep's `dist/` is absent, instead of
  letting tsup explode 30 seconds later inside rollup-plugin-dts.
- Regression test suite at `scripts/__tests__/build-deps.test.mjs` locks
  the cant→caamp edge, asserts every dep is itself a known key (no
  orphans), proves the graph is acyclic via Kahn's algorithm, and
  verifies cant precedes caamp in the topological sort.

Verified end-to-end: `rm -rf packages/cant/dist packages/caamp/dist &&
pnpm run build` now succeeds without any manual filter-build of cant
first (build complete in 25s). The negative path was also exercised —
calling `assertDepsReady('packages/caamp/dist/')` with cant/dist absent
correctly throws `E_BUILD_DEP_MISSING` referencing
`packages/cant/dist/`.
