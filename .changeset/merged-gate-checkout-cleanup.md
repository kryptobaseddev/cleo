---
id: merged-gate-checkout-cleanup
tasks: [T14628]
kind: fix
summary: "The merge-commit gate checkout command removes its temporary worktree after the gate run"
---

The command CLEO prints to cache a typed-gate pass in a fresh checkout of the
merge now removes that checkout with `git worktree remove` (never `--force`)
once the gate run ends, whether it passed or failed. It first deletes the
install artefacts it made (`.pnpm-store`, `node_modules` and the root
`node_modules` link) when the project does not ignore them, and only those.
When git still refuses, because the checkout holds a tracked change or other
untracked content, the checkout is kept and its path printed. An interrupt or
termination mid-gate removes it the same way and exits 130 or 143. Otherwise
the command exits with the gate run's own status (75 stays 75). The recorded
pass stays valid because it binds to the merge tree, not the path.
