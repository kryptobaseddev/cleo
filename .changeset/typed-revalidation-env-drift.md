---
id: typed-revalidation-env-drift
tasks: [T14063]
kind: fix
summary: "Typed gates no longer hash PATH wholesale (the resolved executable is hashed instead); cleo complete names what changed for a result verified in its own tree, and done --plan revalidates the same way"
---

`cleo complete` refused a typed result with exit 108, "inputs changed since
verification (<tree>)", when the source was unchanged and `cleo done --plan`
had just reported the gate PASS. The gate's environment digest covered the
whole `PATH`, so any difference between the shell that verified and the shell
that completed tripped it: a mise, nvm or direnv shim, `cleo run`, or a
harness prepending its own bin. Because the result carried a tree binding,
completion then took the cross-tree carry path even in the tree that verified
it, and reported the drift as changed inputs.

- `PATH` is no longer hashed. The real path of the executable the gate's
  command resolves to on `PATH` is hashed instead. `NODE_OPTIONS`, `CI`,
  `LANG` and `LC_*` stay, because each changes what a run reports (V8 flags,
  test-runner CI behaviour, locale-dependent collation and messages). A gate
  whose result depends on the whole search path lists `PATH` in `envKeys`.
- Receipts store a digest per hashed variable, so a refusal in the tree that
  verified the result names what moved: `environment changed (LANG)`,
  `environment changed (executable ...)` or `input bytes changed (src/a.ts)`.
  The fix it gives re-records `implemented` with `--run-typed`, which re-runs
  only the typed gates and never the test suite. Results verified in another
  worktree still carry by content, as before.
- `cleo done --plan` runs completion's input revalidation. A stored pass
  that completion would refuse reads `not-run`, with completion's reason and
  the re-bind command.
- Receipts recorded before this change still complete from an unchanged
  environment: they are compared against the digest they were recorded with.
