---
id: nexus-refresh-admission-graph-size
tasks: [T14019]
kind: fix
summary: "An inline NEXUS refresh on a large graph asks `cleo run` admission even when it re-parses few files, with a footprint scaled to the graph"
---

An inline refresh used to ask `cleo run` admission only when it re-parsed
more than 25 files or 30% of them. On a large repository, though, most of the
memory goes to the whole-graph phases (resolve, communities, flows and the
republish), even when only one file is re-parsed. A refresh of a graph with
more than 2,000 indexed files now always asks admission. When the machine is
busy it answers from the stale index and says so.

The admission footprint now scales with the graph: 256 KiB per indexed file,
at least 256 MiB, and at most the `scoped-build` class footprint. It used to
be the class footprint every time.
