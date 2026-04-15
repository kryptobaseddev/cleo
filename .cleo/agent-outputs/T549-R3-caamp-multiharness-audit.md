# CAAMP Multi-Harness Memory Audit

**Date**: 2026-04-11
**Task**: T549 (Research 3)
**Topic**: CAAMP adapter system and memory injection across all 6 supported harnesses
**Status**: complete

---

## 1. CAAMP Adapter System Overview

### Architecture

The adapter system lives in `packages/adapters/src/` and exports one class per provider. Every adapter implements `CLEOProviderAdapter` from `packages/contracts/src/adapter.ts`. The interface mandates an `install` sub-provider and allows optional `hooks`, `spawn`, `paths`, `contextMonitor`, `transport`, and `taskSync` sub-providers.

### AdapterHookProvider Interface

Defined in `packages/contracts/src/hooks.ts`:

```ts
interface AdapterHookProvider {
  mapProviderEvent(providerEvent: string): string | null;
  registerNativeHooks(projectDir: string): Promise<void>;
  unregisterNativeHooks(): Promise<void>;
  getEventMap?(): Readonly<Record<string, string>>;
  getTranscript?(sessionId: string, projectDir: string): Promise<string | null>;
}
```

The interface is deliberately minimal. There is no `isRegistered()` method in the contract (each concrete class adds it). There is no `getSupportedCanonicalEvents()` or `getProviderProfile()` in the contract; those are added on concrete Claude Code and OpenCode classes and call into `@cleocode/caamp` normalizer APIs at runtime.

### HookNormalizer (CAAMP normalizer)

Lives in `packages/caamp/src/core/hooks/normalizer.ts`. Loads `providers/hook-mappings.json` (version 2.0.0, last updated 2026-04-06) at first call and caches it. Provides:

- `toNative(canonical, providerId)` — canonical → provider native name
- `toCanonical(nativeName, providerId)` — native → canonical name
- `getSupportedEvents(providerId)` — list of canonical events a provider supports
- `getProviderHookProfile(providerId)` — full profile (hookSystem, config path, handler types, mappings)
- `buildHookMatrix(providerIds?)` — cross-provider comparison matrix
- `getProviderSummary(providerId)` — counts, coverage percentage, categorized lists

The normalizer is the authoritative source. Provider hook classes call it async and fall back to a hard-coded static map when the import fails.

### Canonical Hook Event Taxonomy (16 provider events + 14 domain events)

Provider events (mapped per-provider):
SessionStart, SessionEnd, PromptSubmit, ResponseComplete, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, PreModel, PostModel, PreCompact, PostCompact, Notification, ConfigChange

Domain events (CLEO-internal, not provider-mapped):
TaskCreated, TaskStarted, TaskCompleted, TaskBlocked, MemoryObserved, MemoryPatternStored, MemoryLearningStored, MemoryDecisionStored, PipelineStageCompleted, PipelineManifestAppended, SessionStarted, SessionEnded, ApprovalRequested, ApprovalGranted, ApprovalExpired

---

## 2. Per-Adapter Memory Capabilities

### 2.1 Claude Code

**Hook system**: `config` — `~/.claude/settings.json`
**Handler types**: command, http, prompt, agent
**Canonical events supported**: 14/16 (missing: PreModel, PostModel)

**Memory injection mechanism**:
- Install writes two `@`-references into `CLAUDE.md`:
  - `@~/.cleo/templates/CLEO-INJECTION.md` (global CLEO protocol)
  - `@.cleo/memory-bridge.md` (project memory context)
- Claude Code resolves `@`-referenced files at session start and injects them into the system prompt.
- Additionally registers the `cleo@cleocode` plugin in `~/.claude/settings.json`.

**Mid-session memory retrieval**: YES — Claude Code has full Bash tool support, so agents can call `cleo memory find`, `cleo memory fetch`, and `cleo observe` mid-session via shell tool.

**Tool use during session**: YES — Bash tool, Read/Write/Edit file tools. Full `cleo` CLI access.

**Context window**: ~200,000 tokens (claude-sonnet-4-6 default).

