# T476 — check Domain Audit

**Date**: 2026-04-10
**Task**: T476 — W3: check domain lead (18 ops)
**Status**: complete

---

## Registry Source of Truth

All 18 ops are defined in `packages/cleo/src/dispatch/domains/check.ts` via `getSupportedOperations()` and cross-referenced in `packages/cleo/src/dispatch/registry.ts`.

### Query ops (14)

| Op | Registry | CLI handler | Command | File |
|----|----------|-------------|---------|------|
| `schema` | check.ts:556 | `cleo check schema <type>` | check.ts | check.ts |
| `protocol` | check.ts:557 | `cleo check protocol <protocolType>` | check.ts | check.ts |
| `task` | check.ts:558 | `cleo check task <taskId>` | check.ts | check.ts |
| `manifest` | check.ts:559 | `cleo testing validate/check` | testing.ts | testing.ts |
| `output` | check.ts:560 | `cleo check output <filePath>` | check.ts | **check.ts (added T476)** |
| `compliance.summary` | check.ts:561 | `cleo compliance summary/violations/trend/audit/skills/value` | compliance.ts | compliance.ts |
| `workflow.compliance` | check.ts:562 | `cleo stats compliance` | stats.ts | stats.ts |
| `test` | check.ts:563 | `cleo testing status/coverage` | testing.ts | testing.ts |
| `coherence` | check.ts:564 | `cleo check coherence` | check.ts | check.ts |
| `gate.status` | check.ts:565 | `cleo verify <task-id>` (read path) | verify.ts | verify.ts |
| `archive.stats` | check.ts:566 | `cleo archive-stats` | archive-stats.ts | archive-stats.ts |
| `grade` | check.ts:567 | `cleo grade <sessionId>` | grade.ts | grade.ts |
| `grade.list` | check.ts:568 | `cleo grade --list` | grade.ts | grade.ts |
| `chain.validate` | check.ts:569 | `cleo check chain-validate <file>` | check.ts | **check.ts (added T476)** |

### Mutate ops (4)

| Op | Registry | CLI handler | Command | File |
|----|----------|-------------|---------|------|
| `compliance.record` | check.ts:572 | `cleo compliance record <taskId> <result>` | compliance.ts | **compliance.ts (added T476)** |
| `compliance.sync` | check.ts:573 | `cleo compliance sync` | compliance.ts | compliance.ts |
| `test.run` | check.ts:574 | `cleo testing run` | testing.ts | testing.ts |
| `gate.set` | check.ts:575 | `cleo verify <task-id> --gate/--all/--reset` | verify.ts | verify.ts |

---

## Missing Ops — Classification & Resolution

Three ops had no CLI handler prior to T476.

### 1. `check.output` (query) — needs-cli → IMPLEMENTED

**Rationale**: Agents and humans need to validate output files from the terminal during development and CI pipelines. The underlying engine function (`validateOutput(filePath, taskId?, projectRoot?)`) is well-defined and accepts a simple file path.

**Implementation**: `cleo check output <filePath> [--task-id <id>]` added to `check.ts`.

### 2. `check.chain.validate` (query) — needs-cli → IMPLEMENTED

**Rationale**: WarpChain definitions are JSON files that benefit from local validation before dispatch. While this op is primarily agent-authored, a file-based CLI makes it debuggable and CI-friendly. The input constraint (full `WarpChain` JSON object) is solved by reading from a file path.

**Implementation**: `cleo check chain-validate <file>` added to `check.ts`. Reads the JSON file and passes the parsed object as `chain` param.

### 3. `check.compliance.record` (mutate) — needs-cli → IMPLEMENTED

**Rationale**: While agents call this programmatically, manual recording is needed for audit, testing, and backfill scenarios. The existing `compliance` command group is the natural home.

**Implementation**: `cleo compliance record <taskId> <result> [--protocol <name>] [--violation code:severity:message]...` added to `compliance.ts`. Repeatable `--violation` flags are parsed into the `violations` array the engine expects.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/cleo/src/cli/commands/check.ts` | Added `check output` and `check chain-validate` subcommands |
| `packages/cleo/src/cli/commands/compliance.ts` | Added `compliance record` subcommand |

---

## Quality Gates

| Gate | Status |
|------|--------|
| `pnpm biome check --write` | PASS — no fixes applied |
| `pnpm --filter @cleocode/cleo run build` | PASS — zero errors |
| New failures introduced | NONE |

Note: `pnpm run build` (full monorepo) fails in `@cleocode/cant` on pre-existing TS2591 errors (`native-loader.ts`, `worktree.ts`) unrelated to this task. The `@cleocode/cant` package builds successfully in isolation; the failure occurs only in the full monorepo build pipeline due to a dependency ordering issue.
