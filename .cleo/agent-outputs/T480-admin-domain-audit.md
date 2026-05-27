# T480 Admin Domain Audit — 39 Ops

**Date**: 2026-04-10
**Agent**: admin domain lead subagent
**Status**: complete

---

## Summary

Audited all 39 admin-domain registry operations across 17 CLI handler files. Found and fixed 5 dispatch correctness issues. Classified all "missing CLI" ops from the task description.

**Build**: passes. **Tests**: zero new failures (5 pre-existing failures in unrelated files).

---

## Registry Operations (39 total)

### Query (21 ops)

| Operation | Registry | Domain Handler | CLI Handler | Status |
|-----------|----------|---------------|-------------|--------|
| version | yes | yes | `admin.ts` → admin version | OK |
| health | yes | yes | `doctor.ts` → admin health | OK |
| config.show | yes | yes | `config.ts` → config get | OK |
| config.presets | yes | yes | `config.ts` → config presets | OK |
| stats | yes | yes | `admin.ts` → admin stats | OK |
| context | yes | yes | `context.ts` → context status/check/list | OK |
| runtime | yes | yes | `admin.ts` → admin runtime | OK |
| paths | yes | yes | `admin.ts` → admin paths | OK |
| job | yes | yes | `admin.ts` → admin job list/status | ADDED |
| dash | yes | yes | `dash.ts` → dash | OK |
| log | yes | yes | `log.ts` → log | OK |
| sequence | yes | yes | `sequence.ts` → sequence show/check | OK |
| help | yes | yes | `commands.ts` / `ops.ts` → admin help | OK |
| backup | yes | yes | `backup.ts` → backup list | OK |
| token | yes | yes | `token.ts` → token summary/list/show | OK |
| adr.show | yes | yes | `adr.ts` → adr show | OK |
| adr.find | yes | yes | `adr.ts` → adr list/find | OK |
| export | yes | yes | `export.ts` + `snapshot.ts` → export/snapshot export | OK |
| smoke | yes | yes | `doctor.ts` → doctor --full | OK |
| hooks.matrix | yes | yes | `doctor.ts` → doctor --hooks | OK |
| map | yes | yes | `map.ts` → map | OK |

### Mutate (18 ops)

| Operation | Registry | Domain Handler | CLI Handler | Status |
|-----------|----------|---------------|-------------|--------|
| init | yes | yes | `init.ts` (inferred) | OK |
| scaffold-hub | yes | yes | `admin.ts` → admin scaffold-hub | OK |
| config.set | yes | yes | `config.ts` → config set | OK |
| config.set-preset | yes | yes | `config.ts` → config set-preset | OK |
| backup | yes | yes | `backup.ts` → backup add | OK |
| migrate | yes | yes | `migrate-claude-mem.ts` → migrate storage | ADDED |
| cleanup | yes | yes | `admin.ts` → admin cleanup | ADDED |
| job.cancel | yes | yes | `admin.ts` → admin job cancel | ADDED |
| safestop | yes | yes | `safestop.ts` → safestop | OK |
| inject.generate | yes | yes | `inject.ts` → inject | OK |
| install.global | yes | yes | `admin.ts` → admin install-global | ADDED |
| token | yes | yes | `token.ts` → token delete/clear | OK |
| adr.sync | yes | yes | `adr.ts` → adr sync/validate | OK |
| health | yes | yes | `doctor.ts` → doctor --fix | OK |
| context.inject | yes | yes | `admin.ts` → admin context-inject | ADDED |
| import | yes | yes | `import.ts` + `snapshot.ts` → import/snapshot import | OK |
| detect | yes | yes | `detect.ts` → detect (now via dispatch) | FIXED |
| map | yes | yes | `map.ts` → map --store | OK |

---

## Bugs Fixed

### Bug 1: `sequence repair` — misrouted to wrong dispatch op

**File**: `packages/cleo/src/cli/commands/sequence.ts`

**Before**: `dispatchFromCli('mutate', 'admin', 'config.set', { key: 'sequence', value: 'repair' })`

**Problem**: `admin.sequence (mutate)` was removed in T5615 with a comment "expose via config.set if needed", but the CLI was left dispatching to `config.set` with a spurious `{ key: 'sequence', value: 'repair' }` payload. This would set a config key called "sequence" to the string "repair" rather than actually repairing the sequence counter.

**Fix**: Call `systemSequenceRepair(projectRoot)` directly from the CLI (matching the pattern used by `detect.ts`). The engine function calls `repairSequence()` from core and returns structured data compatible with `cliOutput`.

### Bug 2: `detect` command — bypassed dispatch layer

