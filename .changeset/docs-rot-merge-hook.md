---
id: docs-rot-merge-hook
tasks: [T14111]
kind: feat
summary: "flagDocsRot is the merge sweep's docs-rot hook: a merged PR's tasks get flagged for the docs it left stale"
---

`flagDocsRot(storeRoot, { prNumber, mergeSha, taskIds })` matches the merge
sweep's `MergeCloseDeps.docsRot` (T14101). It scans the PR's change
(`<mergeSha>^1..<mergeSha>`), labels each applied task `docs-update`, and adds
a note for each doc whose covered code changed without the doc. It never
throws: a merge commit that is not in local history, or a refused task write,
flags nothing.
