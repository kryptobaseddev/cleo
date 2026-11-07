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
census holds its lock. The child is bounded: no stdin, output to
`census.log`, background CPU and I/O priority where the platform has it
(`taskpolicy -b`, `ionice -c 3`, nice 19), a 3-minute wall-clock budget past
which it writes a record marked `partial` and exits, and a hard exit a minute
later. Sizes are summed with `lstat` only, never following symlinks, and the
lock is released on every exit path. `cleo briefing` shows one line when the last census
kept worktrees.
