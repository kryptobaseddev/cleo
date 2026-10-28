---
id: worktree-blob-fetch
tasks: [T14127]
kind: fix
summary: "cleo docs fetch from a CLEO worktree now reads the project's blob store, the same bytes the project root reads"
---

`blobReadBySha` and `CleoBlobStore` joined `<projectRoot>/.cleo` literally.
From a canonical worktree that is the worktree's own seeded `.cleo/`, which
holds no blobs, so a fetch could not find bytes that the project root's fetch
validated. Both now map a linked worktree to its parent project's store
(`resolveStoreOwnerRoot`), which is where the writers put the bytes.
