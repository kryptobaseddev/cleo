---
id: sleep-merge-abort-propagates
tasks: [T14653]
kind: fix
summary: "@cleocode/core sleep consolidation stops and throws SleepMergeAbortedError when a merge rollback fails inside a caller transaction, so the caller rolls back instead of committing partial writes"
---

When a failed pair's `ROLLBACK TO` failed inside a caller's transaction,
`runSleepConsolidation` caught the error and ran steps 2-4 inside that doomed
transaction, with the pair's savepoint still open, and reported
`mergeFailed: 0`. The merge step now throws `SleepMergeAbortedError`, whose
`mergeDuplicates.failed` counts the failed pairs; `runSleepConsolidation` and
`runConsolidation` run no further step and rethrow it.