**Memory bridge update mid-session**: YES — if `brain.memoryBridge.autoRefresh` is enabled, any `cleo session end`, `cleo complete <id>`, or `cleo memory observe` triggers `refreshMemoryBridge()` with a 30-second debounce. The `@`-reference in CLAUDE.md always points to the current file on disk. However, Claude Code does NOT auto-reload the file mid-session; the agent sees the snapshot from session start.

**Transcript extraction**: YES — reads most-recent JSONL file from `~/.claude/projects/` subdirectories. Used to feed brain observations at session end.

**Additional capabilities unique to Claude Code**:
- Context monitor via statusline integration
- Task sync via TodoWrite bridge (ClaudeCodeTaskSyncProvider)
- Inter-agent transport provider (ClaudeCodeTransportProvider)
- Context-monitor provider tracking token usage
- Installs `.claude/commands/*.md` files (Claude Code slash commands)
- Supports SubagentStart/SubagentStop hooks (parent can observe spawned agents)

---

### 2.2 OpenCode

**Hook system**: `plugin` — `.opencode/plugins/` (JavaScript plugins)
**Handler types**: plugin (JavaScript)
**Canonical events supported**: 10/16 (missing: PostToolUseFailure, SubagentStart, SubagentStop, Notification, ConfigChange)

**Unique advantage**: OpenCode is the ONLY provider that supports `PreModel` (via `chat.params` event), allowing pre-inference LLM parameter injection. Useful for injecting memory context directly into the model request.

**Memory injection mechanism**:
- Install writes two `@`-references into `AGENTS.md`:
  - `@~/.cleo/templates/CLEO-INJECTION.md`
  - `@.cleo/memory-bridge.md`
- OpenCode reads `AGENTS.md` at session start and processes `@`-includes.

**Mid-session memory retrieval**: PARTIAL — OpenCode has shell tool support (via `command.execute.before` provider-only event and shell env hooks). Whether CLI tool calls work depends on OpenCode version and configuration. The `PreModel` hook (`chat.params`) theoretically allows injecting fresh memory content before each LLM call — but this requires a custom plugin implementation, not provided by CLEO today.

**Tool use during session**: YES (shell commands via tool system) — but OpenCode's tool surface is less complete than Claude Code. No explicit Bash tool equivalent in all modes.

**Context window**: Depends on underlying model (configurable in OpenCode).

**Memory bridge update mid-session**: Same disk-read pattern as other providers. `@`-reference resolves to the file at session start. OpenCode's `PreModel` hook is the only mechanism that could inject a freshly-generated snippet before each turn — a capability that is not yet implemented.

**Transcript extraction**: Not implemented in OpenCodeHookProvider (no `getTranscript()` method). This is a gap.

**Subagent spawning**: YES — `OpenCodeSpawnProvider` spawns detached `opencode run --agent cleo-subagent` processes. Creates `.opencode/agent/cleo-subagent.md` with `@~/.cleo/templates/CLEO-INJECTION.md` injection so spawned subagents receive CLEO context.

---

### 2.3 Cursor

**Hook system**: `config` — `.cursor/hooks.json`
**Handler types**: command, prompt
**Status**: Experimental (hook system marked `experimental: true` in hook-mappings.json)
**Canonical events supported**: 10/16 (missing: PermissionRequest, PreModel, PostModel, PostCompact, Notification, ConfigChange)

**Memory injection mechanism**:
- Install writes to BOTH instruction file formats for maximum compatibility:
  - Legacy: `.cursorrules` (if it already exists — never created from scratch)
  - Modern: `.cursor/rules/cleo.mdc` (always created/updated, MDC format with `alwaysApply: true`)
- Both files contain the same two `@`-references to CLEO-INJECTION.md and memory-bridge.md.
- Cursor processes `@`-includes on load.

**Mid-session memory retrieval**: NO — Cursor is a GUI-based IDE with no native CLI tool support for running arbitrary shell commands mid-conversation. Memory is static from session start.

