---
id: t13126-cli-startup-split
tasks: [T13126]
kind: fix
summary: cleo --version and --help no longer load all of CORE; every command drops the drizzle resolver spike
---

Every `cleo` call peaked at about 440 MB RSS, `cleo --version` included, because the CLI bundle
loaded all of CORE (about 3,900 modules) on every invocation. Three causes, three fixes:

- **The bundle defeated its own lazy imports.** The CLI was bundled without esbuild code splitting,
  and esbuild then hoists every external import of every inlined `import()` target to a static
  import of the one output file. The source deferred `@cleocode/core` to the command that needs it;
  the bundle loaded it first. The CLI now builds with `splitting`: each `import()` is a real dynamic
  import of its own chunk, written beside `dist/cli/index.js`.
- **Node re-parsed package.json exports on every import edge.** Node 24 works out each `.js` file's
  format by deserializing the package's whole `exports` map. drizzle-orm's is 290 KB, so opening a
  store cost about 140 MB of short-lived garbage, and the peak varied with GC timing. The CLI now
  registers a resolve fast path that answers relative imports from a per-package `type` cache and
  caches bare-specifier answers per directory; everything else still goes to Node.
- **Two copies of contracts.** The CLI inlined `@cleocode/contracts` while CORE loaded it from
  `node_modules`, so every contracts zod schema existed twice. Contracts is now external.

The output path imports narrow CORE modules instead of the barrel, and the CORE modules on it import
contracts leaf modules. Measured on an installed tarball layout in a fresh sandbox, against 2026.10.3:
`--version` 302 -> 76 MB, `--help` 300 -> 56 MB, `show`/`find`/`list`/`current` about 335 -> 280 MB.
Output, stderr and exit codes are unchanged.

New arch gate 39 (`scripts/check-cli-startup-graph.mjs`) measures the BUILT CLI, which gates 19 and
25 could not: the entry's static graph may not import a barrel, and `--version`, `--help` and `show`
run in a sandbox under module-count budgets and RSS ceilings that may only fall.

`CLEO_RESOLVE_FAST_PATH=0` turns the resolve fast path off.
