---
id: merged-gate-checkout-deps
tasks: [T14625]
kind: fix
summary: "the merge-commit gate checkout command installs dependencies like a provisioned worktree, so workspace packages resolve their own deps"
---

`mergedGateVerifyCommand` linked only the source checkout's root
`node_modules` into the temp checkout at the merge commit. In a pnpm
workspace each package keeps its own `node_modules`, so those were missing
and typed gates failed in project setup (ERR_MODULE_NOT_FOUND) before any test
ran. When the merge tracks `pnpm-lock.yaml`, the printed command now runs the
worktree provisioning install recipe (`workerInstallCommand`: frozen lockfile,
the checkout's own store, through the heavy queue) inside the checkout. The
install writes only untracked paths, so the checkout stays clean and equal to
the merge tree and `cleo done --from-merge` accepts the pass. Without a
pnpm lockfile (npm, Yarn, Bun) the root `node_modules` is linked as before.
`workerInstallCommand` moves to `@cleocode/worktree/worktree-pnpm.js` and is
exported from the package root.
