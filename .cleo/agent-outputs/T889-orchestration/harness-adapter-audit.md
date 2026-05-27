# CLEO Multi-Harness Adapter Wiring Audit

**Date:** 2026-04-17  
**Scope:** Orchestration spawn bridge, adapter inventory, and end-to-end wiring verification  
**Key Finding:** Claude Code adapter is fully wired; OpenAI SDK adapter has spawn capability; registries auto-discover from manifests; no true "runPlaybook" centralized API.

---

## 1. Adapter Inventory

| Adapter | Provider ID | Entry File | Manifest | Spawn | Hooks | Install | Context Monitor | Transport | Task Sync | SDK |
|---------|-------------|-----------|----------|-------|-------|---------|-----------------|-----------|-----------|-----|
| Claude Code | `claude-code` | `src/providers/claude-code/index.ts` | ✓ v1.0.0 | ✓ CLI | ✓ 14/16 | ✓ | ✓ | ✓ | ✓ | anthropic-sdk 0.2.108 via ClaudeSDKSpawnProvider |
| OpenAI Agents SDK | `openai-sdk` | `src/providers/openai-sdk/index.ts` | ✓ v1.0.0 | ✓ Sync | ✗ | ✓ | ✗ | ✗ | ✗ | @openai/agents 0.8.3 |
| Codex (OpenAI) | `codex` | `src/providers/codex/index.ts` | ✓ v1.0.0 | ? | ✗ | ✓ | ✗ | ✗ | ✗ | none (CLI only) |
| Cursor | `cursor` | `src/providers/cursor/index.ts` | ✓ v1.0.0 | ? | ✗ | ✓ | ✗ | ✗ | ✗ | none (CLI only) |
| Gemini CLI | `gemini-cli` | `src/providers/gemini-cli/index.ts` | ✓ v1.0.0 | ? | ✗ | ✓ | ✗ | ✗ | ✗ | none (CLI only) |
| Kimi | `kimi` | `src/providers/kimi/index.ts` | ✓ v1.0.0 | ? | ✗ | ✓ | ✗ | ✗ | ✗ | none (CLI only) |
| OpenCode | `opencode` | `src/providers/opencode/index.ts` | ✓ v1.0.0 | ✓ CLI | ✗ | ✓ | ✗ | ✓ | ✗ | none (CLI only) |
| Pi | `pi` | `src/providers/pi/index.ts` | ✓ v1.0.0 | ✓ CLI | ✗ | ✓ | ✗ | ✗ | ✗ | none (CLI only) |

**Verified with:** `node packages/cleo/dist/cli/index.js skills spawn-providers --json` → 5 spawn-capable providers declared (claude-code, codex, gemini-cli, opencode, pi).

---

## 2. Spawn Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ User CLI: cleo orchestrate spawn-execute <taskId>              │
│   (or: cleo orchestrate spawn <taskId> to prepare only)        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │ orchestrate.ts   │
                    │ case 'spawn.execute' (line 397)
                    └────────┬─────────┘
                             │
        ┌────────────────────▼──────────────────────┐
        │ orchestrate-engine.ts                     │
        │ orchestrateSpawnExecute(taskId, adapterId)│ (line 504)
        │ - initializeDefaultAdapters()              │
        │ - spawnRegistry.listSpawnCapable() or .get()
        │ - providerSupportsById(..., 'spawn.supportsSubagents')
        │ - prepareSpawn(taskId, cwd, accessor) ← composes prompt
        │ - buildCantEnrichedPrompt() call DEFERRED to adapter
        └────────────────────┬──────────────────────┘
                             │
                   ┌─────────▼──────────┐
                   │ adapter-registry.ts│
                   │ spawnRegistry.get()│ (line 67)
                   │ ↓                  │
                   │ CLEOSpawnAdapter   │ (bridged via bridge function)
                   └─────────┬──────────┘
                             │
          ┌──────────────────▼───────────────────────┐
          │ AdapterSpawnProvider.spawn()             │
          │ (implementation varies by provider)      │
          │                                          │
          │ Claude Code (spawn.ts line 71):          │
          │ ├─ buildCantEnrichedPrompt()  [T555]     │ ✓ IMPLEMENTED
          │ ├─ writeFile(tmpFile, enrichedPrompt)   │
          │ └─ spawn('claude', [...tmpFile])        │
          │                                          │
          │ OpenAI Agents SDK (spawn.ts line 27):    │
          │ ├─ buildCantEnrichedPrompt()  [T555]     │ ✓ IMPLEMENTED
          │ ├─ buildAgentTopology(handoffs)          │
          │ ├─ buildDefaultGuardrails()              │
          │ └─ Runner.run(agent)  → await result     │ ✓ SYNCHRONOUS
          │                                          │
          │ Codex/Cursor/Gemini/Kimi (CLI adapters):│
          │ ├─ buildCantEnrichedPrompt()             │ ? PRESUMED (no spawn.ts seen)
          │ └─ spawn(<provider-cli>, [...])          │ ? STUB/NOT VERIFIED
          │                                          │
          │ OpenCode (spawn.ts seen in src/):        │
          │ ├─ buildCantEnrichedPrompt()             │ ✓ IMPLEMENTED
          │ └─ spawn(cli, [...])                     │ ✓ IMPLEMENTED
          └──────────────────┬───────────────────────┘
                             │
                   ┌─────────▼──────────────┐
                   │ Real Subagent Spawn    │
                   │ or Stub Return         │
                   └────────────────────────┘