**Tool use during session**: LIMITED — Cursor's agent can run terminal commands but this is user-initiated. No programmatic `cleo` CLI call from the agent mid-session.

**Context window**: Cursor uses its own context management; context window depends on selected model.

**Memory bridge update mid-session**: NO — no mechanism to reload the memory-bridge.md file mid-session. Static injection only.

**Transcript extraction**: NOT supported (no `getTranscript()` on CursorHookProvider).

**Subagent spawning**: NOT SUPPORTED (`supportsSpawn: false`).

---

### 2.4 Gemini CLI

**Hook system**: `config` — `~/.gemini/settings.json`
**Handler types**: command (shell scripts)
**Canonical events supported**: 10/16 (missing: PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, PostCompact, ConfigChange)

**Unique advantage**: Gemini CLI supports BOTH `PreModel` (`BeforeModel`) and `PostModel` (`AfterModel`) — the only provider other than OpenCode to support PreModel, and the only one to support PostModel at all.

**Memory injection mechanism**:
- Install writes two `@`-references into `AGENTS.md`:
  - `@~/.cleo/templates/CLEO-INJECTION.md`
  - `@.cleo/memory-bridge.md`
- Gemini CLI reads `AGENTS.md` as system prompt context at session start.

**CRITICAL GAP**: Gemini CLI adapter declares `supportsInstructionFiles: false` in its capabilities object but the install provider DOES write to AGENTS.md. This is an inconsistency in the capability declaration. The install works at the file level, but CAAMP's capability flag says it doesn't support instruction files. This flag may affect orchestration decisions.

**Mid-session memory retrieval**: PARTIAL — Gemini CLI supports shell command hooks. The `BeforeAgent` hook fires before each prompt and could theoretically refresh context. But the install mechanism does not set up such a hook.

**Tool use during session**: YES — Gemini CLI has shell execution capabilities. Agents can call `cleo` CLI commands.

**Context window**: Gemini 2.5 Pro supports up to 1M tokens. Gemini 2.0 Flash: 1M tokens.

**Memory bridge update mid-session**: NO — static injection from session start. File is on disk and would require re-reading the AGENTS.md to notice updates, which Gemini CLI does not do mid-session.

**Transcript extraction**: YES — `GeminiCliHookProvider.getTranscript()` calls `readLatestTranscript(join(homedir(), '.gemini'))` via the shared `transcript-reader.ts` utility.

**Subagent spawning**: NOT SUPPORTED (`supportsSpawn: false`).

---

### 2.5 Codex (OpenAI Codex CLI)

**Hook system**: `config` — `.codex/hooks.json`
**Status**: Experimental
**Handler types**: command
**Canonical events supported**: 3/16 (only: SessionStart, PromptSubmit, ResponseComplete)

**CRITICAL LIMITATION**: Codex has the most minimal hook surface of all providers. Only 3 lifecycle events. No tool hooks, no compaction hooks, no agent hooks.

**NOTE — Adapter vs. hook-mappings.json discrepancy**: The adapter declares `supportedHookEvents: ['SessionStart', 'UserPromptSubmit', 'Stop']` using native names, while hook-mappings.json shows `SessionEnd: supported: false`. The hook event map in CodexHookProvider lists native names `SessionStart`, `PromptSubmit`, `ResponseComplete` but maps them incorrectly — `PromptSubmit -> UserPromptSubmit` and `ResponseComplete -> Stop` (these appear to be the native names, but should map to canonical names or vice versa). This needs review.

**Memory injection mechanism**:
- Install writes two `@`-references into `AGENTS.md`:
  - `@~/.cleo/templates/CLEO-INJECTION.md`
  - `@.cleo/memory-bridge.md`
- Codex CLI reads `AGENTS.md` as system instructions.

**Mid-session memory retrieval**: LIMITED — Codex CLI supports shell command execution. Agents can call `cleo` CLI mid-session but this depends on Codex's tool configuration.

**Tool use during session**: YES — Codex CLI is designed for agentic coding with shell access.

**Context window**: Depends on selected OpenAI model. GPT-4o: 128K tokens.

