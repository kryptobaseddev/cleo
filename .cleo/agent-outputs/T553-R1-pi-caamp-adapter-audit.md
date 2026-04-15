# Pi / CAAMP / Adapter Architecture Audit

**Task**: T553-R1
**Date**: 2026-04-13
**Auditor**: claude-sonnet-4-6 (cleo-prime subagent)
**Status**: complete

---

## 1. Pi Integration Architecture

### 1.1 How CleoOS Wraps Pi

```
User invokes: cleoos [pi-args...]
        |
        v
packages/cleo-os/src/cli.ts
  - resolveCleoOsPaths()       → ~/.local/share/cleo/extensions/
  - collectExtensionPaths()    → cleo-cant-bridge.js, cleo-agent-monitor.js
  - buildArgs()                → injects --extension <path> flags before user args
        |
        v
@mariozechner/pi-coding-agent (peerDep)
  piMain([--extension cleo-cant-bridge.js, --extension cleo-agent-monitor.js, ...user-args])
        |
        v
Pi runtime loads extensions via ExtensionAPI
  extension(pi: ExtensionAPI) => pi.on("session_start", ...), pi.on("before_agent_start", ...)
```

**Key facts:**
- CleoOS is a THIN LAUNCHER. It does not implement Pi's ExtensionAPI — it calls Pi's own `main()` with injected `--extension` flags.
- Extensions are pre-compiled `.js` files at `~/.local/share/cleo/extensions/` (XDG data dir).
- The `PI_CODING_AGENT_DIR` env var overrides Pi's state root (used by `PiHarness`).
- Pi's filesystem layout honoured by the harness: global=`~/.pi/agent/`, project=`.pi/`.

### 1.2 Pi ExtensionAPI Surface Used

CAAMP registers on these Pi-native events in `cleo-cant-bridge.ts`:

| Pi Native Event     | Handler Purpose |
|---------------------|-----------------|
| `session_start`     | Discover + compile 3-tier `.cant` files; render TUI banner |
| `before_agent_start`| APPEND CANT bundle to system prompt; inject mental-model observations |
| `tool_call`         | Enforce lead-blocking (E_LEAD_TOOL_BLOCKED) and worker path ACLs (E_WORKER_PATH_ACL_VIOLATION) |
| `session_shutdown`  | Clear cached bundle state |

In `cleo-agent-monitor.ts`:

| Pi Native Event     | Handler Purpose |
|---------------------|-----------------|
| `session_start`     | Initialize agent activity widget |
| `before_agent_start`| Track agent spawns with tier-aware prefixes |
| `session_shutdown`  | Clear activity ring buffer |

Commands registered via `pi.registerCommand()`:
- `/cant:bundle-info` — CANT bundle diagnostic introspection
- `/cleo:agents` — TUI agent activity panel
- `/cleo:circle` — Circle of Ten status (calls `cleo dash --json` and `cleo session status --json`)

### 1.3 How Pi Gets Memory Context

Memory injection for Pi uses TWO paths:

**Path A — Static file injection (AGENTS.md)**:
- `PiHarness.injectInstructions()` writes a CAAMP marker block into `AGENTS.md` (project root) or `~/.pi/agent/AGENTS.md` (global).
- `AGENTS.md` is auto-discovered by Pi from the cwd upward.
- The memory-bridge.md is `@`-referenced from AGENTS.md via the CAAMP injection chain.

**Path B — Dynamic injection at session start**:
- `cleo-cant-bridge.ts` on `before_agent_start` calls `memoryFind()` (from `@cleocode/core`) to fetch agent-scoped prior observations from brain.db.
- These are injected as a `VALIDATE_ON_LOAD_PREAMBLE` block into Pi's system prompt.
- This only fires when the spawned agent's CANT definition has a `mentalModel:` block.

**Path C — JIT (mid-session)**:
- Pi agents can call `cleo memory find`, `cleo memory fetch`, etc. as CLI tools via Pi's `Bash` tool.
- This is the standard CLEO CLI pattern — no Pi-specific integration required.

---

## 2. CAAMP Hook Taxonomy (31 Canonical Events)

### 2.1 Provider Events (16 total — source: provider)

