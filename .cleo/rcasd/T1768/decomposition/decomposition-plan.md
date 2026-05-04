# T1768 Decomposition Plan
# Define Cleo Core SDK 'Tools' Surface

**Date**: 2026-05-04  
**Agent**: Decomposition subagent  
**Session**: ses_20260504150259_e03b6d (orchestrator) / ses_20260504183836_0d8b40 (worktree context)

---

## Summary

T1768 decomposes into 9 child tasks (T1814–T1822) organized in 4 waves. The decomposition first
resolves the T1768 vs T1737 scope ambiguity, defines a formal taxonomy, then implements it
incrementally. No implementation begins until the ADR and audit are complete.

---

## T1737 vs T1768 Alignment Matrix

| Dimension | T1737 (CleoOS Harness v3) | T1768 (SDK Tools Surface) | Relationship |
|-----------|--------------------------|--------------------------|--------------|
| Sense of "tools" | Category A: Agent Tools (60+ LLM-callable actions) | Category B: SDK Tools (harness-agnostic infra utilities) | ORTHOGONAL — not competing |
| Location in codebase | `packages/core/src/tools/agents/` (new, per T1739) | `packages/core/src/tools/sdk/` (new) | DIFFERENT sub-directories |
| Key tasks | T1739 AgentToolRegistry, T1740 dispatch, T1741-T1743 executors | T1814 audit, T1815 sdk/ dir, T1817-T1819 promotions | No overlap |
| Dependency direction | T1737 children (T1739+) CAN consume SDK Tools from T1768 | T1768 substrate is usable by T1737 | T1768 FIRST |
| Should T1768 close as duplicate? | No | No | Both required |
| Owner decision needed? | No — T1737 proceeds independently | Yes — 4 D-decisions (see ADR draft) | D1-D4 in ADR |

**Conclusion**: T1768 is NOT a duplicate of T1737. The two epics occupy different sub-directories
and different conceptual layers. T1768 ships the `tools/sdk/` substrate; T1737's children will
optionally consume it. Recommended order: T1768 Wave A+B FIRST, then T1737 Wave 1 (T1738+T1739).

---

## Existing Primitives Audit (pre-decomposition discovery)

### Classified as SDK Tool (Category B) — Promote/Expose

| Symbol | Current Location | Notes |
|--------|-----------------|-------|
| `provisionIsolatedShell` | `packages/contracts/src/branch-lock.ts` | Already in contracts (pure, no I/O). Re-export from `tools/sdk/isolation.ts`. |
| `ISOLATION_ENV_KEYS` | `packages/contracts/src/branch-lock.ts` | Same — re-export with isolation.ts. |
| `resolveToolCommand` | `packages/core/src/tasks/tool-resolver.ts` | Project-agnostic resolution. Re-export from `tools/sdk/tool-resolver.ts`. |
| `CANONICAL_TOOLS` | `packages/core/src/tasks/tool-resolver.ts` | Paired with resolveToolCommand. |
| `runToolCached` | `packages/core/src/tasks/tool-cache.ts` | Memoized tool execution, project-agnostic. |
| `pipelineManifestAppend` | `packages/core/src/internal.ts` (re-export) | ADR-027 SQLite write. Re-export from `tools/sdk/manifest.ts`. |
| `buildAgentEnv` | `packages/core/src/spawn/branch-lock.ts` | Spawn env construction, harness-agnostic. Candidate. |
| `buildWorktreeSpawnResult` | `packages/core/src/spawn/branch-lock.ts` | Spawn result construction. Candidate. |

### Classified as Domain Utility (Category C) — Leave in Place

| Symbol | Current Location | Reason |
|--------|-----------------|--------|
| `recordEvidence` (RCASD) | `packages/core/src/lifecycle/evidence.ts` | SQLite-backed, lifecycle domain |
| `RateLimiter` | `packages/core/src/security/input-sanitization.ts` | Security domain, not cross-harness |
| Hook dispatch (`hooks.dispatch`) | `packages/core/src/hooks/registry.ts` | Hooks domain |
| LAFS envelope helpers | `packages/core/src/error-catalog.ts` (type imports) | Protocol conformance domain |
| Conduit transport | `packages/core/src/conduit/` | Messaging domain |

### Classified as CAAMP Skill/Provider Management (Category C) — Leave in tools/

| Symbol | Current Location | Reason |
|--------|-----------------|--------|
| `toolsSkillList`, `toolsProviderList`, `toolsAdapterActivate`, etc. | `packages/core/src/tools/engine-ops.ts` | CAAMP provider/adapter/skill operations (ENG-MIG-8 / T1575). NOT harness utilities. Already in tools/ but represent a 3rd meaning — CAAMP management operations. |

### Already Classified: Agent Tool (Category A) — T1737 owns

| Concept | T1737 Task |
|---------|-----------|
| terminal, file, git tools | T1741 |
| web search, browser tools | T1742 |
| memory, vision, cron, MCP tools | T1743 |
| AgentToolRegistry | T1739 |
| Tool dispatch engine | T1740 |

### Classified as Harness Internal (Category D) — Leave in harness packages