**Memory bridge update mid-session**: NO — static injection only.

**Transcript extraction**: YES — `CodexHookProvider.getTranscript()` calls `readLatestTranscript(join(homedir(), '.codex'))` via shared utility.

**Subagent spawning**: NOT SUPPORTED (`supportsSpawn: false`).

---

### 2.6 Kimi (Moonshot AI)

**Hook system**: NONE
**Canonical events supported**: 0/16

**Memory injection mechanism**:
- Install writes two `@`-references into `AGENTS.md`:
  - `@~/.cleo/templates/CLEO-INJECTION.md`
  - `@.cleo/memory-bridge.md`
- Kimi reads `AGENTS.md` as system instructions.

**Mid-session memory retrieval**: UNKNOWN — Kimi's tool capabilities are not documented in the codebase. No shell tool support has been confirmed.

**Tool use during session**: UNKNOWN — Kimi is Moonshot AI's assistant. Tool use capability depends on Kimi's version and configuration.

**Context window**: Kimi reportedly supports very long contexts (128K-1M tokens depending on version).

**Memory bridge update mid-session**: NO — even if Kimi supported tool use, there is no hook infrastructure to trigger refreshes.

**Transcript extraction**: NOT supported (KimiHookProvider returns empty event map, no getTranscript()).

**Subagent spawning**: NOT SUPPORTED (`supportsSpawn: false`).

---

## 3. Per-Adapter Capability Matrix

| Capability | Claude Code | OpenCode | Cursor | Gemini CLI | Codex | Kimi |
|---|---|---|---|---|---|---|
| Hook events | 14/16 | 10/16 | 10/16 | 10/16 | 3/16 | 0/16 |
| Hook system | config | plugin | config | config | config | none |
| Hook config location | ~/.claude/settings.json | .opencode/plugins/ | .cursor/hooks.json | ~/.gemini/settings.json | .codex/hooks.json | n/a |
| Instruction file | CLAUDE.md | AGENTS.md | .cursorrules + .cursor/rules/cleo.mdc | AGENTS.md | AGENTS.md | AGENTS.md |
| @-references supported | YES | YES | YES | YES (unverified) | YES (unverified) | YES (unverified) |
| Plugin/settings registration | YES (cleo@cleocode plugin) | NO | NO | NO | NO | NO |
| Subagent spawning | YES | YES | NO | NO | NO | NO |
| Tool use mid-session | YES (Bash tool) | PARTIAL | NO (GUI) | YES (shell) | YES (shell) | UNKNOWN |
| Mid-session cleo CLI calls | YES | PARTIAL | NO | YES | PARTIAL | UNKNOWN |
| Dynamic memory retrieval (JIT) | YES | PARTIAL | NO | YES | PARTIAL | NO |
| Context monitor | YES | NO | NO | NO | NO | NO |
| Statusline integration | YES | NO | NO | NO | NO | NO |
| Transport (inter-agent) | YES | NO | NO | NO | NO | NO |
| Task sync | YES | NO | NO | NO | NO | NO |
| Transcript extraction | YES | NO | YES | YES | NO | NO |
| PreModel hook | NO | YES | NO | YES | NO | NO |
| PostModel hook | NO | NO | NO | YES | NO | NO |
| PreCompact hook | YES | YES | YES | YES | NO | NO |
| SubagentStart/Stop hooks | YES | NO | YES | NO | NO | NO |
| Max context window | ~200K | model-dependent | model-dependent | ~1M | ~128K | ~1M |

---

## 4. Injection Pattern Differences Across Providers

### The Two-File Injection Chain

Every provider injects the same two references, but through different instruction file types:

```
@~/.cleo/templates/CLEO-INJECTION.md   (global CLEO protocol)
@.cleo/memory-bridge.md                (project memory snapshot)
```

The difference is WHERE these references are placed:

| Provider | Instruction File | Format | Loaded By |
|---|---|---|---|
| Claude Code | CLAUDE.md | Markdown with @-syntax | Claude Code CLI at session start |
| OpenCode | AGENTS.md | Markdown with @-syntax | OpenCode at session start |
| Cursor | .cursor/rules/cleo.mdc (+ .cursorrules legacy) | MDC frontmatter + @-syntax | Cursor IDE on chat open |
| Gemini CLI | AGENTS.md | Markdown with @-syntax | Gemini CLI at session start |
| Codex | AGENTS.md | Markdown with @-syntax | Codex CLI at session start |
| Kimi | AGENTS.md | Markdown with @-syntax | Kimi at session start |

### @-reference resolution fidelity

The `@`-reference mechanism works differently per provider:

- **Claude Code**: First-class feature. Recursively resolves `@`-includes, expanding tilde paths. Confirmed working.
- **OpenCode**: First-class feature. Processes `@`-references in AGENTS.md. Confirmed working.
- **Cursor**: `.cursor/rules/cleo.mdc` uses Cursor's MDC rule format. Whether `@`-references inside MDC files are resolved the same way is unverified in the codebase.
- **Gemini CLI / Codex / Kimi**: OpenAI's and Moonshot's handling of `@`-reference syntax in AGENTS.md is unverified in the codebase. If these providers treat AGENTS.md as plain markdown without `@`-expansion, memory-bridge.md content would NOT be injected.

### Plugin registration (Claude Code only)

Claude Code uniquely registers `cleo@cleocode` in `~/.claude/settings.json`. This plugin is presumed to handle brain observation automation. No other provider has an equivalent registration step.

---

## 5. Memory Bridge Generation

### Data sources

`packages/core/src/memory/memory-bridge.ts` generates `.cleo/memory-bridge.md` from `brain.db`:

| Section | Source table | Limit (default) |
|---|---|---|
| Last session handoff | sessions (via getLastHandoff) | 1 session |
| Recent decisions | brain_decisions | 5 |
| Key learnings | brain_learnings | 8 (with decay filter) |
| Patterns to follow | brain_patterns (type=success) | 8 |
| Anti-patterns to avoid | brain_patterns (type=failure) | 8 |
| Recent observations | brain_observations | 10 (noise-filtered) |

### Content selection

- Learnings use time-decay: `effectiveConfidence = confidence * 0.5^(ageDays/90)`. Only learnings with effective confidence >= 0.6 appear.
- Observations filter out: `type='change'`, file-change noise titles, task start/complete noise, `[hook]` prefixed titles.
- Content truncated per-item: decisions 120 chars, learnings 150 chars, patterns 150 chars, observations 120 chars.

### Token budget

- Default: no explicit token budget in standard generation.
- Context-aware mode (when `brain.memoryBridge.contextAware: true` and a scope is provided): enforces `brain.memoryBridge.maxTokens` (default 2000 tokens, estimated at 4 chars/token = 8000 chars).
- Context-aware mode uses `hybridSearch()` to surface scope-relevant memories and prepends them before standard content.

### Refresh triggers

1. `cleo session end` → `refreshMemoryBridge()`
2. `cleo complete <id>` → `refreshMemoryBridge()`
3. `cleo memory observe` (high-confidence only) → `maybeRefreshMemoryBridge()` with 30-second debounce
4. `cleo refresh-memory` (manual command)

### Provider universality

The bridge file itself is provider-agnostic — it is a plain markdown file written to `.cleo/memory-bridge.md`. ALL providers reference the same file. The difference is whether their `@`-reference expansion actually works at runtime.

---

## 6. Tool Use and Dynamic Memory Retrieval

JIT (just-in-time) memory retrieval requires the agent to call `cleo` CLI commands mid-session. This is only possible when the provider has shell/tool execution capabilities:

| Provider | JIT Memory Possible? | Mechanism | Notes |
|---|---|---|---|
| Claude Code | YES | Bash tool (`cleo memory find`, `cleo memory fetch`) | Fully supported |
| OpenCode | PARTIAL | Shell command execution, or PreModel plugin | PreModel hook is theoretically the most powerful mechanism but requires a custom plugin not currently implemented |
| Cursor | NO | No programmatic shell tool from agent | Agent cannot call cleo CLI |
| Gemini CLI | YES | Shell command hooks (BeforeAgent fires pre-turn) | Could inject fresh content at each turn via BeforeAgent hook + shell command |
| Codex | PARTIAL | Shell execution in agentic mode | Depends on Codex config |
| Kimi | NO | Unknown tool capabilities | No evidence of shell tool support |

