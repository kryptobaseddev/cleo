---
id: nexus-batch-bounded-heap
tasks: [T13656]
kind: fix
summary: `cleo nexus analyze` holds one file's sites at a time, so a 21 000-file repository indexes under the default 1.5 GiB heap
---

Peak heap of an analysis grew with the repository: every file's decoded
extraction, every call and access site, and every retained reference (2.85
million on a 21 000-file repository) were held at once, and publication then
copied the whole graph into row arrays. A repository three times the size of
a 7 000-file project needed 2.7 GiB of heap and could not be indexed under
the 1.5 GiB CLI cap at all.

- Each file's extraction is kept compressed (outside the V8 heap) from the
  moment it is parsed or read from the parse cache. The merge decodes only
  its declarations; call and access resolution decode their own section one
  file at a time. The parse-cache payload format moved to v2 (framed
  sections), so the first run after upgrading re-parses once.
- Retained references are serialized into their stored encoding as they are
  reported; only the compressed list and its count are kept, and the
  publisher writes the bytes verbatim.
- Publication rows are produced lazily as the publisher inserts them, 500 at
  a time, and resolved call reasons are built as flat strings.

On the 21 000-file repository the full analysis now peaks at 0.9 GiB of heap
(was 2.7 GiB) in about the same wall time, and an incremental run peaks at
0.94 GiB, both under the default cap.