| Symbol | Package | Reason |
|--------|---------|--------|
| `PiCodingAgentAdapter` | `packages/cleo-os/` | Pi-specific process management |
| `ClaudeCodeSpawnProvider` | `packages/adapters/src/providers/claude-code/` | Claude CLI-specific |
| `ClaudeSDKSpawnProvider` | `packages/adapters/src/providers/claude-sdk/` | Vercel AI SDK-specific |
| `DEFAULT_TOOLS` (tool-bridge.ts) | `packages/adapters/src/providers/claude-sdk/` | Claude SDK tool allowlist, sdk-specific |

---

## Child Tasks Created

| ID | Title | Size | Priority | Wave |
|----|-------|------|----------|------|
| T1814 | Audit and classify all SDK Tool candidates across packages/core/ | medium | high | A |
| T1815 | Define packages/core/src/tools/sdk/ directory — interfaces and barrel index | small | high | A |
| T1816 | Write ADR-063: SDK Tools taxonomy | small | high | A |
| T1817 | Promote WorktreeIsolation to SDK Tool | small | high | B |
| T1818 | Promote ToolResolver+ToolCache to SDK Tool | small | medium | B |
| T1819 | Promote pipelineManifestAppend to SDK Tool | small | medium | B |
| T1820 | Write docs/architecture/sdk-tools.md | small | medium | C |
| T1821 | Refactor ClaudeCodeSpawnProvider to consume SDK Tools | small | medium | C |
| T1822 | Verify PiHarness SDK Tool consumption is complete | small | low | C |

---

## Dependency Graph

```
T1814 (audit)
  └── T1815 (sdk/ dir)
        ├── T1816 (ADR-063)
        │     ├── T1817 (isolation SDK Tool)  ←── T1821 (claude-code refactor)
        │     │                               ←── T1822 (piharness verify)
        │     ├── T1818 (tool-resolver SDK Tool)
        │     └── T1819 (manifest SDK Tool)
        └── T1820 (docs) [depends: T1817+T1818+T1819+T1816]
```

---

## Wave Execution Order

### Wave A (research/definition — can start immediately, parallel safe)
- T1814: Audit candidates
- T1815: Define sdk/ directory (depends T1814)
- T1816: Write ADR-063 (depends T1814 + T1815)

### Wave B (implementation — after Wave A)
Parallel-safe within the wave:
- T1817: WorktreeIsolation promotion (depends T1815 + T1816)
- T1818: ToolResolver+ToolCache promotion (depends T1815 + T1816)
- T1819: ManifestAppend promotion (depends T1815 + T1816)

### Wave C (integration + docs — after Wave B)
Parallel-safe within the wave:
- T1820: Write docs/architecture/sdk-tools.md (depends T1816+T1817+T1818+T1819)
- T1821: ClaudeCode refactor (depends T1817)
- T1822: PiHarness verify (depends T1817)

---

## Owner Decisions Required (BLOCKING for Wave B)

The following MUST be resolved by owner before Wave B begins. Defaults are safe to proceed with
if owner does not respond, but explicit confirmation is preferred:

| # | Decision | Default |
|---|----------|---------|
| D1 | New `sdk/` sub-dir vs re-export barrel pointing to current locations | New `tools/sdk/` sub-dir (clean separation) |
| D2 | Physical relocation of `resolveToolCommand`/`runToolCached` vs re-export in place | Re-export in place (T1818 uses re-exports, avoids import path migration) |
| D3 | T1768 or T1739 owns `tools/agents/` directory skeleton | T1739 owns it entirely; T1768 only touches `tools/sdk/` |
| D4 | ADR number confirmation | ADR-063 |

---

## ADR Draft Location

`/mnt/projects/cleocode/.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md`

(Worktree path: `.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md`)

The formal ADR (task T1816) should be written to `docs/adr/ADR-063-sdk-tools-surface.md` once
owner decisions D1-D4 are confirmed.

---

## Key Findings

1. T1737 and T1768 are orthogonal — DO NOT close T1768 as duplicate. T1737 = Agent Tools
   (Category A); T1768 = SDK Tools (Category B).

2. The existing `packages/core/src/tools/` directory already has a 3rd meaning beyond A and B:
   CAAMP skill/provider/adapter management (engine-ops.ts, T1575/ENG-MIG-8). The taxonomy adds
   `sdk/` and `agents/` sub-directories without disrupting the existing root-level exports.

3. `provisionIsolatedShell` is ALREADY correctly placed in `packages/contracts/` (pure function,
   no I/O). T1768 just needs to create the re-export entry point in `tools/sdk/isolation.ts`.
   WorktreeIsolation is the easiest first SDK Tool promotion.

4. The Claude Code adapter (`packages/adapters/src/providers/claude-code/spawn.ts`) partially
   consumed the T1759 fix via a comment reference, but does not formally import from the SDK Tools
   surface. T1821 corrects this.

5. The CAAMP PiHarness (`packages/caamp/src/core/harness/pi.ts`) already imports
   `provisionIsolatedShell` from `@cleocode/contracts` directly — it is already correct per T1759.
   T1822 only adds TSDoc documentation and verifies no regression.

6. No new packages should be created. `packages/core/src/tools/sdk/` is a sub-directory, not a
   new package. The `packages/contracts/` package already holds the zero-dep pure functions.
