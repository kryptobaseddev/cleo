---
id: t11654-utils-devdep-installable
tasks: [T11654]
kind: fix
summary: Fix v2026.6.0 uninstallable — move private @cleocode/utils to devDependencies in cleo+core (it is esbuild-inlined, not a runtime dep).
prs: []
---

`npm i -g @cleocode/cleo@2026.6.0` failed with `404 @cleocode/utils@2026.5.122`. `@cleocode/utils` is `private:true` (never published) and is esbuild-INLINED into the `@cleocode/cleo` and `@cleocode/core` bundles (build.mjs alias `@cleocode/utils` → `packages/utils/src/index.ts`), so it is a build-time bundle, not a runtime npm dependency. Declaring it under `dependencies` made npm try to resolve a package that does not exist on the registry.

**Fix part 1 — dependency move.** Moved `@cleocode/utils` from `dependencies` → `devDependencies` in `packages/cleo/package.json` and `packages/core/package.json`. An audit of every other published `@cleocode/*` package found no other private/unpublished `@cleocode/*` runtime dependency — `cleo` and `core` were the only two.

**Fix part 2 — build re-emit.** `packages/playbooks` builds with `tsc -b` (project-reference build mode) referencing `../core`. Because core's tsc pass runs `--emitDeclarationOnly`, its `.tsbuildinfo` records a declaration-only emit, so playbooks' `tsc -b` re-emits the whole composite core project via plain tsc — which does NOT apply the esbuild `@cleocode/utils` alias. That clobbered core's clean esbuild output for the 3 leaf modules that import utils (`memory/redaction.js`, `llm/plugin-facade.js`, `docs/export-document.js`), leaving a bare `import '@cleocode/utils'` in the published `@cleocode/core` tarball that would throw `ERR_MODULE_NOT_FOUND` at runtime once utils is no longer an npm dependency. The tsc clobber also emits nested-subdir `.js` (e.g. `store/exodus/index.js`) the esbuild scan does not cover, so instead of disabling it, build.mjs adds a Wave 7.5 that re-runs core's esbuild after the playbooks wave — esbuild re-emits its entry points (utils inlined) and overwrites the 3 clobbered files while the tsc-emitted nested-subdir files survive.

Verified via `npm pack` of `@cleocode/core` (no `@cleocode/utils` in `dependencies`, no external utils import in dist) and `cleo --version` (CLI loads, `store/exodus` resolves).
