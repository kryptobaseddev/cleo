---
id: t9686-a-dispatch-envelope
tasks: [T9686-A]
kind: fix
prs: [324]
summary: "Four dispatch/envelope bugs in the release pipeline — worktree help text, pr-status routing, reconcile double-wrap, changelog envelope."
---

Shipped on `main` via PR #324 (merge commit `dd241ea39`).

Four narrowly-scoped fixes that together un-jam the SPEC-T9345 release
pipeline:

- `release.pr-status` was missing from the dispatch registry — now wired into
  both `dispatch.ts` and the handler set.
- `release reconcile` was double-wrapping its `EngineResult` — unwrapped to
  emit a clean envelope.
- `release changelog` emitted a raw error instead of a LAFS envelope when the
  requested tag was missing.
- The worktree parent help text was appending after the subcommand output —
  fixed so subcommand output stands alone.
