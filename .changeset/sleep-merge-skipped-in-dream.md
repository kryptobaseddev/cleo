---
id: sleep-merge-skipped-in-dream
tasks: [T14648]
kind: fix
summary: "cleo memory dream reports sleepConsolidation.mergeSkipped, and a sleep merge inside a caller transaction never claims merges committed when its rollback fails"
---

- `cleo memory dream` and `cleo memory consolidate` output now carry
  `sleepConsolidation.mergeSkipped`: near-duplicate pairs left unmerged because
  their `supersedes` edge already exists, so pairs that stay unmerged run after
  run are visible.
- The merge's edge insert names its conflict target
  (`from_id`, `to_id`, `edge_type`), so only an existing edge for that pair
  counts as a skip.
- When the merge runs inside a caller's transaction and rolling back a failed
  pair fails, nothing has committed yet: the step throws, reports `merged: 0`
  with the error, and leaves the caller to roll its transaction back.
