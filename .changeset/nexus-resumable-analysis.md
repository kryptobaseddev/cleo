---
id: nexus-resumable-analysis
tasks: [T14009]
kind: feat
summary: NEXUS analysis keeps its parse work across an abort, and honours its budget in every phase
---

`cleo nexus analyze` (and the inline refresh) now commit each parsed file's
extraction to the parse cache as it arrives, in small batches outside the graph
publication. An analysis that is aborted, over budget or killed keeps that work,
and the next run reuses it: a rebuild resumes exact cached extractions (same
path, content hash and extractor build) unless `--full` was asked for, the graph
is being re-bound, or the published graph came from another extractor build.
The publication still replaces the graph atomically and keeps exactly its own
files in the cache.

The budget signal is now checked between and inside resolution (heritage, calls,
accesses), community detection and flow detection, so an over-budget run stops
at the next check with the previous graph intact. The Leiden step itself is a
synchronous library call; the budget is checked on both sides of it.
