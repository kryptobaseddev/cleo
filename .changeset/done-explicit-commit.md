---
id: done-explicit-commit
tasks: [T13799]
kind: feat
summary: "cleo done <id> --commit <sha> closes work that landed on main with no citing PR or branch; a REQ-only task closes through cleo done"
---

Work that landed on the default branch with no PR or branch citing the task
had no change set, so `cleo done` refused with `no-change-set`.

`cleo done <id> --commit <sha>` names that commit. It is verified, never
trusted:
- it must exist and have a parent;
- it must have landed on origin's default branch;
- its own first-parent diff becomes the change set, so naming an unrelated
  commit cannot dodge the change set;
- the checked-out tree must contain it before tools run;
- `--pr` and `--commit` are exclusive.

A task whose acceptance holds only REQ typed gates but has no criterion rows
(an older store, OCG T091) now gets its rows on `cleo done`, built exactly as
`cleo add` builds them. A task with any rows is left alone. With `--run-typed`,
the gate runs once, its result is recorded, and it links to its criterion.
When every criterion is a typed gate, those criteria also link to the
implemented and qaPassed evidence, so no manual `--satisfies` is needed.
