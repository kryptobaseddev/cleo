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
  `node_modules` does; or a package's `dist/` was built from other source
  than its tracked `src/` holds now (`W_WORKSPACE_STALE_DIST`). The root
  build stamps each package's `dist/.source-stamp.json` with a content hash
  of its source; mtimes are not compared, since a checkout rewrites them
  without changing content. A dist with no stamp, or rebuilt after it, is
  not reported. T14123 turns a mismatch into a refusal.
