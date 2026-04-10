# Pipeline Domain Audit — T477

**Date**: 2026-04-10
**Agent**: Pipeline Domain Lead (T477)
**Scope**: All 32 pipeline.* operations (query + mutate)

---

## Domain Overview

The `pipeline` domain is registered in `packages/cleo/src/dispatch/domains/pipeline.ts` (class `PipelineHandler`) and covers 5 sub-domains: `stage.*`, `phase.*`, `manifest.*`, `release.*`, `chain.*`.

CLI surface is spread across 5 command files:
- `packages/cleo/src/cli/commands/lifecycle.ts` — stage.* ops
- `packages/cleo/src/cli/commands/phase.ts` — phase.* ops
- `packages/cleo/src/cli/commands/phases.ts` — phase.list/show aliases
- `packages/cleo/src/cli/commands/release.ts` — release.* ops
- `packages/cleo/src/cli/commands/research.ts` — manifest.* ops

---

## Full Op Inventory (32 ops)

### stage.* — 9 ops

| Operation | Gateway | CLI Before | CLI After | Notes |
|-----------|---------|-----------|-----------|-------|
| stage.validate | query | `lifecycle gate <id> <stage>` | unchanged | exits 80 if canProgress=false |
| stage.status | query | `lifecycle show <epicId>` | unchanged | |
| stage.history | query | **missing** | `lifecycle history <taskId>` | ADDED |
| stage.guidance | query | `lifecycle guidance [stage]` | unchanged | |
| stage.record | mutate | `lifecycle start/complete <id> <stage>` | unchanged | |
| stage.skip | mutate | `lifecycle skip <id> <stage> --reason` | unchanged | |
| stage.reset | mutate | **missing** | `lifecycle reset <id> <stage> --reason` | ADDED |
| stage.gate.pass | mutate | **missing** | `lifecycle gate-record pass <id> <gate>` | ADDED |
| stage.gate.fail | mutate | **missing** | `lifecycle gate-record fail <id> <gate>` | ADDED |

### phase.* — 8 ops

| Operation | Gateway | CLI | Notes |
|-----------|---------|-----|-------|
| phase.show | query | `phase show [slug]` / `phases show <phase>` | already covered |
| phase.list | query | `phase list` / `phases list` / `phases stats` | already covered |
| phase.set | mutate | `phase set/start/complete <slug>` | already covered |
| phase.advance | mutate | `phase advance` | already covered |
| phase.rename | mutate | `phase rename <old> <new>` | already covered |
| phase.delete | mutate | `phase delete <slug>` | already covered |

### manifest.* — 6 ops

| Operation | Gateway | CLI | Notes |
|-----------|---------|-----|-------|
| manifest.show | query | `research show <id>` | already covered |
| manifest.list | query | `research list` / `research pending` / `research manifest` | already covered |
| manifest.find | query | `research links <taskId>` | already covered |
| manifest.stats | query | `research stats` | already covered |
| manifest.append | mutate | `research add` / `research link` / `research update` | already covered |
| manifest.archive | mutate | `research archive` | already covered |

### release.* — 6 ops

| Operation | Gateway | CLI Before | CLI After | Notes |
|-----------|---------|-----------|-----------|-------|
| release.list | query | `release list` | unchanged | |
| release.show | query | `release show <version>` | unchanged | |
| release.channel.show | query | **missing** | `release channel` | ADDED |
| release.ship | mutate | `release ship <version> --epic <id>` | unchanged | |
| release.cancel | mutate | `release cancel <version>` | unchanged | |
| release.rollback | mutate | **missing** | `release rollback <version>` | ADDED |

### chain.* — 5 ops (WarpChain — agent-only)

| Operation | Gateway | Classification | Rationale |
|-----------|---------|---------------|-----------|
| chain.show | query | **agent-only** | Tier-2 orchestrator feature; WarpChain definitions are used by orchestrators dispatching multi-stage pipelines, not by CLI users directly |
| chain.list | query | **agent-only** | Same rationale; no ergonomic CLI use case |
| chain.add | mutate | **agent-only** | Chain definitions are stored by orchestrators via dispatch, not by CLI users |
| chain.instantiate | mutate | **agent-only** | Instantiating a chain for an epic is an orchestrator action |
| chain.advance | mutate | **agent-only** | Advancing a chain instance is an internal orchestrator operation |

---

## Changes Made

### `lifecycle.ts` — 4 new subcommands

1. **`lifecycle history <taskId>`** — dispatches `pipeline.stage.history { taskId }`
2. **`lifecycle reset <epicId> <stage> --reason`** — dispatches `pipeline.stage.reset { taskId, stage, reason }`
3. **`lifecycle gate-record pass <epicId> <gateName>`** — dispatches `pipeline.stage.gate.pass { taskId, gateName, agent?, notes? }`
4. **`lifecycle gate-record fail <epicId> <gateName>`** — dispatches `pipeline.stage.gate.fail { taskId, gateName, reason? }`

Gate pass/fail are grouped under `lifecycle gate-record` as a parent command to avoid name collision with the existing `lifecycle gate` (which does stage.validate).

### `release.ts` — 2 new subcommands

1. **`release rollback <version>`** — dispatches `pipeline.release.rollback { version, reason? }`
2. **`release channel`** — dispatches `pipeline.release.channel.show {}`

---

## Quality Gates

- `pnpm biome check --write` on modified files: **passed** (no fixes needed)
- `tsc --noEmit` on `packages/cleo`: **no new errors in modified files**
- Pre-existing build failures in `@cleocode/cant` and `@cleocode/caamp` (missing @types/node, no .d.ts) are unrelated to this task

---

## Summary

- 32/32 ops audited
- 27 ops already had CLI coverage
- 6 ops added to CLI (stage.history, stage.reset, stage.gate.pass, stage.gate.fail, release.channel.show, release.rollback)
- 5 ops classified agent-only (chain.show, chain.list, chain.add, chain.instantiate, chain.advance — WarpChain tier-2 orchestrator features)
