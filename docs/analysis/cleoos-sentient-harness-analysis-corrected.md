# CleoOS Sentient Harness — Corrected Deep-Dive Analysis

## Executive Summary

The initial analysis was **fundamentally wrong** on three critical points:

1. **CANT is NOT a template system** — it is a novel DSL (Domain-Specific Language) with a Rust parser (`cant-core` crate, ~19K LOC) that compiles `.cant` files into structured ASTs. It supports agents, skills, hooks, workflows, pipelines, teams, tools, imports, bindings, conditionals, loops, parallel blocks, try/catch, and more. Dismissing it as "templates" was a gross mischaracterization.

2. **The duplication map was shallow** — it compared surface-level features without understanding that Cleo's architecture is **intentionally layered**: `contracts` (types), `core` (SDK/runtime), `cleo` (CLI wrapper), `cleo-os` (harness adapters). Hermes is a monolithic Python runtime. The real task is not "bridge them" but **port Hermes' capabilities into Cleo's layered architecture**.

3. **Subagent delegation is NOT a feature to replace** — Hermes' `delegate_task` tool (~1,200 LOC) provides parallel subagent spawning with isolated contexts. Cleo's `orchestration` module (`packages/core/src/orchestration/`) already has dependency analysis, wave computation, spawn prompt building, and task readiness assessment. The gap is in the **harness adapter layer** (`packages/cleo-os/`), which only has a Pi adapter today. We need to add a **Cleo-native agent harness** that replaces the need for Pi/Claude-Code external binaries entirely.

---

## Corrected Architecture Understanding

### Cleo's Package Layering (SSoT — Single Source of Truth)

| Package | Purpose | Current State |
|---------|---------|---------------|
| `packages/contracts/` | Shared types, schemas, LAFS envelopes | 91 files, ~27K LOC — **real and mature** |
| `packages/core/` | SDK — runtime primitives, domain logic, store, memory, sentient, gc, LLM, orchestration | 1,129 files, **~368K LOC** — **extremely sophisticated** |
| `packages/cleo/` | CLI ONLY — thin dispatch + command handlers | 342 files, ~103K LOC — **wrapper around core** |
| `packages/cleo-os/` | Harness — Pi/Claude-Code adapters, CleoOS runtime | 16 files, ~4K LOC — **mostly stubs except Pi adapter** |
| `packages/cant/` | CANT DSL TypeScript types + document model | Minimal — **Rust parser is the real implementation** |
| `crates/cant-core/` | **Rust CANT parser** — full DSL with AST | 60 files, ~19K LOC — **real and comprehensive** |

### Hermes Agent (Reference Implementation to Port)

| Component | Location | Size | What It Does |
|-----------|----------|------|--------------|
| Main runner | `run_agent.py` | ~12K LOC | Conversation loop, tool calling, memory, retry, failover |
| Tool registry | `tools/registry.py` | ~482 LOC | Self-registering tool discovery via AST, thread-safe |
| Model tools | `model_tools.py` | ~400 LOC | Tool definition schema generation, dispatch |
| Delegate tool | `tools/delegate_tool.py` | ~1,200 LOC | Parallel subagent spawning with isolated contexts |
| MCP tool | `tools/mcp_tool.py` | ~1,050 LOC | MCP client with server management |
| Cron/scheduler | Built into runner | N/A | Background job scheduling |
| Terminal tool | `tools/terminal_tool.py` | ~600 LOC | Shell execution with VM lifecycle |
| Browser tool | `tools/browser_tool.py` | ~500 LOC | Browser automation |
| 60+ tools | `tools/*.py` | ~292K total | File, web, git, code execution, etc. |

---

## CANT DSL — The Novel Ideation (Deep Dive)

### What CANT Actually Is

CANT is **Cleo's native agent orchestration language** — a YAML-inspired DSL for defining:

- **Agents** (`agent <name>:`) — with model, permissions, skills, domains
- **Skills** (`skill <name>:`) — reusable capability bundles
- **Hooks** (`on <event>:`) — event-driven triggers
- **Workflows** (`workflow <name>:`) — multi-step orchestration
- **Pipelines** (`pipeline <name>:`) — staged execution
- **Teams** (`team <name>:`) — agent groupings
- **Tools** (`tool <name>:`) — inline tool definitions
- **Imports** (`@import "path"`) — modular composition
- **Bindings** (`let x = 42`, `const y = "foo"`) — variables
- **Conditionals** (`if`, `else`) — branching logic
- **Loops** (`for`, `while`) — iteration
- **Parallel blocks** (`parallel:`) — concurrent execution
- **Try/catch** (`try:`, `catch:`) — error handling
- **Sessions** (`session:`) — context scoping
- **Prose blocks** — free-form instructions

