# SDK Tools Audit — packages/core/src/tools/

**Task**: T1814  
**Date**: 2026-05-04  
**Scope**: `packages/core/src/tools/` (audit target, read-only)  
**Author**: T1814 research subagent  
**Session**: ses_20260504220533_7d990f  

---

## Methodology

1. `find packages/core/src/tools -type f -name "*.ts" | sort` — enumerated all files in the tools subtree.
2. Read full content of each file to understand purpose and sub-domain ownership.
3. `grep -rn "from.*tools/\|toolsIssue\|toolsSkill\|toolsProvider\|toolsAdapter"` — mapped every consumer across all packages.
4. Applied the ADR-XXX (draft at `.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md`) category definitions:
   - **Category A (Agent Tool)**: runtime callable primitive exposed to an LLM via function-calling protocol.
   - **Category B (SDK Tool)**: harness-agnostic infrastructure utility that ALL adapters/harnesses MUST use.
   - **Category C (Domain Utility / CAAMP Management)**: internal to a specific domain; not required cross-harness.
   - **Category D (Harness Internal)**: implementation detail of a specific harness or adapter.
5. Confirmed consumer counts from actual grep output.

---

## Classification Table — Existing Files in packages/core/src/tools/

| File | Current Path | Category | Recommended Path | Consumers (count) | Rationale |
|------|-------------|----------|-----------------|-------------------|-----------|
| `engine-ops.ts` | `packages/core/src/tools/engine-ops.ts` | **C** — CAAMP Management Operations | Stay at `packages/core/src/tools/engine-ops.ts` | 3 direct (see below) | Wraps CAAMP skill/provider/adapter operations (ENG-MIG-8 / T1575). These are CLI-surface domain ops for managing skill catalogs, CAAMP providers, and adapter lifecycle — NOT harness-agnostic infrastructure utilities. NOT SDK Tools. NOT Agent Tools. The existing `tools/` root is the correct permanent home. |
| `index.ts` | `packages/core/src/tools/index.ts` | **C** — CAAMP Management Operations | Stay at `packages/core/src/tools/index.ts` | 1 indirect (via internal.ts) | Barrel re-export for `engine-ops.ts`. Maintained as the public surface for the CAAMP management domain within `tools/`. No change needed. |

### Consumers of packages/core/src/tools/engine-ops.ts

| Consumer File | Package | How |
|--------------|---------|-----|
| `packages/core/src/internal.ts` | `@cleocode/core` | Direct import at line 1921; re-exports all 28 tool functions to the `@cleocode/core/internal` surface |
| `packages/cleo/src/dispatch/engines/tools-engine.ts` | `@cleocode/cleo` | Pure re-export shim; imports from `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/domains/tools.ts` | `@cleocode/cleo` | Domain handler; imports via the shim `engines/tools-engine.ts` |

---

## SDK Tool Candidates Identified Across packages/core/

The audit scope per the task description is `packages/core/src/tools/`. However, the ADR draft (T1768 decomposition) identified that the SDK Tools being promoted to `packages/core/src/tools/sdk/` currently live in OTHER directories within `packages/core/`. This section maps them for completeness of the migration plan.

### Confirmed Category B (SDK Tool) — Promote to packages/core/src/tools/sdk/

These are the primitives that are harness-agnostic, currently scattered in `tasks/`, `spawn/`, and `worktree/` sub-directories within `packages/core/`, and `packages/contracts/`.

