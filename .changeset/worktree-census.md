---
id: worktree-census
tasks: [T14275]
kind: feat
summary: "cleo hygiene census: a machine-wide worktree census by the disposal proof, report-only by default, run lazily at most daily"
---

Every cleanup path resolved one project's worktree hash directory, so worktrees
of projects never run from their root were never swept, and the CI cleanup
workflow ran where no worktree exists. `cleo hygiene census` walks every hash
directory under the machine's worktree root:

- a directory a registered project owns is classified by that project's
  worktree listing (`active`, `redundant`, `keep` with its reason, `unknown`);
- a directory no registered project owns, or one git does not list, is
  `unknown`, report only.

`--report` (the default) lists every worktree by project with its category,
apparent bytes and keep reason. `--apply` also removes this project's
proven-redundant worktrees, each re-proved with its task's evidence; other
projects stay report-only. Every run writes a census record (counts, apparent
bytes, bytes reclaimed, the free-space delta, every kept worktree with its
reason) under `<cleoHome>/hygiene/census/`.

`briefing`, `next`, `current` and `show` start a report-only census in a
detached child at most once per 24 h per machine: never in CI, under vitest,
in a process git started, from a CLI built in a worktree, or while another
census holds its lock. `cleo briefing` shows one line when the last census
kept worktrees.
