---
id: blob-readers-worktree
tasks: [T14134]
kind: fix
summary: "attachment repair, blob consolidation and the docs inconsistency detector see the project's blobs when run from a CLEO worktree"
---

Follow-up to T14127. Three more readers joined `<root>/.cleo/...` literally,
so from a canonical worktree they looked in the worktree's seeded `.cleo/` and
misreported which blobs exist. `checkBlobFilesystem` and the blob-consolidation
scans now map the root through `resolveStoreOwnerRoot`. The attachment repair's
manifest check uses the store directory it already resolves.
