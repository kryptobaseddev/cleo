---
id: t12153-mergeerror-noise
tasks: [T12153]
kind: fix
summary: "cleo complete stops reporting a merge failure for tasks that never had a task branch — and orchestrate worktree-complete stops calling it a conflict"
---

Closes the remaining reproducible half of GH #1223.

`cleo complete` logged, at **WARN**, for a task where nothing failed:

```
WARN … subsystem: "tasks:complete", taskId: "T1655",
       mergeError: "task branch 'task/T1655' does not exist",
       worktreeRemoved: false
       "[T9175] worktree integration failed — branch + worktree preserved for manual recovery"
```

The reporter's tasks were worked on **feature branches merged by PR**, so no `task/<id>` branch and no agent worktree ever existed. There was nothing to integrate — a routine, correct outcome, reported as an integration failure with a manual-recovery instruction.

And this is most completions, not an edge case. **Noise at WARN is worse than silence**: it trains a reader to ignore a channel that should mean something, so the one genuine rebase conflict gets filtered out along with the hundred non-events.

## The fix: classification, not string-matching

`completeAgentWorktreeViaMerge` had only one shape for "did not merge" — `merged: false` plus an `error`. It now detects the no-work case **before** delegating to the Rust NAPI helper, when neither the branch nor the worktree exists:

```ts
const branchExists = gitSync(['branch', '--list', branch], gitRoot).trim().length > 0;
if (!branchExists && !existsSync(worktreePath)) {
  return { …, nothingToIntegrate: true, error: `no task branch '${branch}' and no worktree — nothing to integrate` };
}
```

Detected in TypeScript rather than by string-matching the NAPI's `"task branch … does not exist"`, which would couple this to a message in another language that is free to change.

`cleo complete` now logs that case at **debug**, and the WARN is reserved for `merged: false` **without** the flag — a genuine conflict or a broken repo.

## `error` is kept, and the first draft was wrong to clear it

The initial version cleared `error` on the reasoning that "nothing failed, so no error string". A consumer check caught it: `orchestrate worktree-complete` renders `integration.error ?? 'unknown merge failure'`, so dropping the string replaced an accurate message with a **misleading** one on a second surface.

So the split is explicit and tested: **`error` is a human-readable message; `nothingToIntegrate` is the machine-readable classification.** A caller must never infer failure from the mere presence of a string.

## The same defect existed on a second surface

`orchestrate worktree-complete` branched on `!integration.merged` and so returned `outcome: 'conflict'` for these tasks — with recovery steps for a merge that never needed to happen. It now routes into the **existing** `'noop'` outcome, the one already used for "already integrated", so no new vocabulary was needed.

Fixing only the logger would have left `worktree-complete` reporting a conflict for a non-event — the "fixed one of N layers" mistake this saga has repeatedly turned up.

## Verification, and a pre-existing failure that is not this change

5 new tests pass, including the dangerous inverse (a task branch that **does** exist must still take the real integration path, so a genuine failure is never suppressed) and the not-a-git-repo case (still a real error, not `nothingToIntegrate`).

`worktree-merge.test.ts` has **4 pre-existing failures** in this environment, and they are **identical with and without this change** — verified by reverting `branch-lock.ts` and re-running. Cause: no `worktree-napi` Rust `.node` binary is built in a manually-created worktree, so every NAPI merge path returns `merged: false`. Same provisioning gap as GH #1255. The new tests exercise the early return, which happens before the NAPI call, so they are valid without the binary.
