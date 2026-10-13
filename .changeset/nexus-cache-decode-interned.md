---
id: nexus-cache-decode-interned
tasks: [T13325]
kind: fix
summary: an incremental `cleo nexus analyze` no longer runs out of heap decoding its parse cache
---

An incremental run decodes the cached extraction of every unchanged file
before parsing. Each decode `JSON.parse`d its payload with no string sharing,
so the file path, enclosing scope and generation repeated on every call and
access record were held once per occurrence: 1.1 GiB of heap for 5 301 files
of a 7 000-file repository, against 0.55 GiB for a full parse of the same
files, whose worker results were already interned (T13325). The later phases
then ran in a heap with no room: Leiden took 35 s of collection instead of 3 s
and the run aborted at the 1.5 GiB CLI cap.

Decoded cache entries are now interned through one string pool per run, as
worker results are. The same incremental run decodes into 0.6 GiB, peaks at
1.1 GiB and completes under the default cap.
