---
id: epic-rollup-agrees
tasks: [T14073]
kind: fix
summary: "An epic's done children cover its Complete-child criteria, and done --plan names what cleo complete still needs"
---

`cleo done --plan` and `cleo verify --auto` told an epic to "complete through
its children" with `cleo complete`, which then refused it for having no
evidence on every "Complete child …" criterion. A parent's `child_task`
projection is now covered by the child itself once that direct child is done,
which is the rollup an epic completes through; the epic's own criteria still
need evidence. The epic plan now gives the same verdict as completion: it names
an unfinished child (`cleo show <child>`), or each criterion with no evidence
and the `cleo verify … satisfies:<epic>#ACk` write that binds it, and says
`cleo complete` only when completion accepts the epic.

Also fixed: a declared directory in task `files` whose path has a dot before
its last segment (`.cleo/rcasd/T1/`) was not treated as a directory, so a
commit touching a file under it failed the implemented-gate intersection.
