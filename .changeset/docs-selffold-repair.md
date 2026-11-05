---
id: docs-selffold-repair
tasks: [T14233, T14108]
kind: fix
summary: "docs moved by T14108 groups 1, 3 and 4 no longer carry stale self-folded sections"
---

`cleo docs modernize` folded an older stored version of 16 moved docs into
their new files: the stale version became the body and the current text was
appended under a "merged from `<own slug>`" section. Each file is rebuilt
from its pre-move source with links re-pointed to the final paths and the
intended merge folds kept, and the docs store head of each slug (plus the
north star, stdp-wire-up and the tasks API spec, whose folds are store-only)
is updated to match, so no head carries a self-fold.
