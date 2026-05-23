---
id: t9802-paths-ssot
tasks: [T9802]
kind: feat
prs: []
summary: "Paths SSoT CI gate (lint-paths-ssot.mjs) + resolveWorktreeIndexPath helper (D009 sentinel)"
---

Phase 1 of T9802 / E-WT-PATHS-SSOT (Saga T9800 SG-WORKTREE-CANON, Council verdict D009):

**`scripts/lint-paths-ssot.mjs`** — new CI-enforced lint rule (job `paths-ssot-lint`) that
designates `packages/paths/` as the ONLY source of worktree and XDG path resolution.
Three anti-patterns are baseline-gated (fail on net-add, not net-existence):

- `direct-env-paths-import`: `import envPaths from 'env-paths'` outside `packages/paths/`
- `hand-rolled-xdg-read`: `process.env['XDG_DATA_HOME'] ?? join(...)` outside `packages/paths/`
- `hand-rolled-worktree-path`: hand-assembled `'/cleo/worktrees'` paths outside `packages/paths/`

Baseline established at 17 existing violations (all `hand-rolled-xdg-read`). CI fails on
any increase. Per-line opt-outs (`// xdg-raw-ok: <reason>`, etc.) for justified exceptions.

**`resolveWorktreeIndexPath(projectRoot)`** — new helper added to `packages/paths/src/worktree-paths.ts`
per D009 hybrid sentinel verdict. Returns `<projectRoot>/.cleo/worktrees.json` — the
canonical per-project worktree registry (FILE not directory) consumed by T9805 lifecycle
hooks. Independent of `CLEO_HOME` and XDG env vars.

**18 new tests** in `packages/paths/src/__tests__/worktree-paths-ssot.test.ts` covering:
- XDG resolution on default config
- `CLEO_HOME` override isolation (no bleed across changes)
- `resolveWorktreeIndexPath` returns the canonical sentinel path, is CLEO_HOME-independent,
  ends in `.json`, and differs per project root
- Project hash determinism (same path → same hash, different paths → different hashes)

AC3/AC4 (full migration of 17 legacy sites across cleo-os/core/adapters/cant/cleo) deferred
to T9802 Phase 2 — see AGENTS.md "Paths SSoT" section for the migration checklist.