| Symbol | Current Location | Category | Recommended Path | Consumers (count) | Rationale |
|--------|----------------|----------|-----------------|-------------------|-----------|
| `provisionIsolatedShell` | `packages/contracts/src/branch-lock.ts` | **B** | Re-export from `packages/core/src/tools/sdk/isolation.ts` | 5 active consumers (see below) | Pure function (no I/O, no side effects). Harness-agnostic by design (T1759). Already in contracts tier — correct. Needs `tools/sdk/` re-export entry point for consistent import path. |
| `ISOLATION_ENV_KEYS` | `packages/contracts/src/branch-lock.ts` | **B** | Re-export from `packages/core/src/tools/sdk/isolation.ts` | 4 active consumers | Constant paired with `provisionIsolatedShell`. Same promotion path. |
| `validateAbsolutePath` | `packages/contracts/src/branch-lock.ts` (re-exported via `packages/core/src/worktree/isolation.ts`) | **B** | Re-export from `packages/core/src/tools/sdk/isolation.ts` | Used by git-shim (1 consumer) | T1851 extension to the isolation contract. Closes the absolute-path bypass vector. Belongs in isolation.ts SDK tool. |
| `resolveToolCommand` | `packages/core/src/tasks/tool-resolver.ts` | **B** | Re-export from `packages/core/src/tools/sdk/tool-resolver.ts` | 3 (evidence.ts, validate-ops.ts, internal.ts) | Project-agnostic tool command resolution (ADR-051/ADR-061). Zero harness-specific imports. Deterministic given identical inputs. Classic SDK Tool. |
| `CANONICAL_TOOLS` | `packages/core/src/tasks/tool-resolver.ts` | **B** | Re-export from `packages/core/src/tools/sdk/tool-resolver.ts` | 3 (same as resolveToolCommand) | Type-level constant paired with `resolveToolCommand`. Moves with it. |
| `runToolCached` | `packages/core/src/tasks/tool-cache.ts` | **B** | Re-export from `packages/core/src/tools/sdk/tool-cache.ts` | 2 (evidence.ts, internal.ts) | Content-addressed tool execution cache (ADR-061). Cross-process semaphore for parallel worktree safety. Pure infrastructure, no harness specifics. SDK Tool. |
| `acquireGlobalSlot` | `packages/core/src/tasks/tool-semaphore.ts` | **B** | Re-export from `packages/core/src/tools/sdk/tool-cache.ts` (paired with runToolCached) | 1 (tool-cache.ts only; re-exported via internal.ts) | Machine-wide concurrency bounding for parallel tool runs. Companion to `runToolCached`. No external consumers outside core currently, but is exported via `internal.ts`. Bundle with tool-cache.ts promotion. |
| `pipelineManifestAppend` | `packages/core/src/memory/pipeline-manifest-sqlite.ts` | **B** | Re-export from `packages/core/src/tools/sdk/manifest.ts` | 28+ across all packages (see note) | ADR-027 SQLite write for subagent reporting. This is the protocol surface for agents to record their work — a cross-cutting SDK primitive. However, see note below about split: `pipelineManifestAppend` is an SDK Tool; the remaining manifest ops (`List`, `Show`, `Archive`, etc.) are CLI/domain utilities (Category C). |
| `buildAgentEnv` | `packages/core/src/spawn/branch-lock.ts` | **B** | Re-export from `packages/core/src/tools/sdk/spawn-primitives.ts` | 0 external consumers outside core/spawn (only re-exported via internal.ts) | Harness-agnostic spawn environment construction. No harness-specific imports. SDK Tool candidate per ADR draft. Low urgency (no external adopter yet). |
| `buildWorktreeSpawnResult` | `packages/core/src/spawn/branch-lock.ts` | **B** | Re-export from `packages/core/src/tools/sdk/spawn-primitives.ts` | 0 external consumers outside core/spawn | Harness-agnostic spawn result construction. Same as `buildAgentEnv`. SDK Tool candidate. Low urgency. |

**Note on `pipelineManifestAppend` consumer count**: The 28+ files listed in the grep results include the SQLite implementation itself, the manifest-builder, and many domain files that import it for recording pipeline events. The key external-facing consumers are in `packages/cleo/`, `packages/caamp/`, `packages/studio/`, and scattered across `packages/core/src/` domain modules. This wide consumption pattern confirms it is an SDK Tool.

### Confirmed Category A (Agent Tool) — T1737 / T1739 owns, NOT in tools/ yet

