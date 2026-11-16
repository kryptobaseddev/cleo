---
id: merge-tree-gate-cache
tasks: [T14596]
kind: fix
summary: "Merge sweeps reuse authenticated typed-gate passes against the merge tree across checkouts"
---

The merge sweep compares typed-gate inputs with the merge commit instead of the
current checkout. A pass is portable only from a clean checkout with the same
complete git tree as the merge; matching test files alone never attest changed
source. Cache authentication binds task, merge, clean state and tree hash, and
carried results retain the actual verified commit.

Waiting outcomes give the full command to create a temporary detached checkout
and cache an accepted pass without detaching the primary checkout. Literal
bracket test paths are captured as files while glob filters remain arguments.
Older cache proofs and stored passes missing a tree hash or newly captured test inputs require
explicit re-verification; the refusal explains that migration and its command.
