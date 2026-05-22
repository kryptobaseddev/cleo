---
"@cleocode/cleo": patch
---

test(T10018): unit tests for crates/worktree-napi adapter layer

Adds 5 unit tests covering: read_worktree_include (missing file, negation parsing),
list_worktrees (main worktree present), destroy_worktree (error on missing path),
copy_paths_parallel (empty input). Closes the T-D11 testing gap from PR #485.

Saga: T9977
Closes: T10018
