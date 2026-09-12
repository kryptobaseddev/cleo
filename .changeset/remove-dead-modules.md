---
id: remove-dead-modules
tasks: [T12134]
kind: fix
summary: remove two modules nothing imports, one of them three minor versions past its own removal target, and add a repeatable sweep for the rest
---

`adr-backfill-walker.ts` (765 lines) is removed on the strength of its
**deprecation**, not the import sweep. It carried a `.cleo/deprecations.yml`
entry scheduling removal in **v2026.6.0**; the current version is v2026.8.9,
three minor versions past due, and its replacement (`cleo docs add --type
note`) has been canonical since T9788.

The distinction matters because the sweep's answer was *invalid for this file*.
It is a CLI script — it parses `process.argv` for `--dry-run`/`--apply` and
documents how to invoke it by path — so it is executed, never imported, and
"nothing imports it" is true and beside the point. The sweep's own docblock
listed "one-off scripts invoked by path" as a known false positive while its
`isEntry` check did not implement the exclusion. That is now fixed (see below),
and the reported count drops from 192 to **185**: seven of the original
findings were executable scripts.

`graph-rag.ts` (383 lines) had eight exports, zero importers, and no reference
anywhere outside generated API docs (which are derived from the source, so they
are not evidence of use).

`scripts/find-unimported-modules.mjs` makes the question repeatable. It resolves
relative and `@cleocode/*` specifiers and counts barrel re-exports, so a module
reachable through `index.ts` is not reported. `isEntry` now also treats a module
with a shebang, a `process.argv` read, or an `import.meta.main` guard as an
entry point — executed by path, invisible to any import graph. It finds **185
modules totalling ~32,400 lines**: still a starting point, not a verdict.

Two limits worth stating. SvelteKit routes and npm lifecycle scripts remain
convention-loaded false positives. And core's `exports` map is `./*` →
`./dist/*.js`, so **every** dist file is a published entry point — meaning
"nothing in this repo imports it" is strictly narrower than "nothing imports
it", and an import sweep can only ever answer the narrow question. For these two
modules that risk is accepted: one is three versions past its own removal date
with a canonical replacement, the other is a library module with no external
documentation pointing at it.

All **six** entries in `.cleo/deprecations.yml` were past their stated removal
version. Only the one with zero importers is removed here; the remaining five
are shims that may still have out-of-tree consumers and need a deliberate
decision about the deprecation window.
