# CLI System Audit Report

**Date**: 2026-04-10
**Scope**: Full CLI dispatch integrity audit
**Status**: Phase 0 + Phase 1 FIXED, Phase 2-4 pending

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Registry operations | **231** (constitution says 209 — drift of +22) |
| Canonical domains | **11** (constitution says 10 — `conduit` undocumented) |
| CLI coverage | **~142 of 231** (~61%) |
| Uncovered operations | **~89** |
| Broken routes (FIXED) | **5** (promote, labels show, skills enable/disable/configure) |
| Dispatch bypasses (FIXED) | **1** (observe.ts → now routes through dispatch) |
| Intentional bypasses | **17** (documented in code) |
| Duplicate routes (FIXED) | **1** (observe.ts + memory-brain.ts → now both dispatch) |

> **Consensus note (2026-04-10)**: Operation count verified by 3 independent lead agents.
> `grep -c "gateway: '" registry.ts` = 231 (excludes 5 non-literal references).
> Lead 1 (Code Reviewer) initially counted 235 (included utility function signatures).
> Lead 2 (System Architect) counted 231 (correct). Lead 3 (Quality Engineer) confirmed
> tools domain coverage was overcounted in original audit (28% actual, not 45%).
> Architectural recommendation: Fold conduit's 5 ops into orchestrate domain to
> preserve the 10-domain invariant per constitution §12 and System Flow Atlas.

---

## Phase 0: Broken Routes (COMPLETED)

Five CLI commands dispatched to operations removed during T5615 rationalization.

| File | Broken Route | Fix Applied |
|------|-------------|-------------|
| `promote.ts` | `tasks.promote` | → `tasks.reparent` with `{newParentId: null}` |
| `labels.ts` | `tasks.label.show` | → `tasks.label.list` with `{label}` filter |
| `skills.ts` | `tools.skill.enable` | → `tools.skill.install` |
| `skills.ts` | `tools.skill.disable` | → `tools.skill.uninstall` |
| `skills.ts` | `tools.skill.configure` | Removed (was a stub) |

---

## Phase 1: Dispatch Bypasses (COMPLETED)

| File | Issue | Fix Applied |
|------|-------|-------------|
| `observe.ts` | Called `observeBrain()` directly | Rewritten to use `dispatchFromCli('mutate', 'memory', 'observe', ...)` |
| `exists.ts` | Called `getTask()` directly | Documented as intentional bypass (tasks.exists was deliberately removed) |

---

## Phase 2: Constitutional Drift (PENDING)

### Domain Count: 11 vs 10
- `types.ts` CANONICAL_DOMAINS includes `conduit` (11 domains)
- Constitution and Flow Atlas say 10 domains
- Decision needed: add `conduit` to constitution or remove from registry

### Operation Count: 216 vs 209
Operations in registry not in constitution tables:
- `conduit.status`, `conduit.peek`, `conduit.start`, `conduit.stop`, `conduit.send` (5)
- `tasks.impact`, `tasks.claim`, `tasks.unclaim`
- `admin.paths`, `admin.smoke`, `admin.scaffold-hub`, `admin.map` (query + mutate)
- `pipeline.stage.guidance`
- `orchestrate.classify`, `orchestrate.fanout`, `orchestrate.fanout.status`
- `nexus.transfer`, `nexus.transfer.preview`

---

## Phase 3: Coverage Gaps (PENDING — triage needed)

### Per-Domain Coverage

| Domain | Registry Ops | CLI Covered | CLI Missing | Coverage % |
|--------|-------------|-------------|-------------|------------|
| tasks | 32 | 24 | 8 | 75% |
| session | 15 | 10 | 5 | 67% |
| memory | 18 | 11 | 7 | 61% |
| check | 18 | 14 | 4 | 78% |
| pipeline | 32 | 19 | 13 | 59% |
| orchestrate | 19 | 8 | 11 | 42% |
| tools | 29 | 8 | 21 | 28% |
| admin | 39 | 28 | 11 | 72% |
| nexus | 22 | 14 | 8 | 64% |
| sticky | 6 | 6 | 0 | 100% |
| conduit | 5 | 0 | 5 | 0% |
| **TOTAL** | **231** | **~142** | **~89** | **~61%** |

