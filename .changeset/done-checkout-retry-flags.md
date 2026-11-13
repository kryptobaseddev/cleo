---
id: done-checkout-retry-flags
tasks: [T14527]
kind: fix
summary: "Preserve caller flags in done checkout and worktree remedies"
---

Branch, commit, PR and worktree remedies retain the caller's `--run-typed`
and `--satisfies` flags so retrying keeps typed gates and criterion claims.