| Event | Category | canBlock | Description |
|-------|----------|----------|-------------|
| SessionStart | session | false | Session begins, resumes, or is cleared |
| SessionEnd | session | false | Session terminates or exits |
| PromptSubmit | prompt | **true** | User submits a prompt, before agent processes it |
| ResponseComplete | prompt | false | Agent finishes responding to a turn |
| PreToolUse | tool | **true** | Before a tool call executes (can block/modify) |
| PostToolUse | tool | false | After a tool call succeeds |
| PostToolUseFailure | tool | false | After a tool call fails or times out |
| PermissionRequest | tool | **true** | Permission dialog appears for a tool action |
| SubagentStart | agent | **true** | A subagent is spawned |
| SubagentStop | agent | false | A subagent finishes execution |
| PreModel | agent | **true** | Before sending a request to the LLM |
| PostModel | agent | false | After receiving an LLM response |
| PreCompact | context | false | Before context window compaction |
| PostCompact | context | false | After context window compaction completes |
| Notification | context | false | System notification or alert is emitted |
| ConfigChange | context | false | Configuration file changes during a session |

### 2.2 Domain Events (15 total — source: CLEO CLI operations)

| Event | Category | Domain Operation |
|-------|----------|-----------------|
| TaskCreated | task | tasks.add (post) |
| TaskStarted | task | tasks.start (post) |
| TaskCompleted | task | tasks.complete (post) |
| TaskBlocked | task | tasks.update (post) |
| MemoryObserved | memory | memory.observe (post) |
| MemoryPatternStored | memory | memory.store (post) |
| MemoryLearningStored | memory | memory.store (post) |
| MemoryDecisionStored | memory | memory.store (post) |
| PipelineStageCompleted | pipeline | pipeline.validate (post) |
| PipelineManifestAppended | pipeline | pipeline.append (post) |
| SessionStarted | session | session.start (post) |
| SessionEnded | session | session.end (post) |
| ApprovalRequested | session | session.suspend (post) |
| ApprovalGranted | session | session.resume (post) |
| ApprovalExpired | session | session.suspend (post) |

**NOTE**: Domain events are fired by the CLEO CLI itself — they are not translatable to provider-native events. The normalizer's `getSupportedEvents()` / `PROVIDER_HOOK_EVENTS` explicitly excludes domain events from cross-provider matrix comparisons.

---

## 3. Per-Adapter Hook Support Matrix

All 16 provider-sourced canonical events vs. each registered provider:

| Canonical Event | claude-code | gemini-cli | opencode | cursor | codex | kimi | Pi (gap) |
|----------------|:-----------:|:----------:|:--------:|:------:|:-----:|:----:|:--------:|
| SessionStart | YES | YES | YES | YES | YES | NO | **MISSING** |
| SessionEnd | YES | YES | YES | YES | NO | NO | **MISSING** |
| PromptSubmit | YES | YES | YES | YES | YES | NO | **MISSING** |
| ResponseComplete | YES | YES | YES | YES | YES | NO | **MISSING** |
| PreToolUse | YES | YES | YES | YES | NO | NO | **MISSING** |
| PostToolUse | YES | YES | YES | YES | NO | NO | **MISSING** |
| PostToolUseFailure | YES | NO | NO | YES | NO | NO | **MISSING** |
| PermissionRequest | YES | NO | YES | NO | NO | NO | **MISSING** |
| SubagentStart | YES | NO | NO | YES | NO | NO | **MISSING** |
| SubagentStop | YES | NO | NO | YES | NO | NO | **MISSING** |
| PreModel | NO | YES | YES | NO | NO | NO | **MISSING** |
| PostModel | NO | YES | NO | NO | NO | NO | **MISSING** |
| PreCompact | YES | YES | YES | YES | NO | NO | **MISSING** |
| PostCompact | YES | NO | YES | NO | NO | NO | **MISSING** |
| Notification | YES | YES | NO | NO | NO | NO | **MISSING** |
| ConfigChange | YES | NO | NO | NO | NO | NO | **MISSING** |

**Coverage %**:
- claude-code: 14/16 = **87.5%**
- gemini-cli: 10/16 = **62.5%**
- opencode: 10/16 = **62.5%**
- cursor: 10/16 = **62.5%** (experimental)
- codex: 3/16 = **18.75%** (experimental)
- kimi: 0/16 = **0%**
- **Pi: 0/16 = 0% — NO ENTRY IN hook-mappings.json**

### 3.1 Pi's Native Event Catalog

Pi uses `nativeEventCatalog: "pi"` (not `"canonical"`). The Pi event catalog has 22 native events:

```
session_start, session_shutdown, session_switch, session_fork,
before_agent_start, agent_start, agent_end,
turn_start, turn_end,
message_start, message_update, message_end, context,
before_provider_request,
tool_call, tool_result, tool_execution_start, tool_execution_end,
input, user_bash, model_select, resources_discover
```

These Pi native events already exist in `piEventCatalog` in `hook-mappings.json` but Pi has NO `providerMappings` entry.

**Required canonical-to-Pi mappings** (what should be built):

| Canonical Event | Pi Native Equivalent | Notes |
|----------------|---------------------|-------|
| SessionStart | `session_start` | Direct match |
| SessionEnd | `session_shutdown` | `session_shutdown` is Pi's close event |
| PromptSubmit | `input` | Pi's input event fires on user turn |
| ResponseComplete | `turn_end` | Pi's turn_end fires after response |
| PreToolUse | `tool_call` | Pi fires tool_call before execution |
| PostToolUse | `tool_result` | Pi fires tool_result after success |
| PostToolUseFailure | `tool_result` | Same event, check result status |
| PermissionRequest | (none) | Pi does not have a permission dialog event |
| SubagentStart | `before_agent_start` | Pi's agent start hook |
| SubagentStop | `agent_end` | Pi's agent completion hook |
| PreModel | `before_provider_request` | Pi fires before LLM API call |
| PostModel | (none) | Pi has no native post-model event |
| PreCompact | (none) | Pi has no context compaction events |
| PostCompact | (none) | Pi has no context compaction events |
| Notification | `context` | Pi's context event can carry notifications |
| ConfigChange | (none) | Pi watches settings.json but no hook event |

**Pi potential coverage if mapped: 11/16 = 68.75%** (better than opencode/gemini-cli)

---

## 4. Adapter Architecture

### 4.1 What Exists in `packages/adapters`

Adapters registered in `packages/adapters/src/registry.ts`:
- `claude-code` — full adapter: hooks, install, paths, spawn, context-monitor, transport
- `opencode` — adapter: hooks, install, spawn
- `cursor` — adapter: hooks, install

NOT registered (but exports exist in index.ts):
- `codex` — exported but NOT in `PROVIDER_IDS` array in registry
- `gemini-cli` — exported but NOT in `PROVIDER_IDS` array in registry
- `kimi` — exported but NOT in `PROVIDER_IDS` array in registry

**Pi: NO adapter exists at all.** There is no `packages/adapters/src/providers/pi/` directory.

### 4.2 Adapter Interface (CLEOProviderAdapter)

Each adapter implements:
```typescript
interface CLEOProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  capabilities: AdapterCapabilities;
  hooks?: AdapterHookProvider;         // optional
  spawn?: AdapterSpawnProvider;         // optional
  install: AdapterInstallProvider;      // REQUIRED
  paths?: AdapterPathProvider;          // optional
  contextMonitor?: AdapterContextMonitorProvider;  // optional
  transport?: AdapterTransportProvider; // optional
  taskSync?: ExternalTaskProvider;      // optional
  initialize(projectDir: string): Promise<void>;
  dispose(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
}
```

### 4.3 Hook Provider Interface (AdapterHookProvider)

```typescript
interface AdapterHookProvider {
  mapProviderEvent(providerEvent: string): string | null;
  registerNativeHooks(projectDir: string): Promise<void>;
  unregisterNativeHooks(): Promise<void>;
  getEventMap?(): Readonly<Record<string, string>>;
  getTranscript?(sessionId: string, projectDir: string): Promise<string | null>;
}
```

**Key observation**: The hook provider interface assumes config-file based hooks (`registerNativeHooks` writing to JSON/YAML). Pi's hook system is TypeScript extension files — this does not fit the config-file registration model used by Claude Code and others.

---

## 5. Memory Injection Flow Per Harness

### 5.1 Pi (via CleoOS)

| Phase | Mechanism | Status |
|-------|-----------|--------|
| **Session start — static context** | AGENTS.md `@`-ref chain → memory-bridge.md auto-loaded by Pi | **WORKS** (PiHarness.injectInstructions) |
| **Session start — CANT bundle** | `session_start` hook → `compileBundle()` → cached | **WORKS** |
| **Before agent start — CANT prompt** | `before_agent_start` hook → APPEND bundle to systemPrompt | **WORKS** |
| **Before agent start — mental model** | `before_agent_start` → `memoryFind()` from @cleocode/core | **PARTIAL** — only when agentDef has mentalModel block |
| **Session end — memory consolidation** | Pi extension on `session_shutdown` → only clears cache | **MISSING** — no `cleo session end` trigger |
| **Task complete — graph population** | No Pi extension handler | **MISSING** |
| **JIT mid-session** | Agent calls `cleo memory find` via Bash tool | **WORKS** (CLI available) |

