---
id: t9686-de-classification
tasks: [T9686-D, T9686-E]
kind: docs
prs: [320]
summary: "Worktree prune main-dir protection + AGENTS.md release docs aligned to SPEC-T9345 4-verb pipeline."
---

Shipped on `main` via PR #320 (merge commit `a953d653d`).

Two related cleanups bundled together:

- **T9686-D** — `cleo worktree prune` now refuses to classify the primary
  worktree (the repo's main checkout) as a removable agent worktree. Earlier
  versions could classify and prune the main dir if the user ran `prune`
  from the wrong cwd.
- **T9686-E** — `AGENTS.md` "Release & Branching" section is rewritten to
  match the SPEC-T9345 4-verb pipeline (`plan` → `open` → `reconcile` /
  `rollback`). The legacy `start` / `verify` / `publish` verbs were removed
  by T9540 — the docs now reflect that.
