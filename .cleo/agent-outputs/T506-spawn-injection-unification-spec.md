# Spawn Injection Unification — Architecture Specification

**Task**: T506 (parent epic)
**Date**: 2026-04-14
**Status**: Design spec — no implementation

---

## Problem Summary

Four independent paths inject context into spawned agents. They duplicate
logic, differ in what they inject, and leave a critical gap: Claude Code and
OpenCode spawned agents never receive the identity bootstrap that Pi agents
get. The result is inconsistent agent behavior depending on which harness
happens to be active.

---

## Current State: Call Chain Per Scenario

### Scenario A — Main Pi session agent startup

```
Pi runtime boots
  session_start handler (cleo-cant-bridge.ts:726)
    compileBundle() → bundlePrompt cached in module-level variable
    readMemoryBridge() → memoryBridgeContent cached

  before_agent_start handler (cleo-cant-bridge.ts:834)
    isMainAgent check (line 858) → YES
      CLI: cleo session briefing, cleo next, cleo memory find (via promisify+execFile)
      builds identityLines block (lines 879-964)
    appends bundlePrompt (compiled CANT, from session cache)
    appends memory bridge (from session cache)
    skips mental model (no agentDef.mentalModel on main agent)
```

Identity: PRESENT. CANT: PRESENT. Memory bridge: PRESENT. Mental model: absent (correct).

### Scenario B — Orchestrator spawning a Team Lead or Worker via Claude Code

```
cleo orchestrate spawn T#### (CLI)
  orchestrate.ts dispatch (packages/cleo/src/dispatch/domains/orchestrate.ts:380)
  orchestrateSpawnExecute() (orchestrate-engine.ts:476)
    prepareSpawn() — raw prompt from core (no CANT, no identity)
    composeSpawnPayload() when agentDef present (lines 557-592)
      CANT JIT context assembly: brain context sources + mental model
      composedPrompt replaces raw prompt
    CLEOSpawnContext built (line 594)
    adapter.spawn(cleoSpawnContext) called

  ClaudeCodeSpawnProvider.spawn() (claude-code/spawn.ts:71)
    buildCantEnrichedPrompt() (cant-context.ts:320)
      discoverCantFilesMultiTier() + compileBundle() — duplicates Pi session_start
      readMemoryBridge() — duplicates Pi session_start
      fetchMentalModelInjection() — duplicates composeSpawnPayload above
    writes enrichedPrompt to tmpFile, nodeSpawn('claude', ...)
```

Identity: ABSENT. CANT: compiled twice. Memory bridge: read twice. Mental
model: resolved twice (once in composeSpawnPayload, once in cant-context.ts).

### Scenario C — Direct `cleo agent spawn` invocation

Same path as Scenario B from `orchestrateSpawnExecute` onward.
Identity: ABSENT. Same duplication gaps.

### Scenario D — `cleo orchestrate spawn` prompt-only (buildPrompt path)

```
buildPrompt() (core/src/skills/orchestrator/spawn.ts:33)
  injectProtocol() (core/src/skills/injection/subagent.ts:162)
    skill content + subagent protocol base + task context
  returns string — no CANT, no identity, no memory bridge
```

This path builds a prompt string only. CANT enrichment is layered on top
later at adapter.spawn() time. The ordering is correct but implicit.

---

## Root Cause Analysis

| Gap | Root cause |
|-----|-----------|
| Identity absent for CC/OC agents | cleo-cant-bridge.ts:858 gates identity on Pi `agentName` event; cant-context.ts has no equivalent |
| CANT compiled twice | composeSpawnPayload (line 567) and buildCantEnrichedPrompt (line 327) each compile independently; no shared cache |
| Memory bridge read twice | Pi caches at session_start; cant-context.ts reads fresh per-spawn |
| composeSpawnPayload and cant-context overlap | Both assemble mental model; two code paths, one job |
| @-reference reliability | install.ts writes static strings to CLAUDE.md but provider parsing of @ notation is not guaranteed |

---

## Unified Architecture

### Design Principles

1. `buildCantEnrichedPrompt` in `packages/adapters/src/cant-context.ts` owns
   ALL enrichment beyond skill protocol content (identity, CANT, memory bridge,
   mental model).