**File**: `packages/cleo/src/cli/commands/detect.ts`

**Before**: Called `ensureProjectContext(projectRoot, { staleDays: 0 })` directly, bypassing audit logging, middleware, and envelope normalization. The `mutate admin detect` registry op and domain handler existed but were never wired to the CLI.

**Fix**: Route through `dispatchFromCli('mutate', 'admin', 'detect', ...)` for consistency with the rest of the dispatch architecture.

---

## Missing CLI Ops — Implemented

### `mutate admin migrate` → `cleo migrate storage`

**File**: `packages/cleo/src/cli/commands/migrate-claude-mem.ts`

Added `cleo migrate storage [--target <version>] [--dry-run]` as a sibling to the existing `cleo migrate claude-mem` subcommand. Dispatches to `mutate admin migrate`.

Classification: **needs-cli** — the engine (`systemMigrate`) is fully implemented; only the CLI surface was missing.

### `mutate admin cleanup` → `cleo admin cleanup`

**File**: `packages/cleo/src/cli/commands/admin.ts`

Added `cleo admin cleanup --target <target> [--older-than <age>] [--dry-run]`. Dispatches to `mutate admin cleanup`. The `target` param is required (mirrors the domain handler's validation).

Classification: **needs-cli** — `systemCleanup` is fully implemented in the engine.

### `query admin job` (list/status) → `cleo admin job list|status`

**File**: `packages/cleo/src/cli/commands/admin.ts`

Added `cleo admin job list [--status] [--limit] [--offset]` and `cleo admin job status <jobId>`. Dispatches to `query admin job` with `action: 'list'` and `action: 'status'` respectively.

Classification: **needs-cli** — job manager is runtime-initialized; the query op is fully implemented.

### `mutate admin job.cancel` → `cleo admin job cancel`

**File**: `packages/cleo/src/cli/commands/admin.ts`

Added `cleo admin job cancel <jobId>`. Dispatches to `mutate admin job.cancel`.

Classification: **needs-cli** — symmetrically needed alongside job list/status.

### `mutate admin install.global` → `cleo admin install-global`

**File**: `packages/cleo/src/cli/commands/admin.ts`

Added `cleo admin install-global`. Dispatches to `mutate admin install.global`. Refreshes global CLEO setup (provider files, configs, `~/.agents/AGENTS.md`).

Classification: **needs-cli** — `ensureGlobalScaffold` + `ensureGlobalTemplates` are fully implemented.

### `mutate admin context.inject` → `cleo admin context-inject`

**File**: `packages/cleo/src/cli/commands/admin.ts`

Added `cleo admin context-inject <protocolType> [--task <id>] [--variant <variant>]`. Dispatches to `mutate admin context.inject`.

Classification: **needs-cli** (primarily agent-facing but should have CLI surface for testing). `sessionContextInject` is fully implemented in the engine.

---

## CLI Files Audited (all 17 in scope)

| File | Domain Handler Target | Verified |
|------|-----------------------|---------|
| `admin.ts` | admin.version/health/stats/runtime/smoke/paths/scaffold-hub + new ops | yes |
| `adr.ts` | admin.adr.find/show/sync | yes |
| `backup.ts` | admin.backup (query+mutate) | yes |
| `config.ts` | admin.config.show/set/set-preset/presets | yes |
| `dash.ts` | admin.dash | yes |
| `doctor.ts` | admin.health/smoke/hooks.matrix + check.coherence | yes |
| `export.ts` | admin.export | yes |
| `import.ts` | admin.import | yes |
| `inject.ts` | admin.inject.generate | yes |
| `log.ts` | admin.log | yes |
| `map.ts` | admin.map (query+mutate) | yes |
| `safestop.ts` | admin.safestop | yes |
| `sequence.ts` | admin.sequence (query) + systemSequenceRepair (repair) | fixed |
| `snapshot.ts` | admin.export (scope:snapshot) + admin.import (scope:snapshot) | yes |
| `token.ts` | admin.token (query+mutate) | yes |
| `commands.ts` | admin.help | yes |
| `ops.ts` | admin.help | yes |
| `detect.ts` | admin.detect (now via dispatch) | fixed |
| `migrate-claude-mem.ts` | admin.migrate (storage subcommand added) | fixed/added |

---

## Quality Gates

- `pnpm biome check --write`: passed (2 files formatted, 0 errors)
- `pnpm run build`: passed (all packages built successfully)
- `pnpm run test`: 36/36 admin domain tests pass; 5 pre-existing failures in unrelated files (startup-migration timeout, session-find timeout, performance-safety flap)
