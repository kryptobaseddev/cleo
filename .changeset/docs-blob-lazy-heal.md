---
id: docs-blob-lazy-heal
tasks: [T13705]
kind: fix
summary: "docs fetch and view heal a doc whose bytes predate the blob store on first read, instead of failing until docs doctor --repair runs"
---

After #2210 retired the legacy byte reads, docs written before the blob store
held every body (about 80 of this repository's, from May) failed `cleo docs
fetch` and `cleo docs view` with "bytes are not in the blob store; run cleo
docs doctor --repair" until someone ran the repair. Every user upgrading would
hit it.

A blob-store miss now runs the same hash-verified single-sha backfill the
repair uses: when the doc's legacy bytes exist and hash to the recorded sha,
they are written atomically into the blob store (only ever adding an absent
content-addressed file) and served. Missing or hash-mismatched legacy bytes
write nothing and keep the existing refusal. The legacy locator and backfill
moved from `docs/doctor.ts` to `store/blob-keep.ts`, next to the blob-store
path helpers, so the read path and the repair share one implementation.