### The Claude Code advantage

Only Claude Code has a hook for SubagentStart/SubagentStop, which enables the orchestrator to ensure subagents receive proper memory context when spawned. OpenCode has `supportsSpawn: true` but no SubagentStart/Stop hooks.

---

## 7. CAAMP Hook Events Relevant to Memory

From the canonical taxonomy, memory-relevant hooks are:

| Hook | Category | Claude Code | OpenCode | Cursor | Gemini CLI | Codex | Kimi |
|---|---|---|---|---|---|---|---|
| SessionStart | session | YES | YES | YES | YES | YES | NO |
| SessionEnd | session | YES | YES | YES | YES | NO | NO |
| PreCompact | context | YES | YES | YES | YES | NO | NO |
| PostCompact | context | YES | YES | NO | NO | NO | NO |
| PreModel | agent | NO | YES | NO | YES | NO | NO |
| SubagentStart | agent | YES | NO | YES | NO | NO | NO |
| MemoryObserved | domain | N/A | N/A | N/A | N/A | N/A | N/A |

Domain events (MemoryObserved, etc.) are CLEO-internal and not provider-translatable. They fire inside the `cleo` CLI process regardless of provider.

### Memory-critical hook gaps

- **PreCompact** is the most critical memory hook. When context is about to be trimmed, CLEO should save key context to brain.db. Only Claude Code and OpenCode support PostCompact (to verify what was saved after compaction). Cursor, Gemini CLI, Codex, and Kimi cannot observe post-compact.
- **SessionEnd** is missing on Codex — there is no hook to trigger memory bridge refresh on session exit.
- **PreModel** (supported by OpenCode and Gemini CLI) is the best mechanism for injecting freshly-retrieved memory before each LLM call, but CLEO has not implemented this pattern.

---

## 8. Gaps in Multi-Harness Memory Support

### Gap 1: @-reference resolution unverified for 4 providers

The install providers for Gemini CLI, Codex, and Kimi write `@`-references into AGENTS.md, but whether these providers actually resolve `@`-includes at runtime is NOT verified in the codebase. If they treat AGENTS.md as plain markdown, the memory-bridge.md content is never injected.

**Risk level**: HIGH. These 3 providers may be silently receiving no memory context.

### Gap 2: No transcript extraction for OpenCode and Kimi

`OpenCodeHookProvider` and `KimiHookProvider` have no `getTranscript()` method. This means session content cannot be fed to brain.db observations at session end for these providers.

**Risk level**: MEDIUM. Brain.db grows stale for OpenCode and Kimi users.

### Gap 3: Gemini CLI capability flag inconsistency

`GeminiCliAdapter.capabilities.supportsInstructionFiles = false` but the install provider DOES write AGENTS.md. This could cause orchestration logic that checks the capability flag to skip instruction file setup incorrectly.

**Risk level**: MEDIUM. False negative in capability declaration.

### Gap 4: Codex adapter event map uses mixed naming

`CodexAdapter.capabilities.supportedHookEvents` lists native names (`'SessionStart', 'UserPromptSubmit', 'Stop'`) instead of canonical names. Other adapters list canonical names. This inconsistency could break code that compares `supportedHookEvents` against canonical event names.

**Risk level**: MEDIUM. Could cause hook registration to skip valid events.

### Gap 5: No PreModel memory injection implementation

OpenCode and Gemini CLI both support `PreModel` / `BeforeModel` hooks, which fire before each LLM call. This is the ideal injection point for freshly retrieved memory. But CLEO has no implementation that uses this hook to inject updated memory content.

**Risk level**: MEDIUM. Missed opportunity for the highest-fidelity memory injection pattern.

### Gap 6: Static-only injection for mid-session memory updates