These are NOT currently in `packages/core/src/tools/`. They represent the future `packages/core/src/tools/agents/` directory — owned by T1737 children.

| Concept | T1737 Task | Notes |
|---------|-----------|-------|
| `AgentToolRegistry` | T1739 | Does not exist yet; to be created at `packages/core/src/tools/agents/registry.ts` |
| Tool dispatch engine | T1740 | Does not exist yet |
| Terminal, file, git tools | T1741 | Does not exist yet |
| Web search, browser tools | T1742 | Does not exist yet |
| Memory, vision, cron, MCP tools | T1743 | Does not exist yet |

### Confirmed Category C (Domain Utility) — Leave in place

| Symbol | Current Location | Rationale |
|--------|----------------|-----------|
| `toolsIssueDiagnostics`, `toolsSkillList`, `toolsProviderList`, `toolsAdapterActivate`, etc. | `packages/core/src/tools/engine-ops.ts` | CAAMP provider/adapter/skill management — a 3rd distinct meaning of "tools". Domain operations exposed through the CLI dispatch layer. NOT harness-agnostic infrastructure. |
| `recordEvidence` (RCASD evidence) | `packages/core/src/lifecycle/evidence.ts` | SQLite-backed; lifecycle domain; uses task store. NOT cross-harness. |
| `RateLimiter` | `packages/core/src/security/input-sanitization.ts` | Security domain utility. Not cross-harness. |
| Hook dispatch | `packages/core/src/hooks/registry.ts` | Hooks domain. Not SDK surface. |
| `pipelineManifestList`, `pipelineManifestShow`, `pipelineManifestArchive`, `pipelineManifestFind`, `pipelineManifestStats` | `packages/core/src/memory/pipeline-manifest-sqlite.ts` | CLI-surface manifest query ops. Separate from the SDK `pipelineManifestAppend`. |
| Conduit transport | `packages/core/src/conduit/` | Messaging domain. Not SDK surface. |

### Confirmed Category D (Harness Internal) — Leave in harness packages

| Symbol | Package | Rationale |
|--------|---------|-----------|
| `PiCodingAgentAdapter` | `packages/cleo-os/` | Pi-specific process management |
| `ClaudeCodeSpawnProvider` | `packages/adapters/src/providers/claude-code/` | Claude CLI-specific adapter |
| `ClaudeSDKSpawnProvider` | `packages/adapters/src/providers/claude-sdk/` | Vercel AI SDK-specific |
| `DEFAULT_TOOLS` (tool-bridge.ts) | `packages/adapters/src/providers/claude-sdk/` | Claude SDK tool allowlist |

---

## Consumer Detail: provisionIsolatedShell / ISOLATION_ENV_KEYS

| Consumer File | Package | Import Path |
|--------------|---------|-------------|
| `packages/caamp/src/core/harness/pi.ts` | `@cleocode/caamp` | `@cleocode/contracts` (direct — already correct) |
| `packages/core/src/orchestrate/spawn-ops.ts` | `@cleocode/core` | `../worktree/isolation.js` (local re-export wrapper) |
| `packages/core/src/orchestration/spawn-prompt.ts` | `@cleocode/core` | `../worktree/isolation.js` (local re-export wrapper) |
| `packages/git-shim/src/isolation-boundary.ts` | `@cleocode/git-shim` | `@cleocode/contracts` (direct — already correct) |
| `packages/adapters/src/providers/claude-code/spawn.ts` | `@cleocode/adapters` | Comment reference only (T1759 noted but not formally imported) |

**Key finding**: The Claude Code adapter (`packages/adapters/src/providers/claude-code/spawn.ts`) references T1759's `provisionIsolatedShell` in a comment but does NOT formally import and call it. This is the divergence gap that T1821 will fix.

---

## Migration Plan

### Phase 1 — Create `packages/core/src/tools/sdk/` skeleton (T1815, MUST go first)

Create the following files (all re-export only, no logic movement):

