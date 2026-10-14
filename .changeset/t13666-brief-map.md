---
id: t13666-brief-map
tasks: [T13666]
kind: feat
summary: "`cleo map --brief`: a nexus-backed codebase map within a character budget, optional in `cleo briefing`"
---

Ponytail parity for the session codebase map (`ponytail-map.js`, MIT, idea
and fallback patterns adapted). `cleo map --brief [--budget N]` lists the
exported names of each folder on one line, within N characters (default
2000), shared code first, tests and generated files skipped.

The names come from the nexus graph, which is exact because it is parsed by
tree-sitter, when the project is indexed. Otherwise they come from a regex
walk of git-tracked files. The envelope reports which source was used, plus
the folders listed and skipped.

With `lean.map: true` in the config, `cleo briefing` carries the map as
`codebaseMap`, so "reuse first" costs no search. It is opt-in because it adds
up to about 2,000 characters per briefing.
