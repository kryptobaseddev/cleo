---
id: t10155-orphan-cleo-dir-check
tasks: [T10155]
kind: chore
summary: CI gate failing PRs that introduce .claude/worktrees/*/.cleo/** files (T9550/T9580 regression guard)
---

Adds scripts/lint-orphan-cleo-dir.mjs + the Orphan .cleo/ Dir Check (T10155) CI job. Scans git diff --diff-filter=A between PR base and HEAD for newly-added paths matching .claude/worktrees/<sessionId>/.cleo/**. Fails with error referencing T9550/T9580 historical incidents. Complementary to lint-project-root-anti-pattern.mjs (T9584) — that gate catches source-level anti-patterns; this catches the materialised symptom. Includes 35 unit tests (positive + negative + CLI + self-test against live repo). Saga T9862 SG-WORKTREE-CANON Wave 5.
