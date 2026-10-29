# PR cadence: small PRs per task group, traceable to release

Owner decision D11212. Task T14143 (epic T14099). This builds on ADR-099
(lean lifecycle: a merged PR closes its tasks, and a release is one command).

## Goal

Every change is tracked, managed and audited from task to PR to release.
That happens through many small PRs, each tied to a specific task group, and
a release cadence that ships them without ceremony.

## Requirements

### Rule

1. **One PR per task group.** A PR delivers one task, or a few tasks that
   cannot land separately: they change the same code and fail without each
   other. Unrelated tasks never share a PR, even when that would save a CI
   run.
2. **Small.** A reviewer reads the whole PR in one sitting. When a task's
   change is large, split it into PRs that each leave `main` green. Each of
   those PRs binds the criteria it delivers with `Refs:`, and the last one
   binds the rest with `Closes:`.
3. **Every PR names its tasks.** The PR body carries one line per task:
   ```
   Closes: T#### AC1,AC2   completes the task once merged PRs cover every criterion
   Refs: T#### AC3         partial delivery; the task stays open
   ```
   A change that no task owns gets the `no-task` label instead. That is
   rare: file the task first.
4. **Every PR with user-facing change carries a changeset** whose `tasks:`
   field names the same tasks. The release notes are built from changesets.
5. **Commits name a task.** The commit-msg hook refuses a subject without a
   task id.

### Traceability chain

| Step | Record | Written by |
|---|---|---|
| Task and its acceptance criteria | task store | `cleo add` |
| Commits | `T####` in the subject | author; commit-msg hook enforces |
| PR | `Closes:`/`Refs:` lines, changeset `tasks:` | author; PR task-line check flags gaps |
| Review | one verdict per criterion on the PR head | non-author reviewer, `cleo review verdict` |
| Merge | `pr:`, `ci:` and `satisfies:` evidence, task closed, `merge_close` audit row | merge sweep (`cleo done --from-merge`) |
| Release | tag on the green commit; notes from the changesets in range; task report | `cleo release cut` |
| Provenance | release ↔ commits ↔ tasks tables | merge sweep (`reconcileLatestRelease`) |

Given a task, the chain answers which PRs delivered it, who reviewed each
criterion, which CI run proved it and which release shipped it. Given a
release, it answers the reverse.

### Batching

- PRs merge one at a time, each on its own green `CI` (branch protection
  `strict: false`). Main-push CI catches a break that only appears when PRs
  combine, and a red main pauses merging.
- Batching happens at release time, not in PRs. Every PR merged since the
  last tag ships in the next cut.
- Docs move with the code that needs them, in the same PR (gate 32 holds
  skills to this).
- A lane keeps at most two PRs open, so review keeps pace with authoring.

### Release cadence

- `cleo release cut <version>` tags the newest commit on `main` whose `CI` is
  green, from one command (ADR-099). No plan file and no release PR are
  involved.
- **Cut when a coherent set of merged work is ready.** During active epics
  that is about daily (CalVer `vYYYY.MM.N`). Cut a hotfix as soon as its fix
  merges. Opt-in features ship first on the `-canary.N` channel.
- Task status is reported in the cut, never gated. An open task in range
  ships its merged parts, and its remaining criteria wait for later PRs.

### Mechanical checks

| Check | Where | What it catches |
|---|---|---|
| Commit names a task | commit-msg hook | commits with no task id |
| PR names its tasks | `PR Task Lines` workflow (`scripts/lint-pr-task-lines.mjs`) | a PR body with no or malformed `Closes:`/`Refs:` lines; release branches, bots and the `no-task` label are exempt |
| Changeset shape | `Changeset Lint` in CI | a changeset without `tasks:` |
| Merge receipt | `Merge Close` workflow | a merged PR that closes nothing, and why |
| Release range | `cleo release cut` | a changeset in range that did not arrive through a merged PR (`E_RELEASE_UNMERGED_CHANGESET`) |

The PR task-line check flags rather than gates. It re-runs when the PR body
is edited, which does not re-run `CI`. A PR whose lines are wrong closes
nothing when it merges, so the merge-close receipt surfaces the gap again.
Making the check a required context is a one-line branch-protection change
if flagging proves too weak.

## Non-Goals

- A hard size limit in lines. "One sitting" is a reviewer's judgement, and
  generated or lock files distort counts.
- Gating merges on the PR task-line check. It flags; the merge-close receipt
  and the task's own criteria still decide what closes.

## Out-of-Scope

- How the merge sweep binds and closes tasks (ADR-099, T14101).
- Per-criterion review mechanics (T14122).
- Release mechanics (`cleo release cut`, T14102).