2. Identity bootstrap is a new optional section in `buildCantEnrichedPrompt`,
   controlled by an `isMainAgent` flag in options.
3. The Pi bridge compiles the CANT bundle once at session_start and passes the
   pre-compiled string to `buildCantEnrichedPrompt`, bypassing recompilation.
4. `composeSpawnPayload` in orchestrate-engine.ts is removed; its mental model
   and BRAIN context responsibility transfers into `buildCantEnrichedPrompt`.
5. Skill protocol injection (`injectProtocol` in subagent.ts) remains upstream
   and unchanged — it is prompt content, not context enrichment.

### Before / After Diagram

```
BEFORE:

  Pi session_start   ──► compile bundle (module var)
  Pi before_agent_start ──► identityBlock
                           + bundlePrompt
                           + memBridge
                           + mentalModel (inline, ~140 lines)

  orchestrateSpawnExecute ──► prepareSpawn
                           ──► composeSpawnPayload (CANT JIT + BRAIN ctx)
                           ──► adapter.spawn(composedPrompt)
                                 ──► buildCantEnrichedPrompt
                                       CANT compile (again)
                                       memBridge (again)
                                       mentalModel (again)

  install.ts ──► CLAUDE.md @-refs (passive, unreliable)


AFTER:

  Pi session_start   ──► compile bundle → CantSessionCache

  Pi before_agent_start ──► buildCantEnrichedPrompt(
                               isMainAgent=true,
                               compiledBundle=CantSessionCache,
                               agentDef=event.agentDef
                             )

  orchestrateSpawnExecute ──► prepareSpawn
    [composeSpawnPayload removed]
                           ──► adapter.spawn(rawPrompt, agentDef in options)
                                 ──► buildCantEnrichedPrompt(
                                       isMainAgent=false,
                                       agentDef=context.options.agentDef
                                     )
                                       CANT bundle (compiled once here)
                                       memBridge (read once here)
                                       mentalModel (from agentDef)

  install.ts ──► CLAUDE.md @-refs (kept as passive fallback)
```

---

## Specific File Changes

### 1. `packages/adapters/src/cant-context.ts` — Primary expansion

**Extend `BuildCantEnrichedPromptOptions`** (currently line 48):
- Add `isMainAgent?: boolean` — when true, prepend identity bootstrap
- Add `compiledBundle?: string` — accept pre-compiled CANT prompt; skip discovery + compile steps 1–3
- Add `agentDef?: unknown` — passed to mental model guard (replaces the Pi-only `event.agentDef.mentalModel` check at cleo-cant-bridge.ts:986)

**Add `buildIdentityBootstrap(projectDir: string): Promise<string>`**:
- Ports Pi bridge lines 862–964 as a standalone async function
- Invokes `cleo session briefing --json`, `cleo next --json --limit 3`, `cleo memory find decision --json --limit 5` using promisify+execFile (matching the pattern already used at Pi bridge line 77)
- Assembles and returns the `===== CLEOOS IDENTITY BOOTSTRAP =====` block
- Best-effort: 8-second timeout per call, never throws, returns empty string on any failure

**Modify `buildCantEnrichedPrompt`** (line 320):
- Accept `compiledBundle` in options; if present, skip steps 1–3 and use it directly as the CANT block
- If `isMainAgent` is true, call `buildIdentityBootstrap(projectDir)` and prepend its output before the CANT block
- Pass `agentDef` presence check into `fetchMentalModelInjection` guard (line 366–374) rather than relying on callers to gate it externally

### 2. `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` — Shrink

**Delete `composeSpawnPayload` block** (lines 557–592):
- Remove the entire `try { const { composeSpawnPayload, brainContextProvider } ... } catch {}` block
- `composedPrompt` stays as `spawnContext.prompt` (raw skill protocol output)
- CANT enrichment happens once, uniformly, inside the adapter spawn provider

**Thread `agentDef` on CLEOSpawnContext** (line 594):
- Add `agentDef: spawnContext.agentDef` into `cleoSpawnContext.options`
- This propagates the agent definition from the spawn context to the adapter

### 3. `packages/adapters/src/providers/claude-code/spawn.ts` — Minor update