```
packages/core/src/tools/sdk/
  isolation.ts         ← re-export provisionIsolatedShell, ISOLATION_ENV_KEYS, validateAbsolutePath from @cleocode/contracts
  tool-resolver.ts     ← re-export resolveToolCommand, CANONICAL_TOOLS from ../../tasks/tool-resolver.js
  tool-cache.ts        ← re-export runToolCached, acquireGlobalSlot from ../../tasks/tool-cache.js and ../../tasks/tool-semaphore.js
  manifest.ts          ← re-export pipelineManifestAppend from ../../memory/pipeline-manifest-sqlite.js
  spawn-primitives.ts  ← re-export buildAgentEnv, buildWorktreeSpawnResult from ../../spawn/branch-lock.js
  index.ts             ← barrel export of all above
```

Risk level: **LOW** — all re-exports, zero logic movement, no import path breakage.

### Phase 2 — WorktreeIsolation SDK Tool (T1817)

| Action | Risk |
|--------|------|
| Create `packages/core/src/tools/sdk/isolation.ts` | LOW — re-export from contracts |
| Update `packages/core/src/worktree/isolation.ts` to re-export from `tools/sdk/isolation.ts` | LOW — internal to core, same symbols |
| Update consumers in `orchestrate/spawn-ops.ts` and `orchestration/spawn-prompt.ts` to use `tools/sdk/isolation.ts` | LOW — same symbols, same signatures |
| T1822: Document that `packages/caamp/src/core/harness/pi.ts` already imports correctly from `@cleocode/contracts` | NONE — documentation only |
| T1821: Update `packages/adapters/src/providers/claude-code/spawn.ts` to formally import and call `provisionIsolatedShell` | MEDIUM — requires spawn logic change in adapters package |

### Phase 3 — ToolResolver + ToolCache SDK Tools (T1818)

| Action | Risk |
|--------|------|
| Create `packages/core/src/tools/sdk/tool-resolver.ts` | LOW — re-export |
| Create `packages/core/src/tools/sdk/tool-cache.ts` | LOW — re-export |
| Update `packages/core/src/validation/validate-ops.ts` to import from `tools/sdk/tool-resolver.ts` | LOW — same function signature |
| Leave `packages/core/src/tasks/evidence.ts` importing from `../../tasks/tool-resolver.js` (acceptable, same package) | NONE — internal coherence |

### Phase 4 — Manifest SDK Tool (T1819)

| Action | Risk |
|--------|------|
| Create `packages/core/src/tools/sdk/manifest.ts` re-exporting `pipelineManifestAppend` | LOW — re-export |
| Do NOT change the 28+ consumers yet — re-export barrel makes new path available without forcing migration | NONE |

### Files that MUST move (risk: MEDIUM+)

None. Per the T1768 decomposition decision (D2 default = re-export in place), no physical file relocations are required for Wave B. All promotions are re-export barriers, preserving every existing import path.

### Files that CAN stay

- `packages/core/src/tools/engine-ops.ts` — stays, Category C
- `packages/core/src/tools/index.ts` — stays, CAAMP management barrel
- `packages/core/src/tasks/tool-resolver.ts` — stays, re-export from sdk/ points here
- `packages/core/src/tasks/tool-cache.ts` — stays
- `packages/core/src/tasks/tool-semaphore.ts` — stays
- `packages/core/src/worktree/isolation.ts` — stays as intermediate re-export (may be updated to re-export from sdk/isolation.ts)
- `packages/core/src/spawn/branch-lock.ts` — stays
- `packages/core/src/memory/pipeline-manifest-sqlite.ts` — stays

---

## Open Questions for Owner

