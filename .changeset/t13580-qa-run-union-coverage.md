---
id: t13580-qa-run-union-coverage
tasks: [T13580]
kind: feat
summary: "qa-run receipts of the same kind cover a change together: two lint receipts over different roots can satisfy the lint half of qaPassed"
---

Each `qa-run:` receipt had to cover every changed path and dependent package on its own, so a project that lints in two runs over different roots could not use both receipts. Each receipt is still validated alone, fresh and passing, but it now records the changed paths and dependent packages its roots leave uncovered (`uncovered`, `uncoveredPackages`). When qaPassed is written, receipts of one kind count together: a path or package is a gap only when every receipt of that kind leaves it uncovered, and the gate is refused naming it, e.g. `qa-run lint receipts (roots src/a, src/c) together do not cover the changed path(s) src/b/y.ts`. A check also recorded as a `tool:` run needs no receipt coverage, and receipts recorded before this change are treated as covering everything, as they were checked then.
