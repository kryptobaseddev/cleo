# T507 — Central Dependency Registry SSoT

**Status**: complete
**Date**: 2026-04-11
**Agent**: claude-sonnet-4-6 (subagent)

## Summary

Implemented the central dependency registry for CLEO runtime dependency verification. This is the foundation SSoT that all other health-check and feature-gating work streams can build on.

## Deliverables

### 1. `packages/contracts/src/dependency.ts` (new)

Defines four exported types:

- `DependencyCategory` — `'required' | 'optional' | 'feature'` union
- `DependencySpec` — static registry entry (name, category, description, versionConstraint, documentationUrl, installCommand, platforms)
- `DependencyCheckResult` — runtime check outcome (installed, version, location, healthy, error, suggestedFix)
- `DependencyReport` — full report from `checkAllDependencies()` (timestamp, platform, nodeVersion, results, allRequiredMet, warnings)

### 2. `packages/contracts/src/index.ts` (modified)

Added barrel export block for all four dependency types between the code-symbol and discovery export sections.

### 3. `packages/core/src/system/dependencies.ts` (new)

Registry with 8 dependency specs and corresponding check implementations:

**Required:**
- `node` — version >= 24.0.0 (reads `process.version` directly, always installed)
- `git` — any version (`which git` + `git --version`)

**Optional (feature-gating):**
- `tree-sitter` — delegates to `isTreeSitterAvailable()` in `code/parser.ts` to avoid duplicating bin-path resolution logic
- `gh` — GitHub CLI (`which gh` + `gh --version`)
- `unzip` — archive import (linux/darwin only)
- `zip` — archive export (linux/darwin only)

**Feature (native addons):**
- `cant-napi` — probes binary path directly via `createRequire` (avoids circular dep: core → cant → core)
- `lafs-napi` — attempts `@cleocode/lafs-native` then dev-build fallback

Public API:
- `getDependencySpecs(): DependencySpec[]` — static registry for docs/help text
- `checkDependency(name: string): Promise<DependencyCheckResult>` — single dependency check
- `checkAllDependencies(): Promise<DependencyReport>` — full report, skips platform-inapplicable deps

Key design decisions:
- ESM-compatible: uses `createRequire(import.meta.url)` and `fileURLToPath` instead of `require`/`__dirname`
- No circular dependencies: native addon checks use direct path resolution rather than cross-package imports
- Platform filtering: `unzip`/`zip` specs declare `platforms: ['linux', 'darwin']` and are skipped on Windows

### 4. `packages/core/src/system/health.ts` (modified)

Changes:
- Added `import { checkAllDependencies } from './dependencies.js'` and `import type { DependencyReport } from '@cleocode/contracts'`
- Added `dependencies?: DependencyReport` field to `DoctorReport` interface
- Replaced the hand-coded `git_installed` check in `coreDoctorReport()` with a loop over `depReport.results` that maps each `DependencyCheckResult` into a `DoctorCheck` entry (check name: `dep_<name>`)
- Removed the now-unused local `commandExists()` async helper and its `execFile`/`promisify` imports

## Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write` | Clean (no warnings) |
| `pnpm run build` | Success — all packages built |
| `pnpm run test` | 7018 passed, 15 skipped, 32 todo — zero new failures |
| `git diff --stat` | 4 files (2 new, 2 modified) — scope matches spec |

## Architecture Notes

The registry is intentionally kept simple and synchronous where possible. The async surface (`checkDependency`, `checkAllDependencies`) exists only because:

1. `checkTreeSitter` uses a lazy dynamic import to avoid circular dependencies
2. `Promise.all` is used in `checkAllDependencies` to parallelize checks

All other checks are synchronous internally and wrapped with `Promise.resolve()` to satisfy the unified `Promise<DependencyCheckResult>` return type.

The `commandExists()` helper in `platform.ts` is NOT used by this module — instead a local `which()` helper calls `execFileSync` directly, matching the existing pattern in `platform.ts` itself. This avoids an import that would be redundant with the already-imported `PLATFORM` constant.