| # | Question | Context | Recommended Default |
|---|----------|---------|-------------------|
| Q1 | Should `packages/core/src/worktree/isolation.ts` be updated to re-export from `tools/sdk/isolation.ts` instead of from `@cleocode/contracts` directly, to create a single canonical path through the tools hierarchy? | Current: `worktree/isolation.ts` imports from `@cleocode/contracts`; new sdk path would be `tools/sdk/isolation.ts`. Two re-export hops might seem redundant but enforce the layering contract. | Keep `worktree/isolation.ts` as-is; let `tools/sdk/isolation.ts` also import from `@cleocode/contracts`. No one path enforced. |
| Q2 | Should `acquireGlobalSlot` be promoted alongside `runToolCached` into `tools/sdk/tool-cache.ts`, or stay internal to `packages/core/src/tasks/`? It has zero external consumers today. | Promotes it to the SDK surface even before external demand exists. | Include in `tool-cache.ts` SDK promotion for completeness — it is conceptually paired with `runToolCached`. |
| Q3 | Should the 5 manifest query functions (`pipelineManifestList`, `pipelineManifestShow`, etc.) also get re-export entry points in `tools/sdk/manifest.ts`, or only `pipelineManifestAppend`? | Query ops are more CLI-surface than SDK surface. | `pipelineManifestAppend` only — it is the ADR-027 write protocol used by subagents. Query ops remain Category C. |
| Q4 | T1821 (Claude Code adapter refactor) has MEDIUM risk. Should it be treated as a Wave C gating dependency on T1817 or as a separate cleanup task after Wave C? | The Claude Code adapter currently uses an inline worktree path without calling `provisionIsolatedShell`. | Wave C — after T1817 creates the isolation SDK Tool. Not gating for T1817 completion. |

---

## Summary Statistics

| Category | File Count in tools/ | Additional Candidates in core/ | Total |
|----------|---------------------|-------------------------------|-------|
| A (Agent Tool) | 0 (not created yet) | 0 (T1737 children create these) | 0 |
| B (SDK Tool) | 0 (not yet promoted) | 10 symbols across 5 source files | 10 symbols |
| C (Domain/CAAMP Mgmt) | 2 (`engine-ops.ts`, `index.ts`) | 5+ in tasks/, memory/, lifecycle/ | 7+ |
| D (Harness Internal) | 0 | 4 in adapters/, cleo-os/ | 4 |

The `packages/core/src/tools/` directory currently contains ONLY Category C files (CAAMP management operations, migrated in T1575/ENG-MIG-8). The `sdk/` and `agents/` sub-directories do not exist yet. T1815 creates `sdk/`; T1739 creates `agents/`.

---

## Key Findings

1. **Existing tools/ contains only Category C (CAAMP management).** `engine-ops.ts` and `index.ts` are the CAAMP skill/provider/adapter operations from ENG-MIG-8. They are NOT SDK Tools and NOT Agent Tools. They stay at the `tools/` root level permanently.

2. **Zero Category B files currently exist in tools/.** All SDK Tool candidates are in `tasks/` (`tool-resolver.ts`, `tool-cache.ts`, `tool-semaphore.ts`), `spawn/` (`branch-lock.ts`), `worktree/` (`isolation.ts`), and `memory/` (`pipeline-manifest-sqlite.ts`). The T1768 work is entirely about creating the `sdk/` sub-directory and providing re-export entry points.

3. **`provisionIsolatedShell` is already the best-placed SDK Tool** — it lives in `@cleocode/contracts` (zero-dep tier). PiHarness already imports it correctly. The Claude Code adapter does NOT yet call it formally — that is the T1821 gap.

4. **`pipelineManifestAppend` is the highest-impact SDK Tool** — 28+ consumers across all packages confirms it is a genuine cross-cutting primitive. The SDK promotion gives it a canonical `tools/sdk/manifest.ts` import path.

5. **No physical file moves required for Wave B.** The D2 default decision (re-export in place) means T1817–T1819 are purely additive — new re-export files in `tools/sdk/`, no import path breakage in any existing consumer.

6. **The three-meaning taxonomy in tools/ is now explicit:** `sdk/` = harness-agnostic infrastructure (Category B), `agents/` = LLM-callable tools (Category A, T1737's domain), root = CAAMP management (Category C). The existing root files remain untouched.