### 5.2 Claude Code

| Phase | Mechanism | Status |
|-------|-----------|--------|
| **Session start — static context** | CLAUDE.md `@`-ref chain (loaded by Claude Code natively) | **WORKS** |
| **Session start** | `SessionStart` hook → `cleo session start` | **WORKS** (via settings.json hooks) |
| **Session end** | `SessionEnd` hook → `cleo session end` (triggers memory refresh) | **WORKS** |
| **Task complete — consolidation** | `PostToolUse` hook or custom → `cleo complete` | **WORKS** |
| **JIT mid-session** | Agent calls `cleo memory find` via Bash tool | **WORKS** |

### 5.3 OpenCode

| Phase | Mechanism | Status |
|-------|-----------|--------|
| **Session start — static context** | AGENTS.md loaded natively if present | **WORKS** |
| **Session start** | `SessionStart` via plugin hooks | **WORKS** |
| **Session end** | `SessionEnd` via plugin hooks | **WORKS** |
| **Task complete** | No explicit hook | **PARTIAL** |
| **JIT mid-session** | Agent calls `cleo memory find` via Bash tool | **WORKS** |

---

## 6. What's BROKEN for "Just Knows" (Per Harness)

### 6.1 Pi — Critical Gaps

| Capability | Status | Gap Description |
|-----------|--------|-----------------|
| memory-bridge.md at session start | **PARTIAL** | Gets it via AGENTS.md `@`-ref IF CAAMP has injected it. No guarantee for new projects. |
| nexus-bridge.md at session start | **MISSING** | No mechanism exists. nexus-bridge.md is never injected for Pi. |
| memory find/trace mid-session | **WORKS** | Via `cleo memory find` bash call |
| session end → memory refresh | **BROKEN** | `session_shutdown` only clears module cache — does NOT call `cleo session end --note` or trigger `cleo refresh-memory` |
| task complete → graph auto-population | **BROKEN** | No hook fires `cleo complete` automatically |
| CAAMP hook-mappings.json entry | **MISSING** | Pi has 0% coverage in hook-mappings.json despite having 22 native events |
| Pi adapter in packages/adapters | **MISSING** | No PiAdapter, PiHookProvider, PiInstallProvider classes |
| Pi in registry.ts PROVIDER_IDS | **MISSING** | discoverProviders() never returns Pi |

### 6.2 Claude Code — Minor Gaps

| Capability | Status | Gap Description |
|-----------|--------|-----------------|
| memory-bridge.md at session start | **WORKS** | Via CLAUDE.md @-ref chain |
| nexus-bridge.md at session start | **WORKS** | Via CLAUDE.md @-ref chain |
| JIT memory | **WORKS** | Via Bash tool |
| session end → refresh | **WORKS** | SessionEnd hook triggers session.end |
| PreModel / PostModel | **MISSING** | Claude Code does not expose LLM request lifecycle hooks |

### 6.3 OpenCode — Notable Gaps

| Capability | Status | Gap Description |
|-----------|--------|-----------------|
| memory-bridge.md at session start | **PARTIAL** | AGENTS.md loaded if present but no guaranteed injection |
| PostToolUseFailure | **MISSING** | No native event |
| SubagentStart / SubagentStop | **MISSING** | No native event |
| Notification / ConfigChange | **MISSING** | No native event |
| opencode NOT in registry PROVIDER_IDS | **BUG** | `discoverProviders()` only has claude-code, opencode, cursor hardcoded — opencode IS in PROVIDER_IDS but gemini-cli/codex/kimi are NOT |

---

## 7. What Needs to Be Built/Fixed for Pi First-Class Support

### Priority 1 — CRITICAL (Pi is useless without these)

**7.1 Add Pi to hook-mappings.json `providerMappings`**

File: `packages/caamp/providers/hook-mappings.json`

