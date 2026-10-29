---
id: workspace-foreign-checkout
tasks: [T14097]
kind: fix
summary: "test runs and test-run receipts refuse a checkout whose workspace packages resolve into another checkout with different source; a stale dist only warns"
---

A worktree whose `node_modules` points at another checkout loads that
checkout's builds, so its tests can exercise code that is not the tree under
test. `cleo run --class test`, `tool:test`, `tool:test-affected` and
`test-run:` receipts now check how each workspace dependency resolves.

- **Refused** (`E_WORKSPACE_FOREIGN_CHECKOUT`): the dependency resolves into
  another checkout whose committed source for that package differs, or either
  side has uncommitted changes. The refusal names the dependency, both paths,
  and the remedy: a real `pnpm install --frozen-lockfile` and a build of what
  the tests import.
- **Warned**: the dependency resolves into another checkout with identical,
  clean source, as a provisioned worktree that shares the root checkout's
  `node_modules` does (`W_WORKSPACE_BORROWED_BUILD`). A dist built from
  other source than its package holds is refused (T14123, see
  `stale-dist-refusal`).
