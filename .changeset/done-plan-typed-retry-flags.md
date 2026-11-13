---
id: done-plan-typed-retry-flags
tasks: [T14529]
kind: fix
summary: "Done-plan typed-gate fallback remedies preserve caller --pr and --satisfies"
---

The retry after an unrun typed gate now uses the same command as checkout
remedies, retaining an explicit PR and the selected acceptance criteria,
including multi-alias lists. Automatic PR discovery stays automatic.
