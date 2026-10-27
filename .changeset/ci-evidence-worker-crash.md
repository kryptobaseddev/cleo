---
id: ci-evidence-worker-crash
tasks: [T14074]
kind: fix
summary: "ci: evidence stands a later green main run in for a merge-commit job that only crashed a vitest worker, with no failed test"
---

A merge commit whose unit shard lost a vitest fork ("Worker exited
unexpectedly", 0 failed tests) was refused as a real failure the PR
introduced, and every rerun crashed the same way because the crash was fixed
later (T14069). Such a job is now treated like a runner cancellation (T14049):
the merge-commit verdict is superseded and the later green main run stands in.
A job with any failed test or file, a non-pool unhandled error, or another
step error is never stood in for. The `ci` atom records each such job and its
cause (`runner-cancel` or `worker-crash`) in `untestedFailures`.
