---
id: merge-closes-tasks
tasks: [T14101, T14121, T14122]
kind: feat
summary: "A merged PR with green CI on its head closes the tasks its body names (Closes:/Refs: lines), with no agent step"
---

Merged work used to stay open until an agent re-proved it with
`cleo done <id> --pr <n>`, which once stalled closures for ten hours. Owner
decision D11209 makes the merge itself close the work.

A PR body names its tasks one per line:

- `Closes: T#### AC1,AC2` records the PR's evidence and completes the task,
  once the criteria every merged PR bound cover all of the task's criteria.
- `Refs: T#### AC1` binds those criteria from a PR that delivers part of a
  task, and leaves it open.

The PR's required checks must be green on its exact head. CI never writes to
a task store. The new `Merge Close` workflow posts a receipt on each merged PR,
or a comment saying why it closes nothing. The store owner's machine applies
the receipt with `cleo done --from-merge <pr|all>`, which re-derives
everything from gh and records through the same path as `cleo done --pr`:
`pr:` with the changed files for `implemented`, and the merged CI (`ci:`, with
`evidence.ciSatisfies`) for `testsPassed` and `qaPassed`, each linked to the
named criteria.

The sweep runs in three places:

- on the daemon loop, every 5 minutes;
- lazily, in a detached child, when an agent runs `briefing`, `next`,
  `current`, `show` or `release`, at most every 5 minutes;
- on demand.

The author's line is the plan, not the proof (owner decision D11211). A
criterion is recorded as satisfied only from an independent reviewer's `met`
verdict (`cleo review`, written from the reviewer's own session) on the PR's
final head. A missing, unmet or stale verdict (a push after review) closes
nothing and the PR comment names the criterion. Before merge, the sweep sets a
`cleo/merge-close` status on each open PR carrying the lines, red naming each
unverified or unbound criterion, so the gap shows while it can still be fixed.

The sweep never skips a merged PR: it pages each window until it reaches its
cursor, keeps any window a page budget leaves unread as a backlog the next
sweep reads first, and reports it as `truncated`. A merge whose own CI run
was cancelled or skipped, with no later run standing in yet, waits instead of
being refused: it is re-judged every sweep and reported as `waiting`. A
one-time automatic rerun of the cancelled run exists but is off until T14136
gives reruns their own concurrency group (`CLEO_MERGE_SWEEP_RERUN=1` opts in;
a failed run is never rerun). Results report `waiting` and `reran` counts. Writes run under a bound
session (the caller's, or a short `merge-sweep` session for the daemon).

Each applied line writes one `merge_close` audit row keyed by PR, merge commit
and task, so a rerun records nothing twice. A refusal (an unknown task or
criterion, an unbound criterion, red CI, or a validator refusal) closes
nothing for that task and is commented on the PR once.

`cleo done --from-merge <pr> --dry-run` shows what a PR would record, before
or after it merges. The PR template carries the lines.