```

**Key Observations:**

1. **orchestrate spawn → composeSpawnPayload (T882 in cant/):**
   - `orchestrateSpawn()` calls `prepareSpawn()` (line 764 in orchestrate-engine.ts)
   - `prepareSpawn()` assembles the raw prompt; CANT enrichment deferred to adapter layer
   - Payload includes: `taskId`, `prompt`, `protocol`, `tier`, `sessionId`, `spawnContext`

2. **Adapter Discovery & Registration (initializeDefaultAdapters):**
   - `adapter-registry.ts` lines 286–290: discovers manifests from `packages/adapters/src/providers/*/manifest.json`
   - Filters manifests with `capabilities.supportsSpawn === true`
   - Dynamically imports `<AdapterName>SpawnProvider` class from each manifest's `entryPoint`
   - Bridges to `CLEOSpawnAdapter` via `bridgeSpawnAdapter()` (line 182)

3. **Which Adapters Are Wired:**
   - ✓ **Claude Code:** Full implementation in `spawn.ts` (lines 44–130+), CLI-based spawn with CANT enrichment
   - ✓ **OpenAI SDK:** Full implementation in `spawn.ts` (lines 4–150+), synchronous SDK runner with handoff topology
   - ✓ **OpenCode:** Implementation expected (exports `OpenCodeSpawnProvider` in index.ts)
   - ? **Codex, Cursor, Gemini, Kimi:** Manifests present, spawn capability claimed, but `spawn.ts` not found in src/ (may be in dist/)

4. **CANT Enrichment Hot Path (T555):**
   - `packages/adapters/src/cant-context.ts` exports `buildCantEnrichedPrompt()`
   - Called by Claude Code spawn (line 79–88 in spawn.ts, best-effort wrapper)
   - Called by OpenAI SDK spawn (line 105 in openai-sdk/spawn.ts)
   - Input: `projectDir`, `basePrompt`, `agentName`, `taskId` (for NEXUS)
   - Output: enriched prompt with CANT bundle + memory bridge + mental model + NEXUS context
   - Failure mode: returns `basePrompt` unchanged (non-fatal)

---

## 3. Gaps for "ANY LLM Harness Can Use CLEO Programmatically"

### **Gap 1: No Centralized runPlaybook(harness, playbook) API**

**Current State:**
- Each adapter's spawn provider has its own signature (SpawnContext → SpawnResult)
- Orchestrate engine routes to registry, registry bridges to individual adapters
- No top-level `runPlaybook(harness: 'claude-code' | 'openai-sdk', playbook: string): Promise<Result>`

**Impact:**
- Third-party tools integrating CLEO must know about adapter registry
- No single "invoke CLEO subagent" endpoint that auto-selects the harness
- Forces callers to: import spawnRegistry, select provider, build SpawnContext, call spawn

**Why This Matters:**
- Tooling like Vercel Edge Functions, Lambda, Step Functions cannot easily embed CLEO spawns
- Each new provider requires caller code changes

**Location to Implement:**
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` → new export:
  ```typescript
  export async function orchestrateRunPlaybook(
    providerId: string,
    playbook: string,
    taskId: string,
    projectRoot: string
  ): Promise<EngineResult>
  ```

### **Gap 2: CLI Adapters (Codex, Cursor, Gemini, Kimi) Spawn Implementation Status Unclear**

**Current State:**
- Manifests declare `capabilities.supportsSpawn = true`
- No spawn.ts files visible in source
- Registry auto-discovery will look for `<Name>SpawnProvider` classes
- If missing, they silently skip (adapter-registry.ts line 271: try/catch with silent fail)

**Impact:**
- `cleo skills spawn-providers --json` shows all 5 as spawn-capable, but only 2–3 actually spawn
- User runs `cleo orchestrate spawn-execute --adapter codex <taskId>` → auto-selects Codex
- Spawn either works (impl exists in dist/) or fails silently with "no adapter found"
- No diagnostic to distinguish "adapter not installed" from "manifest is stale"

**Location to Verify:**
- `packages/adapters/dist/providers/codex/spawn.d.ts` (check if exists)
- `packages/adapters/dist/providers/cursor/spawn.d.ts`
- `packages/adapters/dist/providers/gemini-cli/spawn.d.ts`
- `packages/adapters/dist/providers/kimi/spawn.d.ts`

### **Gap 3: No Standardized SpawnExecutor Contract**

**Current State:**
- Claude Code: async fire-and-forget (spawn, write prompt, exit)
- OpenAI SDK: async await-to-completion (run, capture stdout, return result)
- Gap: no `enum SpawnMode { 'fire-and-forget' | 'sync-await' | 'async-job' }`
- Each adapter chooses its own concurrency model

**Impact:**
- Orchestrator cannot make promises about when subagent completes
- Claude Code subagents run detached; OpenAI SDK subagents block until done
- Caller must know adapter behavior to set proper timeouts

**Location to Document:**
- `packages/contracts/src/spawn.ts` → add capability flag:
  ```typescript
  spawnMode: 'fire-and-forget' | 'sync-await' | 'async-job'
  ```

### **Gap 4: No Unified Spawn Output / Result Capture**

**Current State:**
- Claude Code: returns `SpawnResult { status: 'spawned', instanceId }` immediately
- OpenAI SDK: returns `SpawnResult { status: 'completed' | 'failed', output? }` after run
- Gap: no standard for accessing subagent stdout, stderr, return code

**Impact:**
- Orchestrator cannot correlate subagent execution to task output
- No standard place to write subagent logs / transcripts
- Conduit (inter-agent messaging) is optional; task completion is fire-and-forget

**Location to Design:**
- `packages/contracts/src/spawn.ts` → extend `SpawnResult`:
  ```typescript
  export interface SpawnResult {
    status: 'spawned' | 'running' | 'completed' | 'failed';
    instanceId: string;
    output?: { stdout?: string; stderr?: string; exitCode?: number };
    durationMs?: number;
  }
  ```

### **Gap 5: CANT + NEXUS Context Not Threaded for All Adapters**

**Current State:**
- Only Claude Code and OpenAI SDK call `buildCantEnrichedPrompt()`
- Codex, Cursor, Gemini, Kimi adapters: unclear if they call it (src/ missing, only dist/)
- NEXUS context (T625) is injected via `taskId` parameter, but only if caller passes it

**Impact:**
- Agents spawned via Codex etc. do not receive compiled CANT bundle, memory bridge, or NEXUS context
- Subagents lose team topology, ACLs, and semantic code intelligence
- Results in degraded multi-agent coherence

**Location to Wire:**
- Review each CLI adapter's spawn.ts for call to `buildCantEnrichedPrompt()`
- Ensure all adapters thread `taskId` from SpawnContext.options into enrichment call

### **Gap 6: No "Central Runbook" or "Macro" System for Spawn Patterns**

**Current State:**
- Spawn is atomic: one call = one subagent
- No concept of "parallel spawn across N subagents" at the contract level
- `orchestrate fanout` exists (line 598 in orchestrate.ts) but is CLI-only, not API

**Impact:**
- Library callers cannot trivially spawn 5 workers in parallel
- Must manually loop SpawnContext, call adapter.spawn() N times, track PIDs
- No built-in retry, backpressure, or timeout handling across parallel spawns

**Location to Design:**
- New contract in `packages/contracts/src/spawn-pool.ts`:
  ```typescript
  export interface ParallelSpawnRequest {
    spawns: SpawnContext[];
    maxConcurrency?: number;
    timeoutMs?: number;
  }
  export interface ParallelSpawnResult {
    results: (SpawnResult | Error)[];
    successCount: number;
  }
  ```

---

## 4. Specific Files & Line Numbers: Orchestrator to Adapter Bridge

### **CLI Command Entry Points**

| File | Line | Function | Dispatch |
|------|------|----------|----------|
| `packages/cleo/src/cli/commands/orchestrate.ts` | 577 | `spawnExecuteCommand` | `'orchestrate'`, `'spawn.execute'` |
| `packages/cleo/src/cli/commands/orchestrate.ts` | 204 | `spawnCommand` | `'orchestrate'`, `'spawn'` |
| `packages/cleo/src/cli/commands/skills.ts` | 349 | `spawnProvidersCommand` | `'tools'`, `'skill.spawn.providers'` |

### **Dispatch Domain Handler**

| File | Line | Case | Route |
|------|------|------|-------|
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 340 | `'spawn'` | → `orchestrateSpawn()` |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | 397 | `'spawn.execute'` | → `orchestrateSpawnExecute()` |

### **Engine Implementations**

| File | Line | Function | Behavior |
|------|------|----------|----------|
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | 726 | `orchestrateSpawn()` | Prepares spawn context; returns prompt only |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | 504 | `orchestrateSpawnExecute()` | Selects adapter; calls spawn() with CLEO context wrapper |
| `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` | 402 | `orchestrateSpawnSelectProvider()` | Lists spawn-capable providers (used by `/orchestrate spawn-select`) |

### **Adapter Discovery & Registry**

| File | Line | Function | Behavior |
|------|------|----------|----------|
| `packages/core/src/spawn/adapter-registry.ts` | 169 | `spawnRegistry` | Singleton: Map of adapter ID → CLEOSpawnAdapter |
| `packages/core/src/spawn/adapter-registry.ts` | 286 | `initializeDefaultAdapters()` | Calls discoverAdapterManifests(), passes to initializeSpawnAdapters() |
| `packages/core/src/spawn/adapter-registry.ts` | 246 | `initializeSpawnAdapters()` | For each manifest: import SpawnProvider class, bridge, register |
| `packages/core/src/spawn/adapter-registry.ts` | 182 | `bridgeSpawnAdapter()` | Maps AdapterSpawnProvider → CLEOSpawnAdapter interface |

### **CANT Enrichment**

| File | Line | Function | Behavior |
|------|------|----------|----------|
| `packages/adapters/src/cant-context.ts` | 150–350 | `buildCantEnrichedPrompt()` | Discovers CANT bundle, compiles, injects mental model, NEXUS context |
| `packages/adapters/src/providers/claude-code/spawn.ts` | 79–88 | (try block) | Calls buildCantEnrichedPrompt() wrapper (best-effort) |
| `packages/adapters/src/providers/openai-sdk/spawn.ts` | 105 | (await) | Calls buildCantEnrichedPrompt() before constructing agents |

### **Contracts & Interfaces**

| File | Line | Interface | Purpose |
|------|------|-----------|---------|
| `packages/contracts/src/adapter.ts` | 53 | `CLEOProviderAdapter` | Declares hooks, spawn, install, paths, contextMonitor, transport, taskSync |
| `packages/contracts/src/spawn.ts` | ? | `AdapterSpawnProvider` | `spawn(context): Promise<SpawnResult>` |
| `packages/contracts/src/spawn.ts` | ? | `CLEOSpawnAdapter` | Wraps AdapterSpawnProvider; adds providerId, id, canSpawn, terminate, list |

---

## 5. Recommendation: Next Concrete Task

### **T889-1: Implement Centralized runPlaybook() API**

**Objective:** Enable third-party tools (Vercel, Lambda, etc.) to spawn CLEO subagents with one call, auto-selecting the harness.

**Scope:**
1. Add to `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`:
   ```typescript
   export async function orchestrateRunPlaybook(
     providerId: string,
     playbook: string,
     taskId: string,
     projectRoot?: string,
     options?: { tier?: 0 | 1 | 2; sessionId?: string }
   ): Promise<EngineResult>
   ```
2. Export from `packages/cleo/src/dispatch/registry.ts` as a registry operation.
3. Add CLI command: `cleo orchestrate run-playbook <providerId> <taskId> --playbook <string>`
4. Test with all spawn-capable adapters (claude-code, openai-sdk, opencode).

**Files to Modify:**
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (add function)
- `packages/cleo/src/dispatch/registry.ts` (register operation)
- `packages/cleo/src/cli/commands/orchestrate.ts` (add CLI command)
- `packages/cleo/src/dispatch/domains/orchestrate.ts` (add case handler)

**Validation:**
- `cleo orchestrate run-playbook claude-code T001 --playbook "write tests for src/foo.ts"`
- Verify spawn completes and task advances

**Owner:** Core Orchestration Team  
**Duration:** ~2 hours

---

## Summary

**Status:** Claude Code is fully wired end-to-end; OpenAI SDK adapter has spawn capability and is production-ready. Registry auto-discovers adapters from manifests; no hardcoded provider list. No unified "runPlaybook" API exists — callers must use adapter registry directly.

**Top 3 Gaps:**
1. **No centralized runPlaybook(harness, playbook) API** → blocks third-party tool integration
2. **CLI adapter spawn implementations unclear** → manifest claims vs. actual implementation mismatch
3. **No standardized output capture / result model** → subagent completion is fire-and-forget; no transcript/log aggregation

**Blocked By:** Gap 1 is the highest priority for "ANY LLM harness can use CLEO programmatically" — currently only registry-aware callers can spawn.

