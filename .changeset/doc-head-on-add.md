---
id: doc-head-on-add
tasks: [T14329]
kind: fix
summary: "docs add records each doc's head version, and version bytes resolve by content hash, so the expected-base fence works for new and migrated docs"
---

A doc added with `cleo docs add` had no version head until its first update,
so `cleo docs fetch` showed no `metadata.headVersionUid` and an agent could not
pass `--base-version-uid`. Every slugged add (inline content, a file, a URL)
now records the doc's identity, a first version holding exactly its bytes and
the head, and returns `headVersionUid`.

Version bytes are now read by content hash from the blob store, then the legacy
attachment tree. A doc imported by `cleo docs migrate` (or on a store without
the legacy tree) could not be used as a declared base before; it can now. A
legacy doc with no head is seeded by running `cleo docs migrate` once, and the
base-unknown error says so.
`cleo docs migrate` still migrates every remaining doc in one run by default,
and now takes `--limit <n>` to batch a large store: oldest first, at most n
docs per run, reporting how many are left so the next run continues.
