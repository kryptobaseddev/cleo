---
id: done-plan-evidence-planner
tasks: [T12623, T12624]
kind: feat
summary: "`cleo done <id> --plan` prints the evidence plan for a task (change set, gates, tool runs, AC mapping, ordered blockers, runnable commands) and writes nothing"
---
First step of the streamlined verification flow (spec `verify-streamlined-design`,
decisions D11148–D11151). `cleo done <id>` without `--plan` still completes the
task exactly as before; it now delegates to `complete` explicitly instead of being
a registered alias.

- **Change-set derivation** (`deriveTaskChangeSet`, core). Finds a task's work,
  first match wins: a merged PR that cites the task (a PR from `task/<id>` wins
  over one that only mentions the id; declared `task.files` narrow the rest; two
  or more left is a blocker listing them), then the unmerged task branch diffed
  against its merge-base with `origin/<default>`, then attached docs and linked
  decisions for research, spike and documentation tasks. PR files are read from
  the merge commit; deleted paths are reported and never enter `files:`. All git
  and gh calls run in one root: declared `evidence.gitRoot`, then the invoking
  worktree, then the task's registered worktree, then the store root.
- **Planner** (`deriveTaskEvidence`, core; `DonePlan` in contracts). Lists the
  required gates, the tool runs with their ADR-061 cache state (read, never run),
  stored typed-gate results, and an AC mapping that links a criterion only when a
  typed gate for it passed or every repo path it names is in the diff. Every other
  criterion goes to `needsSatisfies`; `--satisfies AC1,AC3|all` answers it once.
  Commands are spelled as today's `cleo verify` / `cleo complete`, so each one runs
  now. `--field /data/commands` extracts them.
- The planned atoms go to the existing `parseEvidence` / `validateAtom` /
  `checkTaskEvidenceContext` path; there is no second validator.
  `resolvePrEvidenceAtom` gains `readOnly`, which skips the PR and
  branch-protection cache writes.
- A research task with docs but no linked decision is reported as
  `decision-missing`: `implemented` has no files+note alternative without a commit.