Add a `"pi"` entry under `providerMappings`:
```json
"pi": {
  "hookSystem": "plugin",
  "hookConfigPath": "$HOME/.pi/agent/extensions",
  "hookConfigPathProject": ".pi/extensions",
  "hookFormat": null,
  "handlerTypes": ["plugin"],
  "experimental": false,
  "mappings": {
    "SessionStart":        { "nativeName": "session_start",          "supported": true },
    "SessionEnd":          { "nativeName": "session_shutdown",        "supported": true },
    "PromptSubmit":        { "nativeName": "input",                   "supported": true },
    "ResponseComplete":    { "nativeName": "turn_end",               "supported": true },
    "PreToolUse":          { "nativeName": "tool_call",              "supported": true },
    "PostToolUse":         { "nativeName": "tool_result",            "supported": true },
    "PostToolUseFailure":  { "nativeName": "tool_result",            "supported": true, "notes": "Same event; check result.error field" },
    "PermissionRequest":   { "nativeName": null,                      "supported": false },
    "SubagentStart":       { "nativeName": "before_agent_start",      "supported": true },
    "SubagentStop":        { "nativeName": "agent_end",              "supported": true },
    "PreModel":            { "nativeName": "before_provider_request", "supported": true },
    "PostModel":           { "nativeName": null,                      "supported": false },
    "PreCompact":          { "nativeName": null,                      "supported": false },
    "PostCompact":         { "nativeName": null,                      "supported": false },
    "Notification":        { "nativeName": "context",                "supported": true, "notes": "context event can carry notification payloads" },
    "ConfigChange":        { "nativeName": null,                      "supported": false }
  },
  "providerOnlyEvents": [
    "session_switch", "session_fork", "agent_start", "agent_end",
    "turn_start", "message_start", "message_update", "message_end",
    "context", "tool_execution_start", "tool_execution_end",
    "user_bash", "model_select", "resources_discover"
  ]
}
```
After adding, re-run `pnpm run generate-hook-types` in packages/caamp.

**7.2 Add Pi adapter to packages/adapters**

Create `packages/adapters/src/providers/pi/` with:
- `adapter.ts` — PiAdapter implementing CLEOProviderAdapter
- `hooks.ts` — PiHookProvider implementing AdapterHookProvider (maps tool_call→PreToolUse, etc.)
- `install.ts` — PiInstallProvider (uses PiHarness.injectInstructions for instruction files)
- `index.ts` — barrel export + createAdapter factory
- `manifest.json` — adapter manifest

Add `"pi"` to `PROVIDER_IDS` in `packages/adapters/src/registry.ts`.

**7.3 Wire session_shutdown to cleo session end**

In `packages/cleo-os/extensions/cleo-cant-bridge.ts`, the `session_shutdown` handler currently only clears module cache. It needs to additionally call:
```bash
cleo session end --note "Pi session ended via CleoOS"
```
This triggers `vacuumIntoBackupAll` and `refresh-memory`.

### Priority 2 — HIGH (memory "just knows")

**7.4 Add nexus-bridge.md to AGENTS.md injection**

The CAAMP injection template for Pi currently includes `@.cleo/memory-bridge.md` but not `@.cleo/nexus-bridge.md`. Update `packages/caamp/src/core/instructions/templates.ts` (or wherever the Pi injection template is defined) to include both.

**7.5 session_start hook → trigger cleo session start**

The `session_start` extension handler in `cleo-cant-bridge.ts` does not call `cleo session start --scope project`. Without this, there is no active CLEO session when Pi starts, and `cleo current` / `cleo next` return null.

Add to the `session_start` handler:
```typescript
const { execFile } = await import("node:child_process");
execFile("cleo", ["session", "start", "--scope", "project"], { cwd: ctx.cwd }, () => {});
```
(best-effort, non-blocking)

**7.6 before_agent_start → always inject memory bridge**

Currently, the mental-model injection in `before_agent_start` only fires when `agentDef?.mentalModel !== undefined`. The base memory-bridge.md context should be injected for ALL agent spawns, not just ones with a mentalModel block.

### Priority 3 — MEDIUM (completeness)

**7.7 Fix registry.ts PROVIDER_IDS**

`packages/adapters/src/registry.ts` hardcodes `const PROVIDER_IDS = ['claude-code', 'opencode', 'cursor']`. Gemini-cli, codex, and kimi adapters are exported from index.ts but not registered. Add them to PROVIDER_IDS and provide their manifest.json files.

**7.8 PiHookProvider — transcript extraction**

The `AdapterHookProvider.getTranscript()` method needs a Pi implementation. Pi sessions are JSONL files under `~/.pi/agent/sessions/`. The PiHarness already has `listSessions()` and `showSession()` methods that can be leveraged.

**7.9 Pi tool_call → PostToolUseFailure distinction**