Memory bridge is loaded at session start and not reloaded unless the agent explicitly calls `cleo memory find` (tool use). For Cursor and Kimi (no tool use), memory is completely static for the session duration.

**Risk level**: MEDIUM. Long sessions accumulate new observations that don't feed back to the current session.

### Gap 7: Registry discovery only includes 3 of 6 providers

`registry.ts`'s `PROVIDER_IDS` constant is `['claude-code', 'opencode', 'cursor']`. The `getProviderManifests()` and `discoverProviders()` functions only handle these three. Gemini CLI, Codex, and Kimi are not in the registry — their adapter classes are exported but not discoverable via `AdapterManager`.

**Risk level**: HIGH. Dynamic adapter loading via `discoverProviders()` silently ignores 3 providers.

### Gap 8: No memory-bridge.md refresh on SessionStart

Memory bridge is NOT regenerated at session start. If the previous session ended without triggering a refresh (e.g. process crash), the agent starts with a stale memory bridge.

**Risk level**: LOW-MEDIUM. Can be mitigated by running `cleo refresh-memory` manually.

### Gap 9: Cursor @-reference behavior in MDC format unverified

The modern Cursor MDC rule format (`.cursor/rules/cleo.mdc`) contains `@~/.cleo/templates/CLEO-INJECTION.md` and `@.cleo/memory-bridge.md` as plain text lines. Whether Cursor's MDC parser expands these as file includes or treats them as literal text is unconfirmed in the codebase.

**Risk level**: HIGH. Could mean Cursor users receive no CLEO injection at all.

---

## 9. Recommendations for Universal Memory Injection

### Recommendation 1: Verify @-reference resolution per provider (PRIORITY: CRITICAL)

Add integration tests or documentation that confirms whether each provider actually expands `@`-includes in AGENTS.md. For providers that do not, implement alternative injection methods (e.g. inline the content directly into AGENTS.md on install, not as a reference).

### Recommendation 2: Fix Codex supportedHookEvents naming (PRIORITY: HIGH)

Change `supportedHookEvents: ['SessionStart', 'UserPromptSubmit', 'Stop']` to use canonical names: `['SessionStart', 'PromptSubmit', 'ResponseComplete']` to match the pattern of all other adapters.

### Recommendation 3: Fix Gemini CLI capability flag (PRIORITY: HIGH)

Change `supportsInstructionFiles: false` to `true` in `GeminiCliAdapter.capabilities`. The install provider writes AGENTS.md, so this flag is wrong.

### Recommendation 4: Add Gemini CLI, Codex, Kimi to registry (PRIORITY: HIGH)

`registry.ts` PROVIDER_IDS should include all 6 providers so `discoverProviders()` works universally. The `discoverProviders()` function currently returns adapters for only claude-code, opencode, and cursor.

### Recommendation 5: Implement PreModel memory injection for OpenCode and Gemini CLI (PRIORITY: MEDIUM)

Use the `PreModel` / `BeforeModel` hook to inject a fresh compact memory summary before each LLM call. This is the highest-fidelity memory injection pattern available — it fires on every turn, not just session start. Implementation: OpenCode plugin that runs `cleo memory find <current-task>` and appends results to system context; Gemini CLI shell command hook that writes to a temp file referenced by the system prompt.

### Recommendation 6: Add transcript extraction for OpenCode (PRIORITY: MEDIUM)

Implement `getTranscript()` on `OpenCodeHookProvider`. OpenCode stores session data in `.opencode/` — likely JSON/JSONL files. Use the shared `readLatestTranscript()` utility once the directory structure is confirmed.

### Recommendation 7: Trigger memory bridge refresh on SessionStart (PRIORITY: MEDIUM)

Add `refreshMemoryBridge()` call during session start handler so agents always start with fresh memory even if the previous session ended abnormally.

### Recommendation 8: Inline memory content for static-only providers (PRIORITY: MEDIUM)

