---
id: t12009-gateway-autostart-entry-path
tasks: [T12009]
kind: fix
summary: Layout-proof CLI entry resolution for gateway auto-start — fixes MODULE_NOT_FOUND in packaged installs
---

Fixes a P0 regression where `cleo` (bare, on a TTY) always printed "daemon gateway is not reachable" in every packaged npm install. The auto-started gateway child died instantly with `Cannot find module '/home/.../.npm-global/lib/dist/cli/index.js'`.

**Root cause (T12009):** `resolveCliEntryPath()` used `join(dirname(import.meta.url), '..', '..', '..', '..', '..')` — correct in the source tree where `src/cli/lib/` is 3 directories deep, but the esbuild bundle inlines ALL source into a single file at `<pkg>/dist/cli/index.js`. Inside the bundle `import.meta.url` IS that entry file, so `dirname` is `<pkg>/dist/cli/` (only 2 hops to the package root). Five `..` from there escapes the package entirely, landing at the npm prefix `lib/` directory.

**Fix:** Replace the fixed-depth `..` arithmetic with a walk up the directory tree, looking for the nearest ancestor `package.json` with `name === "@cleocode/cleo"`. The resolver also calls `realpathSync` on the start path so symlinked global-bin installs (`.npm-global/bin/cleo → ../lib/node_modules/@cleocode/cleo/bin/cleo.js`) resolve correctly. A descriptive error is thrown (and caught/surfaced gracefully) when the bundle is missing.

**Observability (T12009 AC):** `runCockpit` previously discarded `spawnResult.reason` entirely. It now surfaces it as `  auto-start: <reason>` and also appends the last line of `<logDir>/gateway.err` when readable — that one line would have made T12009 a 1-minute diagnosis.

**Regression tests:** Four new tests in `gateway-auto-start.test.ts` exercise the resolver against synthetic package hierarchies in a tmp directory: (a) bundled `dist/cli/` layout, (b) symlinked global-bin entry, (c) missing `dist/cli/index.js` → descriptive throw, (d) no `@cleocode/cleo` package found → descriptive throw. All 26 tests pass.

**Live proof:** Bare `cleo` in a TTY on this machine boots the gateway (`ss -ltn` confirms port 7777 accepting) and renders the full Kanban board ("CLEO Cockpit — Kanban (498 tasks)") without the "not reachable" message.
