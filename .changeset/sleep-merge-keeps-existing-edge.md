---
id: sleep-merge-keeps-existing-edge
tasks: [T14640]
kind: fix
summary: "sleep consolidation never overwrites an existing supersedes edge, and reports committed merges when a pair's rollback fails"
---

- A near-duplicate pair whose `supersedes` edge already exists is left
  unmerged and counted in `mergeDuplicates.skipped`. The earlier edge's
  provenance, which is what reverses the earlier merge, is never overwritten.
- If rolling back a failed pair itself fails, the step discards that pair's
  writes, stops, and reports the merges already committed and both failures
  in `mergeDuplicates.error`, instead of throwing and reading as `merged: 0`.