For Cursor and Kimi (where dynamic retrieval is impossible), the install flow could pre-render the memory-bridge.md content inline into the instruction file rather than using a `@`-reference. This trades staleness for reliability. Alternatively, re-run `cleo install` before each session to refresh the inline content.

### Recommendation 9: Verify Kimi tool use capabilities (PRIORITY: LOW)

Research whether Kimi supports shell command execution in its agentic mode. If it does, dynamic memory retrieval becomes possible and the AGENTS.md approach is sufficient.

---

## 10. What Works Today vs. What Needs Building

### Works Today

| Feature | Providers |
|---|---|
| Static memory injection at session start | Claude Code, OpenCode (verified), Cursor (partially verified), Gemini CLI (unverified), Codex (unverified), Kimi (unverified) |
| Dynamic JIT memory retrieval | Claude Code (fully), Gemini CLI (partially) |
| Memory bridge auto-refresh on session end | Claude Code, OpenCode, Cursor, Gemini CLI (via SessionEnd hook) |
| Memory bridge auto-refresh on task complete | All providers (triggered by cleo CLI, not hook) |
| Subagent memory injection | Claude Code (via CLEO-INJECTION in spawn), OpenCode (via cleo-subagent.md template) |
| PreModel injection (per-turn) | NOT IMPLEMENTED (hooks exist in OpenCode and Gemini CLI) |
| Transcript → brain.db pipeline | Claude Code, Gemini CLI, Codex (via getTranscript) |
| Cross-provider hook event normalization | All 6 providers (via normalizer) |

### Needs Building

| Feature | Effort | Priority |
|---|---|---|
| Verify @-reference resolution for Gemini/Codex/Kimi | small | CRITICAL |
| Fix Gemini CLI supportsInstructionFiles flag | small | HIGH |
| Fix Codex canonical event naming | small | HIGH |
| Add Gemini CLI/Codex/Kimi to registry.ts | small | HIGH |
| Transcript extraction for OpenCode | medium | MEDIUM |
| PreModel memory injection plugin (OpenCode) | medium | MEDIUM |
| BeforeAgent shell hook for Gemini CLI memory refresh | medium | MEDIUM |
| Memory bridge refresh on SessionStart | small | MEDIUM |
| Inline content fallback for static-only providers | medium | MEDIUM |
| Kimi tool use research | small (research) | LOW |

---

## 11. Summary: Memory Works Identically Across Providers?

**Short answer**: No. Memory injection quality varies significantly.

**Tier 1 — Full memory support** (Claude Code only):
- Static injection at session start via @-reference
- Dynamic JIT retrieval via Bash tool
- Transcript extraction for brain.db
- SessionEnd hook triggers refresh
- SubagentStart/Stop hooks for multi-agent memory coordination
- Plugin registration for automated brain observations

**Tier 2 — Good memory support** (OpenCode):
- Static injection at session start via @-reference
- Partial JIT retrieval via shell tool
- PreModel hook available for per-turn injection (not yet used)
- SessionEnd hook triggers refresh
- Subagent spawning with CLEO injection embedded

**Tier 3 — Partial memory support** (Gemini CLI):
- Static injection at session start (unverified @-reference resolution)
- JIT retrieval possible via BeforeAgent shell hook (not yet configured)
- PreModel and PostModel hooks available (not yet used for memory)
- Transcript extraction works
- Capability flag inconsistency (supportsInstructionFiles=false is wrong)

**Tier 4 — Minimal memory support** (Cursor, Codex):
- Static injection at session start (Cursor @-reference in MDC unverified)
- No JIT retrieval for Cursor (GUI, no programmatic shell)
- Limited hooks (Codex: 3 events; Cursor: no preModel)
- Codex has transcript extraction; Cursor does not

**Tier 5 — Memory injection only** (Kimi):
- Static injection at session start (unverified @-reference resolution)
- No hooks, no tool use confirmed
- No transcript extraction
- Completely static memory model

The gap between Claude Code (Tier 1) and Kimi (Tier 5) is substantial. The core injection chain (same two @-references, same memory-bridge.md file) provides a common baseline, but the reliability of that baseline for Tiers 3-5 is unverified.