### CANT Runtime Flow

```
.cant file → Rust parser (cant-core) → AST (CantDocument) → TypeScript bridge →
  → Token resolution → Spawn prompt generation → LLM call → Tool loop →
  → Output validation → Manifest entry
```

The `cant-bridge.ts` (in `packages/cleo/templates/cleoos-hub/pi-extensions/`) is a **template** today, but the intended architecture is:
1. Parse `.cant` with Rust `cant-core`
2. Bridge AST to TypeScript via napi-rs
3. Resolve tokens (variable substitution from `project-context.json` + `user_profile`)
4. Build spawn prompt via `buildSpawnPrompt()` in `packages/core/src/orchestration/spawn-prompt.ts`
5. Execute via LLM layer (`packages/core/src/llm/`)
6. Validate output and append to manifest

### CANT vs Hermes Skills

| Aspect | CANT | Hermes Skills |
|--------|------|---------------|
| Format | `.cant` files (DSL) | `SKILL.md` files (markdown) |
| Parser | Rust `cant-core` crate | None — parsed as markdown |
| Runtime | Token resolution + spawn prompt | Direct tool injection |
| Composability | `@import`, `let`, `const` | None — flat files |
| Orchestration | `workflow`, `pipeline`, `parallel` | `delegate_task` tool |
| Type Safety | AST-validated | None |
| Extensibility | DSL-defined agents/skills/hooks | Static markdown |

**Verdict**: CANT is MORE sophisticated than Hermes' skill system. We should **preserve and extend CANT**, not replace it with Hermes' markdown skills. The integration path is to make CANT the primary orchestration layer while adopting Hermes' tool implementations.

---

## Corrected Integration Strategy

### The Real Goal

**Convert Hermes Agent's runtime capabilities into Cleo's layered architecture**, producing:

1. **TypeScript implementations** in `packages/core/` (SDK layer)
2. **Rust crates** with napi-rs bindings for performance-critical paths
3. **A Cleo-native agent harness** in `packages/cleo-os/` that replaces external binaries

### What to Port 1-to-1 from Hermes

#### Phase A: Core Runtime (TypeScript → `packages/core/`)

| Hermes Component | Cleo Target | Notes |
|------------------|-------------|-------|
| `run_agent.py` conversation loop | `packages/core/src/llm/tool-loop.ts` | Already exists — extend with Hermes' retry/failover patterns |
| `tools/registry.py` self-registering discovery | `packages/core/src/skills/` or new `packages/core/src/tools/` | Cleo has skills module but no tool registry. **New module needed.** |
| `model_tools.py` schema generation | `packages/contracts/` + `packages/core/src/tools/` | Tool schemas should be contract types |
| `agent/delegate_tool.py` + `tools/delegate_tool.py` | `packages/core/src/orchestration/` + `packages/cleo-os/` | Cleo has orchestration but needs real harness adapter |
| `tools/mcp_tool.py` MCP client | `packages/core/src/mcp/` | Was removed in Phase 2 — **needs real implementation** |
| `agent/memory_manager.py` | `packages/core/src/memory/` | Cleo has brain-retrieval — extend with Hermes' context building |
| `agent/context_compressor.py` | `packages/core/src/llm/conversation.ts` | Extend existing truncation |
| `agent/retry_utils.py` | `packages/core/src/llm/runtime.ts` | Already has p-retry — enhance |
| `agent/error_classifier.py` | `packages/core/src/llm/runtime.ts` | Add failover reason classification |
| `agent/prompt_builder.py` | `packages/core/src/orchestration/spawn-prompt.ts` | Merge patterns |
| `agent/model_metadata.py` | `packages/core/src/llm/registry.ts` | Extend backend registry |

#### Phase B: 60+ Tools (TypeScript → `packages/core/src/tools/`)

Hermes has 60+ tools organized by toolset. Cleo needs a tool registry module. Each tool:

