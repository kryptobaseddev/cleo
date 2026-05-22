---
id: t9804-claude-isolation-bridge
tasks: [T9804]
kind: feat
prs: []
summary: "cleo worktree adopt + multi-source list (Claude Code Agent isolation bridge)"
---

feat(T9804): cleo worktree adopt + multi-source list (Claude Code Agent isolation bridge)

Implements Option B (Adopt) for bridging Claude Code Agent `isolation:worktree`
dispatches into the CLEO worktree SSoT (Saga T9800, council D009).

**Changes:**

- `packages/contracts`: adds `WorktreeSource` union type (`cleo-spawn | claude-agent | manual | adopted`), adds `source` field to `WorktreeInfo`, adds `WorktreeLifecycleAction` member `adopt`, exports `AdoptWorktreeOpts` + `AdoptWorktreeResult`.
- `packages/core/src/worktree/sentinel-index.ts` (new): in-project sentinel index at `.cleo/worktrees.json` — `readSentinelIndex`, `writeSentinelIndex`, `upsertSentinelEntry`, `resolveWorktreeIndexPath`. Local T9804 implementation; superseded by T9802 once paths SSoT ships.
- `packages/core/src/worktree/worktree-adopt.ts` (new): `adoptWorktree()` — validates path, extracts branch from `.git` gitlink, upserts sentinel index, appends audit log.
- `packages/core/src/worktree/list.ts`: enhanced to union `git worktree list --porcelain` output with sentinel index entries. Git-native entries get `source` from sentinel lookup (or `cleo-spawn` default). Sentinel-only entries are appended as additional `WorktreeInfo` rows.
- `packages/cleo`: `cleo worktree adopt <path>` subcommand; `WorktreeHandler.mutate('adopt', ...)` dispatch case.
- `AGENTS.md`: new "Worktree Subsystem" section documenting the bridge pattern and `cleo worktree adopt` usage contract.

**ACs covered:** AC1 (list union), AC2 (bridge shipped with TSDoc), AC3 (lifecycle cleanup via existing prune hooks). AC4/AC5 deferred to T9808.
