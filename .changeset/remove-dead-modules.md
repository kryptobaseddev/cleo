---
id: remove-dead-modules
tasks: [T12134]
kind: fix
summary: remove two modules nothing imports, one of them three minor versions past its own removal target, and add a repeatable sweep for the rest
---

`adr-backfill-walker.ts` (765 lines) carried a `.cleo/deprecations.yml` entry
scheduling it for removal in **v2026.6.0**. The current version is v2026.8.9 —
three minor versions past due — and no module in the workspace imported it. Its
replacement (`cleo docs add --type note`) has been canonical since T9788.

`graph-rag.ts` (383 lines) had eight exports, zero importers, and no reference
anywhere outside generated API docs (which are derived from the source, so they
are not evidence of use).

`scripts/find-unimported-modules.mjs` makes the question repeatable. It resolves
relative and `@cleocode/*` specifiers and counts barrel re-exports, so a module
reachable through `index.ts` is not reported. It currently finds **192 modules
totalling ~33,700 lines** that nothing imports — a starting point, not a verdict:
SvelteKit routes, npm lifecycle scripts and one-off migrations are all loaded by
convention rather than import, and the script's docblock names those false
positives explicitly.

All five entries in `.cleo/deprecations.yml` are now past their stated removal
version. Only the one with zero importers is removed here; the other four are
shims that may still have out-of-tree consumers and need a deliberate decision.