Pi's `tool_result` event is used for both success and failure. The PiHookProvider's `mapProviderEvent()` needs to inspect the event payload's `result.error` field to decide whether to emit `PostToolUse` or `PostToolUseFailure`.

---

## 8. Recommended Changes to Adapters/CAAMP

### 8.1 CAAMP — hook-mappings.json

1. Add Pi `providerMappings` entry (see §7.1 above).
2. Regenerate `generated.ts` via `scripts/generate-hook-types.ts`.
3. Verify `cleo provider hooks pi` returns the correct supported events after regeneration.

### 8.2 CAAMP — hook system model for Pi

Pi's `hookSystem` should be `"plugin"` not `"config"` because Pi hooks are TypeScript extension files, not a JSON config. The existing `HookSystemType` union (`"config" | "plugin" | "none"`) already supports this. The `hookConfigPath` for Pi should point to the extensions directory.

The `HookHandlerType` union already has `"plugin"` as a valid value. Pi's entry should use:
```json
"handlerTypes": ["plugin"]
```

### 8.3 adapters package — PiAdapter

The Pi adapter is architecturally different from other adapters because:
1. Pi hooks are `.ts` extension files, not config entries.
2. `registerNativeHooks()` for Pi means writing a `.ts` extension file to `~/.pi/agent/extensions/` — this is already done by CleoOS at startup.
3. The `PiHarness` class in `packages/caamp/src/core/harness/pi.ts` already implements `installExtension()`, `injectInstructions()`, `spawnSubagent()` etc.

**Recommended approach**: PiAdapter wraps PiHarness rather than reimplementing filesystem operations. The adapter layer becomes thin:

```typescript
// packages/adapters/src/providers/pi/adapter.ts
class PiAdapter implements CLEOProviderAdapter {
  private harness: PiHarness;  // from @cleocode/caamp
  readonly id = 'pi';
  // install → delegate to harness.injectInstructions
  // hooks → PiHookProvider (maps pi native events to canonical)
  // spawn → PiSpawnProvider (delegates to harness.spawnSubagent)
  // healthCheck → check 'pi' binary on PATH
}
```

### 8.4 adapters registry — add missing providers

`packages/adapters/src/registry.ts` PROVIDER_IDS array must include all six providers that have adapters: `claude-code`, `opencode`, `cursor`, `gemini-cli`, `codex`, `kimi`. Currently gemini-cli, codex, and kimi are exported from index.ts but their manifests may not exist — create them.

### 8.5 cleo-os extensions — session lifecycle wiring

The two CleoOS extensions (`cleo-cant-bridge.ts`, `cleo-agent-monitor.ts`) need lifecycle wiring:

| Pi Event | Missing CLEO CLI Call |
|---------|----------------------|
| `session_start` | `cleo session start --scope project` (non-blocking) |
| `session_shutdown` | `cleo session end --note "Pi session via CleoOS"` |
| `agent_end` | `cleo complete <taskId>` if agent was on a CLEO task |

The agent monitor already calls `cleo dash --json` and `cleo session status --json` in `/cleo:circle`, proving the pattern works. Extend it to fire on lifecycle events.

---

## 9. Summary Table

| Item | Status | Priority |
|------|--------|----------|
| Pi in hook-mappings.json | MISSING | P1 |
| Pi adapter in packages/adapters | MISSING | P1 |
| session_shutdown → cleo session end | BROKEN | P1 |
| session_start → cleo session start | MISSING | P2 |
| nexus-bridge.md in AGENTS.md injection | MISSING | P2 |
| before_agent_start → always inject memory | PARTIAL | P2 |
| registry.ts PROVIDER_IDS completeness | BUG | P3 |
| PiHookProvider transcript extraction | MISSING | P3 |
| PostToolUseFailure distinction in Pi | MISSING | P3 |
| generated.ts regeneration after Pi added | BLOCKED on P1 | P1 |

**Claude Code** is the reference implementation — it has the fullest hook coverage (14/16) and the most complete adapter. Pi should aim for 11/16 (69%) based on its native event catalog.

**OpenCode** is second-best via plugin hooks (10/16 = 63%). Its adapter exists but is not wired into `PROVIDER_IDS` for auto-discovery.

**Pi** currently has 0% hook coverage in CAAMP despite being the PRIMARY harness (priority: "primary" in registry.json). The harness implementation in CAAMP (`PiHarness`) is excellent and production-ready — the gap is entirely at the CAAMP hook-mappings and adapter layers.
