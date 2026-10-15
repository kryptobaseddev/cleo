---
id: wikilinks-chunk-bounded-errors
tasks: [T13711]
kind: fix
summary: Docs wikilinks rebuild chunks past SQLite's variable cap; rebuild warnings stay bounded and never print SQL params
---

`rebuildWikilinks` sent every edge in one INSERT, so a store past 6553 edges
(axiom-app: 8387) exceeded SQLite's 32766 bound-variable cap and the whole
rebuild rolled back. The insert now chunks at floor(32766 / column count)
inside the same transaction, so the rebuild stays atomic.

The warning printed when a rebuild fails used drizzle's error message, which
carries the full SQL and every bound parameter (~900 KB per docs write).
`boundedErrorMessage` walks the `cause` chain to the deepest driver error,
cuts any `params:` section, collapses the result to one line, caps it, and
reports how many characters it cut.
