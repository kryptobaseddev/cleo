---
id: t14004-bound-head-implemented
tasks: [T14004]
kind: fix
summary: A test-run or qa-run that never saw the task's implemented work is refused as its evidence
---

A `test-run:`/`qa-run:` binding records the HEAD it was bound to. That HEAD
must now have seen the task's recorded `implemented` work:

- `commit:`: the run head is that commit or contains it. A run on the
  branch base, or on any older commit, is refused.
- `pr:`: the run head contains the merge commit; or it sits on the merge's
  branch side (reachable from its second parent, not its first); or it is,
  or contains, the PR's final head. `pr:` atoms now record that head
  (`headSha`), so a squash-merged PR's branch run still counts.

A run that fits none of these is refused at `cleo verify` and again at
`cleo complete`, even when complete runs from the same other checkout. The
refusal says which case applies:
- another task's work;
- this task's own rebased, amended or squash-merged history, where the fix
  is to re-record `implemented`;
- a commit git cannot read, such as in a shallow clone.

The check is skipped while no implemented commit is recorded. A `pr:` atom
recorded before this release has no `headSha`; re-record `implemented` for
a squash-merged PR.
