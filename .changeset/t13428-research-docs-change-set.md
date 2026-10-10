---
id: t13428-research-docs-change-set
tasks: [T13428]
kind: fix
summary: a research or spike task's done --plan is judged on its review doc and decision, never on a merged code PR that cites it, and a docs change set never plans a whole suite or typecheck
---

A research task cited by an author's merged code PR had its change set taken
from that PR, because merged PRs were tried first. `cleo done --plan` then
planned `tool:test`, `tool:lint` and `tool:typecheck` for a task that changed
no code.

- For a research or spike task, the attached review documents and linked
  decisions are tried first. An explicit `--pr` still wins, and a research
  task with no document or decision falls back to the PR and branch, as before.
- A docs change set plans no tool runs, whether or not its decision is
  recorded yet. Until the decision exists, the plan shows only the
  `decision-missing` blocker.

Work tasks keep their PR-derived change sets.
