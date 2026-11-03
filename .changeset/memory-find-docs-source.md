---
id: memory-find-docs-source
tasks: [T14152]
kind: feat
summary: "cleo memory find --docs searches the docs store beside BRAIN, returning current docs only"
---

`cleo memory find "<query>" --docs` adds the docs store as a search source:
each text doc's body is ranked against the query, and the doc hits (type
`doc`, with an RRF score) are merged into the BRAIN hits. `--type doc`
searches the docs store alone. Superseded docs never appear: a match on one
is resolved along its supersession chain and surfaces the current doc, whose
`replaces` field names the superseded slug. Docs are opt-in because ranking
every doc body costs seconds on a large store; the default search is
unchanged.