1. Define schema in `packages/contracts/src/operations/tool-schema.ts` (new)
2. Implement handler in `packages/core/src/tools/<toolset>/<tool-name>.ts`
3. Register via self-discovering pattern (like Hermes' AST-based discovery)
4. Availability check via `check_fn` equivalent

**Toolsets to port**:
- `terminal` — shell execution (Hermes has 6 variants; Cleo needs 1 good one)
- `browser` — web automation
- `web` — search, extract
- `file` — read, write, search, patch
- `git` — status, diff, commit
- `code` — execute_code, delegate_task
- `mcp` — MCP client
- `cronjob` — scheduler
- `memory` — session_search, memory management
- `vision` — image analysis
- `tts` — text-to-speech
- `image_gen` — image generation
- `spotify` — music control
- `discord` — messaging
- And 40+ more...

#### Phase C: Rust Acceleration (napi-rs)

| Component | Rust Crate | Binding |
|-----------|------------|---------|
| CANT parser | `crates/cant-core/` (exists) | napi-rs to TypeScript |
| Token resolution | New `crates/cant-resolve/` | napi-rs |
| Tool dispatch (hot path) | New `crates/tool-engine/` | napi-rs |
| Context compression | New `crates/context-compress/` | napi-rs |
| SQLite operations | Already using libsql/Drizzle | Keep as-is |

---

## The Harness Gap (Critical)

### Current State

`packages/cleo-os/` has:
- `HarnessAdapter` interface (spawn, status, kill, output)
- `PiCodingAgentAdapter` — wraps `@mariozechner/pi-coding-agent` CLI
- Docker sandbox mode for Pi
- Registry with only Pi entry

### What We Need

A **Cleo-native agent harness** that:
1. Does NOT require external binaries (Pi, Claude Code, OpenCode)
2. Uses Cleo's own LLM layer (`packages/core/src/llm/`)
3. Uses Cleo's own tool registry (to be built)
4. Uses Cleo's own orchestration (dependency waves, spawn prompts)
5. Uses CANT for agent definitions
6. Runs as a persistent service (not one-shot subprocess)

### New Harness Architecture

```
┌─────────────────────────────────────────┐
│  packages/cleo-os/src/harnesses/        │
│  ┌─────────────────────────────────┐    │
│  │  CleoNativeHarnessAdapter       │    │
│  │  (NEW — replaces Pi/Claude)     │    │
│  │                                 │    │
│  │  • Uses core LLM (cleoLlmCall)│    │
│  │  • Uses core tools (registry)   │    │
│  │  • Uses CANT agent definitions  │    │
│  │  • Persistent service mode      │    │
│  │  • Branch-lock worktrees        │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  packages/core/src/                      │
│  ┌─────────┐ ┌─────────┐ ┌───────────┐  │
│  │  llm/   │ │  tools/ │ │orchestrate│  │
│  │         │ │         │ │           │  │
│  │• tool-  │ │• registry│ │• waves   │  │
│  │  loop   │ │• dispatch│ │• spawn   │  │
│  │• retry  │ │• schemas │ │  prompts │  │
│  │• failover│ │• checks │ │• readiness│  │
│  └─────────┘ └─────────┘ └───────────┘  │
└─────────────────────────────────────────┘
```

---

## Revised Epic T1737 — Corrected Tasks

### Phase 1: Foundation (Weeks 1-2)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1738 | Design Cleo-native harness architecture | NOT "Hermes bridge" — design how Cleo's own SDK runs agents without external binaries |
| T1739 | Port tool registry pattern from Hermes | Self-discovering, AST-based tool registration with availability checks |
| T1740 | Implement core tool dispatch engine | TypeScript port of Hermes' `registry.dispatch()` with async bridging |

### Phase 2: Tool Integration (Weeks 3-4)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1741 | Port terminal toolset | Single robust terminal implementation (not 6 variants) |
| T1742 | Port web + browser toolsets | Merge Hermes' web_search, web_extract, browser_click, etc. |
| T1743 | Port file + git + code toolsets | read_file, write_file, patch, search_files, terminal, execute_code |

### Phase 3: LLM + Orchestration (Weeks 5-6)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1744 | Enhance tool-loop with Hermes patterns | Retry, failover, context compression, error classification |
| T1745 | Port subagent delegation to Cleo harness | Use Cleo's orchestration waves + spawn prompts, NOT external binaries |
| T1746 | Port MCP client to core | Real implementation in `packages/core/src/mcp/`, not removed stub |

### Phase 4: CANT Integration (Weeks 7-8)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1747 | Wire CANT parser (Rust) to TypeScript | napi-rs bindings for `cant-core` AST → TS bridge |
| T1748 | Implement CANT token resolution engine | Port variable substitution from `agents/variable-substitution.ts` to Rust |
| T1749 | Build CANT-to-spawn-prompt compiler | Transform CANT AST into `buildSpawnPrompt` input |

### Phase 5: CleoOS Harness (Weeks 9-10)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1750 | Implement CleoNativeHarnessAdapter | Uses core LLM, core tools, CANT definitions — no external binaries |
| T1751 | Add persistent service mode | Daemon-style agent that maintains state across tasks |
| T1752 | Implement branch-lock worktree spawning | Port from `packages/core/src/spawn/branch-lock.ts` |

### Phase 6: Migration + Cleanup (Weeks 11-12)

| Task | Title | Corrected Understanding |
|------|-------|------------------------|
| T1753 | Deprecate Pi/Claude-Code harnesses | Mark external binary harnesses as legacy |
| T1754 | Migrate Hermes skills to CANT | Convert `SKILL.md` files to `.cant` skills |
| T1755 | Unify skill directories | Merge `packages/skills/` with CANT skill system |

---

## Key Corrections from Initial Analysis

### 1. CANT is NOT Templates

**Wrong**: "CANT templates are a lightweight alternative to Hermes' SKILL.md"
**Right**: CANT is a full DSL with Rust parser, AST, and runtime. It is MORE powerful than Hermes' markdown skills. The integration is to **use CANT as the primary orchestration layer** and port Hermes' tool implementations to be callable from CANT agents.

### 2. Subagent Delegation is NOT "Use Hermes"

**Wrong**: "Subagent delegation → Use Hermes (real runtime, not CANT templates)"
**Right**: Cleo ALREADY has sophisticated orchestration (`packages/core/src/orchestration/`). What it lacks is a **harness adapter** that can execute agents using Cleo's own LLM/tools instead of spawning external binaries. We need to BUILD a Cleo-native harness, not bridge to Hermes' Python runtime.

### 3. Duplication Map was Shallow

**Wrong**: Listed "terminal backends (6 vs 1), MCP client (1050 LOC vs 379 LOC stub), cron scheduler" as duplication
**Right**: These are NOT duplication — they are **intentional architectural gaps**. Cleo has:
- No tool registry (Hermes has one)
- No MCP client (was removed)
- No cron scheduler (only system-cron)
- No browser automation
- No persistent agent service
- No self-registering tool discovery

These are **missing features**, not duplicated code. The work is to **implement them in Cleo's architecture**.

### 4. The Bridge Pattern was Wrong

**Wrong**: "JSON-RPC bridge between Cleo TypeScript and Hermes Python"
**Right**: **NO BRIDGE**. Port Hermes' capabilities into Cleo's TypeScript/Rust stack. The only Python that should remain is if we wrap specific ML models. All agent runtime, tool dispatch, orchestration should be native to Cleo.

---

## Implementation Priority (Revised)

### Immediate (This Week)

1. **Tool Registry Module** — Create `packages/core/src/tools/` with:
   - `registry.ts` — Self-discovering tool registration (port from Hermes)
   - `schema.ts` — Tool schema types (add to contracts)
   - `dispatch.ts` — Tool dispatch engine
   - `terminal.ts` — First ported tool (most critical)

2. **CleoNativeHarnessAdapter** — Create `packages/cleo-os/src/harnesses/cleo-native/`:
   - Implements `HarnessAdapter` interface
   - Uses `cleoLlmCall` from core
   - Uses tool registry from core
   - No external binary dependencies

### Short Term (Next 2 Weeks)

3. Port web, browser, file, git toolsets
4. Enhance LLM tool-loop with Hermes' retry/failover patterns
5. Wire CANT parser via napi-rs

### Medium Term (Month 2)

6. Port MCP client to core
7. Implement persistent service mode
8. Port subagent delegation to native harness
9. Build CANT-to-spawn-prompt compiler

### Long Term (Month 3)

10. Rust acceleration crates for hot paths
11. Deprecate external binary harnesses
12. Migrate skills to CANT
13. Full Hermes feature parity

---

## Conclusion

The initial analysis treated this as a "bridge two systems" problem. It is actually a **"port one system into another's architecture"** problem. Hermes Agent is a mature reference implementation. Cleo is a sophisticated but incomplete platform. The correct approach is:

1. **Steal Hermes' patterns** — tool registry, self-discovery, retry logic, error classification
2. **Implement them in Cleo's stack** — TypeScript for business logic, Rust for performance, contracts for types
3. **Preserve CANT** — it is Cleo's unique differentiator, not a weakness
4. **Build a native harness** — eliminate dependency on external agent binaries
5. **Maintain layer boundaries** — core (SDK), cleo (CLI), cleo-os (harness), contracts (types)

This is a 3-month project for a team of 2-3 engineers, or a 6-month project for 1 engineer working full-time.