> Per-domain counts verified by Lead 2 (System Architect) against registry SSoT.
> Tools domain corrected per Lead 3 (Quality Engineer): 29 ops total including
> code.* (4), provider.* (6), adapter.* (6) sub-domains — coverage is 28%, not 45%.

### Key Missing Areas
- **conduit domain**: 0% — no CLI surface at all (5 ops)
- **orchestrate**: Missing classify, fanout, tessera, handoff, spawn.execute, parallel
- **tools**: All provider.* and adapter.* ops uncovered (16 ops)
- **pipeline**: All chain/warpchain ops uncovered (5 ops)
- **memory**: decision.store/find, graph.*, link uncovered

---

## Phase 4: Commander-Shim Removal (DEFERRED)

### Current State
- 97 command modules use ShimCommand from commander-shim.ts
- 1 command (code.ts) is native citty
- help-renderer.ts and help-generator.ts depend on ShimCommand
- 20 test files reference ShimCommand
- dynamic.ts is an unused stub for registry-driven CLI generation

### Blockers
1. Only 48/216 registry ops have ParamDef arrays (needed for auto-generation)
2. Help system tied to ShimCommand interface
3. No native citty replacement for global flag pre-processing
4. 20 test files need updating

### Recommendation
Do not block shipping Phase 0-2 fixes. The shim is stable and functional.
Plan shim removal as a separate epic requiring:
- Registry ParamDef enrichment (48 → 216)
- Help system rewrite
- Gradual command migration (10-15 per sprint)

---

## Command Module Classification (99 files)

| Category | Count | Description |
|----------|-------|-------------|
| canonical-dispatch | 62 | Routes through `dispatchFromCli` / `dispatchRaw` to registry operations |
| canonical-direct | 17 | Calls `@cleocode/core` functions directly (bypass) |
| mixed (dispatch + direct) | 4 | `config.ts`, `issue.ts`, `restore.ts`, `token.ts` |
| helper | 2 | `agent-profile-status.ts`, `backup-inspect.ts` (registered by parent) |
| dead | 2 | `agents.ts` (no-op stub), `dynamic.ts` (no-op stub for registry-driven gen) |
| utility | 1 | `schema.ts` (reads registry directly for introspection) |

### Additional Findings from Classification

- 4 protocol-validation commands (`consensus.ts`, `contribution.ts`, `decomposition.ts`, `specification.ts`, `implementation.ts`) all route to the same `check.protocol` operation with different `protocolType` values — effectively aliases
- `phases.ts` duplicates `phase.ts` (`phases stats` calls same `pipeline.phase.list` as `phases list`)
- `issue.ts` has a mixed pattern: `issue diagnostics` dispatches but `issue bug/feature/help` call `addIssue()` directly (ops were removed in T5615)
- `sequence.ts` `repair` subcommand overloads `admin.config.set` — likely a workaround

## Intentional Dispatch Bypasses (17 — no fix needed)

| File | Reason |
|------|--------|
| `init.ts` | Bootstrap — dispatch not available before project init |
| `env.ts` | CLI-only — no dispatch domain for environment diagnostics |
| `otel.ts` | CLI-only — telemetry is local-only |
| `checkpoint.ts` | CLI-only — git checkpoint has no dispatch route |
| `web.ts` | CLI-only — requires process spawn/PID management |
| `generate-changelog.ts` | CLI-only — local file generation |
| `docs.ts` | CLI-only — filesystem scan |
| `upgrade.ts` | Must run before dispatch is healthy (schema migration) |
| `self-update.ts` | CLI-only — npm package management |
| `detect.ts` | CLI-only — project type detection |
| `detect-drift.ts` | CLI-only — local static analysis |
| `backfill.ts` | Database maintenance utility |
| `migrate-claude-mem.ts` | One-time migration utility |
| `remote.ts` | CLI-only — git remote operations |
| `agent.ts` | CLI-only — agent registry + SignalDock client operations |
| `brain.ts` | CLI-only — brain maintenance (no dispatch route) |
| `refresh-memory.ts` | CLI-only — writes memory bridge file directly |
| `cant.ts` | CLI-only — calls @cleocode/cant parser API |
| `code.ts` | CLI-only — native citty command, tree-sitter analysis |
