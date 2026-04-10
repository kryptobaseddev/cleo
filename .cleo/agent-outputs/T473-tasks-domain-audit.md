# T473 — Tasks Domain Audit

**Date**: 2026-04-10
**Domain**: tasks
**Total ops in registry**: 32
**Status**: complete

---

## Audit Summary

All 32 `tasks.*` operations verified against CLI command files.
5 missing CLIs were identified and built. 1 op classified as agent-only.

---

## Ops Coverage Matrix

| Operation | Gateway | CLI File | CLI Command | Status |
|---|---|---|---|---|
| tasks.show | query | show.ts | `cleo show <taskId>` | covered |
| tasks.list | query | list.ts | `cleo list` | covered |
| tasks.find | query | find.ts | `cleo find` | covered |
| tasks.tree | query | deps.ts | `cleo tree [rootId]` | covered |
| tasks.blockers | query | blockers.ts | `cleo blockers` | covered |
| tasks.depends | query | deps.ts | `cleo deps show/overview/impact/cycles` | covered |
| tasks.analyze | query | analyze.ts | `cleo analyze` | covered |
| tasks.impact | query | reason.ts | `cleo reason impact --change <text>` | covered |
| tasks.next | query | next.ts | `cleo next` | covered |
| tasks.plan | query | plan.ts | `cleo plan` | covered |
| tasks.relates | query | relates.ts | `cleo relates list/suggest/discover` | covered |
| tasks.complexity.estimate | query | **complexity.ts (new)** | `cleo complexity estimate <taskId>` | built |
| tasks.history | query | history.ts | `cleo history` | covered |
| tasks.current | query | current.ts | `cleo current` | covered |
| tasks.label.list | query | labels.ts | `cleo labels` | covered |
| tasks.add | mutate | add.ts | `cleo add` | covered |
| tasks.update | mutate | update.ts | `cleo update <taskId>` | covered |
| tasks.complete | mutate | complete.ts | `cleo complete <taskId>` | covered |
| tasks.cancel | mutate | **cancel.ts (new)** | `cleo cancel <taskId>` | built |
| tasks.delete | mutate | delete.ts | `cleo delete <taskId>` | covered |
| tasks.archive | mutate | archive.ts | `cleo archive` | covered |
| tasks.restore | mutate | restore.ts | `cleo restore task <taskId>` | covered |
| tasks.reparent | mutate | reparent.ts | `cleo reparent <taskId>` | covered |
| tasks.reorder | mutate | reorder.ts | `cleo reorder <taskId>` | covered |
| tasks.relates.add | mutate | relates.ts | `cleo relates add <from> <to> <type> <reason>` | covered |
| tasks.start | mutate | start.ts | `cleo start <taskId>` | covered |
| tasks.stop | mutate | stop.ts | `cleo stop` | covered |
| tasks.sync.reconcile | mutate | — | agent-only | agent-only |
| tasks.sync.links | query | **sync.ts (new)** | `cleo sync links list` | built |
| tasks.sync.links.remove | mutate | **sync.ts (new)** | `cleo sync links remove <providerId>` | built |
| tasks.claim | mutate | **claim.ts (new)** | `cleo claim <taskId> --agent <agentId>` | built |
| tasks.unclaim | mutate | **claim.ts (new)** | `cleo unclaim <taskId>` | built |

---

## New CLI Files Built

### `packages/cleo/src/cli/commands/cancel.ts`
- Registers `cleo cancel <taskId> [--reason <reason>]`
- Dispatches to `mutate / tasks / cancel`
- Soft terminal state — reversible via `cleo restore task <taskId>`

### `packages/cleo/src/cli/commands/claim.ts`
- Registers `cleo claim <taskId> --agent <agentId>`
- Registers `cleo unclaim <taskId>`
- Dispatches to `mutate / tasks / claim` and `mutate / tasks / unclaim`
- Both commands require an active session (enforced by dispatcher middleware)

### `packages/cleo/src/cli/commands/complexity.ts`
- Registers `cleo complexity estimate <taskId>`
- Dispatches to `query / tasks / complexity.estimate`

### `packages/cleo/src/cli/commands/sync.ts`
- Registers `cleo sync links list [--provider <id>] [--task <taskId>]`
- Registers `cleo sync links remove <providerId>`
- Dispatches to `query / tasks / sync.links` and `mutate / tasks / sync.links.remove`
- `tasks.sync.reconcile` intentionally excluded (see agent-only classification below)

---

## Agent-Only Classification

### `tasks.sync.reconcile` — agent-only

**Rationale**: This op requires `externalTasks` as a structured `ExternalTask[]` array.
Shell arguments cannot represent this payload in a safe, ergonomic way. This op is
invoked exclusively by integration agents or scripts that already have the data in
memory from an external provider API. Adding a CLI surface would require JSON-file
indirection that provides no real value and could confuse users.

**Documented in**: sync.ts file header comment.

---

## index.ts Wiring

Added to `packages/cleo/src/cli/index.ts`:
- Imports: `registerCancelCommand`, `registerClaimCommand`, `registerUnclaimCommand`, `registerComplexityCommand`, `registerSyncCommand`
- Registrations: all five functions called on `rootShim` in the task-management command block

---

## Quality Gates

- `pnpm biome check --write`: passed (3 files auto-fixed, 0 errors)
- `pnpm run build`: passed (`Build complete.`)
- `pnpm run test`: 7016 passed, 1 pre-existing flaky performance timing failure in `performance-safety.test.ts` (unrelated to this task — triggered by slow CI machine, 16.3s vs 10s cap)
