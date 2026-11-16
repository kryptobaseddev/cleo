---
id: merge-tree-gate-cache
tasks: [T14596]
kind: fix
summary: "Merge sweeps reuse authenticated typed-gate passes against the merge tree across checkouts"
---

The merge sweep compares typed-gate inputs with the merge commit instead of the
current checkout. A pass from another checkout or a commit with identical gate
inputs is accepted after main advances; changed inputs and tampered cache entries
remain refused. Waiting outcomes name the command that caches an accepted pass
on the merge tree. Ordinary cache lookups retain their exact tree requirements.