**Update `buildCantEnrichedPrompt` call** (lines 81–88):
- Add `agentDef: context.options?.agentDef`
- Add `isMainAgent: false` (explicit, documents intent)
- No other changes

### 4. `packages/adapters/src/providers/opencode/spawn.ts` — Mirror CC

Apply the same two additions at lines 172–177.

### 5. `packages/cleo-os/extensions/cleo-cant-bridge.ts` — Delegate

**Replace inline identity/CANT/bridge/mentalModel block** (lines 858–998 in `before_agent_start`):
- Import `buildCantEnrichedPrompt` from `@cleocode/adapters` via dynamic import (matching existing pattern for `@cleocode/cant` at line 751)
- Pass `isMainAgent: !event.agentName || event.agentName === ""`, `compiledBundle: bundlePrompt`, `agentDef: event.agentDef`
- Replaces ~140 lines of inline logic with a single call
- The module-level `bundlePrompt` variable and `session_start` compilation stay unchanged — the Pi bridge remains responsible for the compile-once cache

### 6. `packages/adapters/src/providers/claude-code/install.ts` — No change

@-references in CLAUDE.md remain as a passive fallback for human-in-the-loop
sessions. They are not the primary injection path and should not be removed.

---

## What Gets Deleted vs Refactored

| Item | Action | Location |
|------|--------|----------|
| `composeSpawnPayload` try/catch block | Delete | orchestrate-engine.ts:557–592 |
| Identity lines build + briefing calls | Delete | cleo-cant-bridge.ts:858–964 |
| Inline CANT/bridge/mentalModel append | Delete | cleo-cant-bridge.ts:967–998 |
| `BuildCantEnrichedPromptOptions` interface | Extend (additive, backward compat) | cant-context.ts:48 |
| `buildCantEnrichedPrompt` function | Extend with identity path + compiledBundle shortcut | cant-context.ts:320 |
| New `buildIdentityBootstrap` function | Add | cant-context.ts (new export) |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Identity bootstrap calls `cleo` subprocess; if not on PATH in spawned agent, calls fail silently | Low | Already best-effort with 8s timeout in Pi bridge; identical pattern applies |
| Removing `composeSpawnPayload` drops BRAIN `context_sources` assembly | Medium | The `context_sources` path was only active when `agentDef` was present; mental model now flows via `agentDef` through options into `buildCantEnrichedPrompt`. The net injection is equivalent. |
| Double-injection if Pi bridge and adapter both call `buildCantEnrichedPrompt` | Low | Pi bridge passes `compiledBundle` which skips discovery/compile; the memory bridge is idempotent (same content whether read once or twice). No duplication risk. |
| Breaking existing `BuildCantEnrichedPromptOptions` consumers | None | All new fields are optional; existing calls continue unchanged |
| `@cleocode/adapters` dependency in `cleo-cant-bridge.ts` (cleo-os package) | Medium | cleo-os already dynamically imports from `@cleocode/cant` (line 751); same dynamic import pattern applies for `@cleocode/adapters`. No compile-time dependency added. |

---

## Contracts Change Surface

- `packages/adapters/src/cant-context.ts` — `BuildCantEnrichedPromptOptions` gets 3 optional fields (additive, no breaking change)
- `CLEOSpawnContext.options` in `packages/contracts/src/` — already `Record<string, unknown>`; add inline comment noting `agentDef` as a recognized key
- No new packages, no new package.json dependencies
- No changes to `packages/core/src/skills/injection/subagent.ts` or `packages/core/src/skills/orchestrator/spawn.ts`

---

## Implementation Order

1. Extend `BuildCantEnrichedPromptOptions` and add `buildIdentityBootstrap` in cant-context.ts
2. Extend `buildCantEnrichedPrompt` to use all new options
3. Update CC spawn provider to pass `agentDef` and `isMainAgent: false`
4. Update OC spawn provider to match
5. Delete `composeSpawnPayload` block from orchestrate-engine.ts; thread `agentDef` on options
6. Refactor Pi bridge `before_agent_start` to delegate to `buildCantEnrichedPrompt`
7. Update unit tests in `packages/adapters/src/__tests__/cant-context.test.ts`
