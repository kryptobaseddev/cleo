# CLEO Core SDK Tools Surface

**ADR-064** | Epic **T1768** | Updated: 2026-05-12

## Overview

The Core SDK Tools surface is the set of harness-agnostic utility primitives that
every spawn pathway, harness adapter, and orchestration layer MUST consume. These
tools live under `packages/core/src/tools/sdk/` and are barrel-exported from
`packages/core/src/tools/sdk/index.ts`.

The surface solves a concrete problem: without it, harnesses copy-paste isolation
enforcement, tool resolution, and manifest writes inline — leading to divergent
behavior across the Pi harness, Claude Code harness, and future adapters.

## Four-Category Taxonomy

```
                  ┌────────────────────────────────────────────┐
                  │           @cleocode/contracts               │
                  │  (zero-dep: types, schemas, pure functions) │
                  └───────────────────┬────────────────────────┘
                                      │ re-exports
                  ┌───────────────────▼────────────────────────┐
                  │   packages/core/src/tools/sdk/  (Cat. B)   │
                  │   WorktreeIsolation  ToolResolver           │
                  │   ToolCache  Manifest  SpawnPrimitives      │
                  └───────┬──────────────────────┬─────────────┘
                          │ consumed by           │
         ┌────────────────▼──────────┐  ┌────────▼─────────────────┐
         │  cleo-os/   (harnesses)   │  │  packages/core/ domain   │
         │  PiHarness                │  │  orchestration, spawn,   │
         │  ClaudeCodeSpawnProvider  │  │  task-executor           │
         └───────────────────────────┘  └──────────────────────────┘
```

| Category | Description | Location |
|----------|-------------|----------|
| **A — Agent Tool** | LLM-callable tools (function calling, MCP) | `tools/agents/` |
| **B — SDK Tool** | Harness-agnostic infrastructure primitives (this surface) | `tools/sdk/` |
| **C — Domain Utility** | CAAMP management, engine ops (not promoted) | `tools/engine-ops.ts` |
| **D — Harness-Internal** | Pi/Claude Code private impl details | `packages/cleo-os/` |

## SDK Tools Reference

All SDK Tools are exported from `packages/core/src/tools/sdk/index.ts`. Import
from this barrel; do NOT import directly from the domain-layer implementation files.

### WorktreeIsolation

| | |
|---|---|
| **File** | `packages/core/src/tools/sdk/isolation.ts` |
| **Source** | `packages/core/src/worktree/isolation.ts` → `@cleocode/contracts` |
| **Exports** | `provisionIsolatedShell`, `validateAbsolutePath`, `BoundaryContract`, `IsolationEnvKey` |
| **Purpose** | Provision an isolated agent shell (worktree CWD) and validate that file edits stay inside the worktree boundary |

**When to use:** Any spawn pathway that provisions a worktree for a subagent MUST
call `provisionIsolatedShell`. Any harness Edit/Write path MUST call
`validateAbsolutePath` before writing outside the working directory.

### ToolResolver

| | |
|---|---|
| **File** | `packages/core/src/tools/sdk/tool-resolver.ts` |
| **Source** | `packages/core/src/tasks/tool-resolver.ts` |
| **Exports** | `resolveToolCommand`, `CANONICAL_TOOLS`, `CanonicalTool`, `ResolvedToolCommand`, `ResolutionSource` |
| **Purpose** | Resolve canonical tool names (test, lint, typecheck, build) to project-specific commands via `.cleo/project-context.json` |

**When to use:** Any evidence-verification pathway that needs to run `pnpm run test`
or `biome check` MUST call `resolveToolCommand('test')` rather than hardcoding the
command string.

### ToolCache

| | |
|---|---|
| **File** | `packages/core/src/tools/sdk/tool-cache.ts` |
| **Source** | `packages/core/src/tasks/tool-cache.ts` + `tool-semaphore.ts` |
| **Exports** | `runToolCached`, `acquireGlobalSlot`, `RunToolOptions`, `RunToolResult` |
| **Purpose** | Content-addressed, cross-process cached tool execution with per-tool concurrency limits (ADR-061) |

**When to use:** `cleo verify --evidence "tool:test"` and any gate verification that
runs a tool command should use `runToolCached` to avoid re-running the same tool
multiple times in parallel worktrees.

### Manifest

| | |
|---|---|
| **File** | `packages/core/src/tools/sdk/manifest.ts` |
| **Source** | `packages/core/src/memory/pipeline-manifest-sqlite.ts` |
| **Exports** | `pipelineManifestAppend`, `ManifestEntry`, `ManifestAppendResult` |
| **Purpose** | Subagent pipeline manifest writes (ADR-027) — every worker MUST append a manifest entry before calling `cleo complete` |

**When to use:** Workers completing an IVTR cycle MUST call `pipelineManifestAppend`
with their key_findings before calling `cleo complete`. This is enforced by exit
code 62 (`MANIFEST_ENTRY_MISSING`).

### SpawnPrimitives

| | |
|---|---|
| **File** | `packages/core/src/tools/sdk/spawn-primitives.ts` |
| **Source** | `packages/core/src/spawn/branch-lock.ts` |
| **Exports** | `buildAgentEnv`, `buildWorktreeSpawnResult`, `WorktreeSpawnResult` |
| **Purpose** | Build the environment map injected into a spawned agent process and construct the spawn result shape |

**When to use:** Harness adapters that spawn subagent processes (PiHarness,
ClaudeCodeSpawnProvider) MUST use `buildAgentEnv` to inject worktree context and
`buildWorktreeSpawnResult` for the canonical return value.

## Candidates for Future Promotion

The following primitives are used across multiple harnesses but have not yet been
promoted to SDK Tools. They are candidates for future Category B promotion.

| Symbol | Current Location | Reason for Promotion |
|--------|-----------------|---------------------|
| `EvidenceCapture` | `packages/core/src/tasks/evidence-capture.ts` | Used by Pi + Claude Code adapters; promotion unblocks T1832 |
| `SessionBinder` | `packages/core/src/sessions/session-binder.ts` | Harness-agnostic; currently duplicated in 3 adapters |

Promotion tasks should be filed as children of T1768 once the current wave is
stable.

## Related

- [ADR-064](./../.cleo/adrs/ADR-064-caamp-adapters-boundary.md) — SDK Tools taxonomy (CAAMP adapters boundary)
- [T1768](cleo show T1768) — Epic: Define Core SDK Tools surface
- [T1815](cleo show T1815) — Initial SDK Tools barrel creation
- [T1817](cleo show T1817) — WorktreeIsolation SDK Tool promotion
- [T1818](cleo show T1818) — ToolResolver + ToolCache SDK Tool promotion
- [T1819](cleo show T1819) — Manifest SDK Tool promotion
