# Common Failures

The most frequent worker-agent failure modes observed across CLEO
sessions. Each entry includes a recognition signal, the root cause, and
the corrected approach. Many of these are recorded in BRAIN observations
under `O-*` IDs.

## False Success Reports

**Symptom.** Worker returns "Task complete. All tests pass." The
orchestrator later finds (via `cleo show <id>` showing pending gates,
or `git log` showing no commits, or `pnpm test` showing failures) that
the work was not actually done.

**Recognition.** Reported success without (a) a commit SHA in the
response, (b) the test output excerpt, or (c) a `cleo verify` audit
trail.

**Root cause.** The worker conflated "I drafted code that should work"
with "I ran the tests and they passed." Often correlates with model
fatigue at >70% context utilization.

**Fix.** The worker MUST run the full quality-gate sequence (biome →
build → typecheck → test) and capture the exit codes / output before
reporting completion. The spawn prompt's tier-1+ injection contains this
ritual — re-read it if uncertain.

This failure mode was first formally documented in T1450 PROOF
(`spawn-capability-gap-2026-04-25.md` — historical context, the
underlying gap is now resolved but the pattern recurs at the worker
level).

## Outside-Worktree Edits

**Symptom.** Worker edits files outside its assigned worktree path. The
git shim usually blocks this, but if it slips through, the change does
not get into the PR.

**Recognition.** Files appear modified in `/mnt/projects/cleocode/` but
not in the worktree's branch.

**Root cause.** Worker resolved a relative path against the wrong cwd
(persistent shell state was not reset between tool calls), or
deliberately followed an absolute path from a prior session's notes.

**Fix.** The spawn prompt's `FIRST ACTION: cd <path>` MUST be the first
command. All subsequent paths SHOULD be absolute within the worktree.
If unsure, prefix with `git rev-parse --show-toplevel` first.

## Cherry-Pick Instead of Merge

**Symptom.** When integrating completed work to main, the worker (or
overzealous orchestrator) used `git cherry-pick` instead of
`git merge --no-ff`.

**Recognition.** `git log --grep "<task-id>"` shows different SHAs in
the task branch vs main. The author email is lost. `cleo find` cannot
relate commits to the task.

**Root cause.** Following a generalized "cherry-pick is safer" instinct
without reading ADR-062. The CLEO contract is that workers commit on
their task branch; the integrator MUST use `git merge --no-ff
task/<id>` to preserve SHAs, author identity, and the
`cleo find <task-id> --commits` trace.

**Fix.** Always `git merge --no-ff task/<TID>` for integration. See
`feedback_cherry_pick_worktrees.md` for the full pattern.

## Hard Reset Disasters

**Symptom.** Multiple worktree-spawn agents working in parallel suddenly
find their work has vanished from main. The orchestrator's primary
working dir's branch is on main; an agent or the orchestrator ran
`git reset --hard origin/main`, wiping local commits that had not yet
been pushed.

**Recognition.** `git reflog` on the primary working dir shows a
recent `HEAD@{N}: reset: moving to origin/main`.

**Root cause.** The primary working dir's branch is shared across
parallel orchestrators. A reset there wipes shared state. Caught in
T9354 session and recovered via reflog cherry-pick — at the cost of 3
PRs.

**Fix.** NEVER `git reset --hard` on the orchestrator's primary working
dir while any worker agents are alive. Apply fixes from inside the
worker's worktree path, or use `git update-ref` + push to land
corrections without resetting the local branch.

## ESM Import Path Drift

**Symptom.** Build fails locally with `ERR_MODULE_NOT_FOUND` or CI fails
with `Cannot find module './foo'` even though the file exists.

**Recognition.** Import line `import { foo } from "./foo";` (no
`.js` extension).

**Root cause.** The repo's TypeScript config uses pure ESM with explicit
`.js` extensions on imports. Stripping the extension works at write
time but fails at runtime under Node's strict ESM resolver.

**Fix.** Always include `.js` in relative imports — even for `.ts`
sources. The compiled output uses the same extension. Workspace imports
(`@cleocode/...`) do not need the extension.

## Cross-Package Reach

**Symptom.** Worker imports across package boundaries without declaring
the dependency in the consumer's `package.json`. Build succeeds locally
(pnpm hoists) but CI fails on a clean install.

**Recognition.** Import like `import { thing } from "../../core/src/foo.js"`
inside `packages/cleo/`.

**Root cause.** Took a relative-path shortcut instead of using the
workspace import `@cleocode/core`. Also bypasses the type contract.

**Fix.** Add the consumer's `package.json` dependency and use the
workspace import:

```typescript
import { thing } from "@cleocode/core/foo";
```

If the function being imported is not exported from the consumer
package, add an export — do not reach through internals.

## Type Cast Chains

**Symptom.** Code contains `as unknown as SomeType`, `any` types, or
empty `catch (err: unknown)` blocks. AGENTS.md type-safety rules ban
all three.

**Recognition.** `pnpm biome check` warnings on `any` / `unknown` usage,
or grep for `as unknown as`.

**Root cause.** Worker hit a type mismatch and reached for the escape
hatch instead of fixing the underlying contract.

**Fix.** Inspect the actual types; update or extend the contract in
`packages/contracts/src/` if necessary. The repo's policy is "find the
root cause" — type casts hide the cause and accumulate as debt.

## Drive-By Refactors

**Symptom.** PR for T9660 includes unrelated changes to files outside
the task's scope. Reviewer comments "scope creep" and requests a split.

**Recognition.** `git diff --stat HEAD` shows files modified that do
not appear in the task's acceptance criteria.

**Root cause.** Worker noticed something to improve while reading
adjacent code and "fixed it in passing".

**Fix.** Revert unrelated changes; file a new task for them. One task =
one purpose = one PR. The CLEO contract relies on this for traceability.

## Stale Cache Confusion

**Symptom.** `cleo complete` fails with `E_EVIDENCE_STALE` even though
the worker is sure they didn't touch the file after verify.

**Recognition.** Error message references a file the worker only read,
never edited.

**Root cause.** A formatter (biome auto-fix on save, or a sibling
agent's commit) modified the file between `cleo verify` and
`cleo complete`. The sha256 no longer matches.

**Fix.** Re-run `cleo verify` for the affected gate(s) before
`cleo complete`. Treat verify+complete as an atomic pair — minimize the
time between them.

## Forgotten Memory Observation

**Symptom.** Task completed; the session ends; the next session
re-discovers a fact that should have been retained.

**Recognition.** `cleo memory find <topic>` after the task returns
nothing, even though the worker learned something non-trivial.

**Root cause.** Worker skipped the post-complete `cleo memory observe`
step (CLEO-INJECTION.md trigger row 2: "after non-trivial task
completion").

**Fix.** After every non-trivial `cleo complete`, run:

```bash
cleo memory observe "<one-paragraph learning>" --title "<short title>"
```

Trivial tasks (typo fix, version bump) do not need observations.
Anything that changed your mental model does.
