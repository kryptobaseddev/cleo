# RCASD: T10418 SG-AGENT-TOOL-REGISTRY — Agent Tool Registry Decomposition

**Saga**: T10418 SG-AGENT-TOOL-REGISTRY
**Tier**: 0 (registry) — Tier-0 North Star
**Depends on**: T10400 (SDK API), T10404 (CANT RUNTIME V2), T10377 (IVTR-AC-BINDING coord)
**Status**: Research → Consensus → Architecture Decision → Specification → Decomposition
**Date**: 2026-05-27
**Author**: Hermes Agent (decomposition subagent)

---

## RCASD Stage 1: RESEARCH — Current Tool Registry Audit

### 1.1 What Exists Today

CLEO has a partial tools system at `packages/core/src/tools/`. It is **Category B only** (SDK Tools — harness-agnostic utilities). There is NO Category A (Agent Tool — LLM-callable primitive) registry yet.

**Current tools inventory (Category B — SDK Tools):**

| Module | Tools | Type |
|--------|-------|------|
| `tools/brain-tools/` | searchBrain, observeBrain, fetchBrainEntries, timelineBrain, buildRetrievalBundle | Category B SDK Tools (BRAIN retrieval) |
| `tools/task-tools/` | buildTaskTree, computeCriticalPath, scoreTask, renderTaskTreeText, renderTaskTreeMermaid, defineSdkTool | Category B SDK Tools (task graph ops) |
| `tools/sdk/` | provisionIsolatedShell, validateAbsolutePath, resolveToolCommand, runToolCached, acquireGlobalSlot, pipelineManifestAppend, buildAgentEnv, buildWorktreeSpawnResult, spawnValidator, validatorAcPull, validatorAttest, validatorReject | Category B SDK Tools (infra primitives + validator tools) |
| `tools/engine-ops.ts` | toolsSkillCatalogInfo, toolsSkillDispatch, toolsSkillFind, toolsSkillInstall, toolsSkillUninstall, toolsProviderList, toolsAdapterList, toolsIssueDiagnostics, +15 more | Category C (Domain Utility — CAAMP management) |
| `tools/scaffold-project.ts` | scaffoldProject | Category B |
| `tools/scaffold-global.ts` | scaffoldGlobal | Category B |
| `tools/doctor-project.ts` | doctorProject | Category B |
| `tools/adr-backfill-walker.ts` | ADR backfill | Category B |

**Taxonomy** (from `packages/core/src/tools/sdk/index.ts`):
- Category A (Agent Tool) — LLM-callable tools, owned by T1737/T1739, located at `packages/core/src/tools/agents/`
- Category B (SDK Tool) — this barrel
- Category C (Domain Utility) — CAAMP management ops at `tools/engine-ops.ts`

**Key gap:** `packages/core/src/tools/agents/` directory does NOT exist yet. Category A tools are entirely absent.

### 1.2 The SdkTool Contract (Category B — Existing Foundation)

Defined in `packages/contracts/src/sdk-tool.ts`:

```typescript
interface SdkToolIdentity {
  name: string;        // kebab-case, e.g. "worktree-isolation"
  description: string;
  version: string;     // semver MAJOR.MINOR.PATCH
}

interface SdkTool {
  readonly identity: SdkToolIdentity;
}
```

`defineSdkTool()` (in `packages/core/src/tools/task-tools/sdk-tool.ts`) wraps pure functions with JSON Schema input/output annotations. The `RegisteredSdkTool` interface already states: "can be registered in any agent tool registry or MCP adapter without modification." — this is the bridge to Category A.

### 1.3 The Hermes Agent Tool Protocol (Reference Implementation)

Analyzed from `/mnt/projects/hermes-agent/tools/registry.py` (589 LOC):

**Core architecture:**
- Self-registering: each tool file calls `registry.register()` at module level
- AST-based discovery: `discover_builtin_tools()` scans `tools/*.py` for `registry.register()` calls
- `ToolEntry`: name, toolset, schema (JSON), handler (Callable), check_fn (availability), requires_env, is_async, description, emoji, max_result_size_chars, dynamic_schema_overrides
- `ToolRegistry` singleton: register, deregister, get_definitions (OpenAI-format), dispatch, get_max_result_size
- Thread-safe with `threading.RLock`; generation counter for cache invalidation
- check_fn TTL cache (30s) for availability probes
- Dispatch: sync handlers called directly; async bridged via `_run_async()`
- Toolset system: groups tools by domain; resolved via `toolsets.py`

**60+ tools organized in ~30 toolsets:**

| Toolset | Tools |
|---------|-------|
| web | web_search, web_extract |
| terminal | terminal, process |
| file | read_file, write_file, patch, search_files |
| browser | browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_press, browser_get_images, browser_vision, browser_console, browser_cdp, browser_dialog |
| vision | vision_analyze |
| image_gen | image_generate |
| video_gen | video_generate |
| video | video_analyze |
| tts | text_to_speech |
| skills | skills_list, skill_view, skill_manage |
| todo | todo |
| memory | memory |
| session_search | session_search |
| clarify | clarify |
| code_execution | execute_code |
| delegation | delegate_task |
| cronjob | cronjob |
| messaging | send_message |
| homeassistant | ha_list_entities, ha_get_state, ha_list_services, ha_call_service |
| kanban | kanban_show, kanban_list, kanban_complete, kanban_block, kanban_heartbeat, kanban_comment, kanban_create, kanban_link, kanban_unblock |
| computer_use | computer_use |
| moa | mixture_of_agents |
| discord | discord, discord_admin |
| spotify | spotify_playback, spotify_devices, spotify_queue, spotify_search, spotify_playlists, spotify_albums, spotify_library |
| x_search | x_search |
| feishu_doc | feishu_doc_read |
| feishu_drive | feishu_drive_list_comments, feishu_drive_list_comment_replies, feishu_drive_reply_comment, feishu_drive_add_comment |
| yuanbao | yb_query_group_info, yb_query_group_members, yb_send_dm, yb_search_sticker, yb_send_sticker |
| transcription | (transcription tools) |
| environments | local, docker, ssh, modal, daytona, singularity terminal backends |
| MCP tools | dynamic — registered at runtime from MCP servers |

### 1.4 Existing T10418 Children (11 Children — with 5 Duplicates)

Critical finding: **5 of the 11 children are near-duplicates** — T1737-origin tasks vs later "port" tasks:

| Original (T1737 root) | Duplicate | Overlap |
|----------------------|-----------|---------|
| T1739 — Extend core tools engine with agent-facing tool registry (8 ACs) | T1785 — Build self-discovering agent tool registry (8 ACs) | **~90% overlap** — both build AgentToolRegistry, AST scanning, OpenAI schemas, toolset grouping, availability checks, thread-safety |
| T1741 — Add terminal, file, search, git agent tools (8 ACs) | T1786 — Port terminal, file, search, git tools (8 ACs) | **~95% overlap** — same tool set, same ACs |
| T1742 — Add web search, extract, browser agent tools (9 ACs) | T1787 — Port web search, extract, browser tools (9 ACs) | **~95% overlap** |
| T1743 — Add memory, vision, media, cron, MCP agent tools (10 ACs) | T1790 — Port remaining agent tools (10 ACs) | **~95% overlap** |
| T1746 — Extend MCP adapter with native MCP client (7 ACs) | T1791 — Implement MCP client in core SDK (7 ACs) | **~95% overlap** |

**Recommendation:** Keep the T1737-origin set (T1739-T1746) as the canonical children and close the T1785-T1791 duplicates as absorbed/superseded with cross-reference notes. The originals have more explicit ACs and were filed first.

**After dedup, the effective child count is 6, not 11:**
- T1739: Agent-facing tool registry (foundation)
- T1740: Tool dispatch handlers (foundation)
- T1741: Terminal + file + search + git tools
- T1742: Web + browser tools
- T1743: Memory + vision + media + cron tools
- T1746: MCP client

### 1.5 Coverage Gaps (What 6 children miss)

1. **No tool contract types** — Category A tool schema types in `@cleocode/contracts`
2. **No SDK/API integration** — how tools surface through T10400 SDK API
3. **No CANT permissions integration** — how CANT runtime gates tool access per agent
4. **No IVTR coordination** — consuming T10377's 4 CORE tools without duplication
5. **No CLI surface** — `cleo tools list`, `cleo tools enable/disable` verbs
6. **No tool lifecycle** — enable/disable, deprecation, versioning
7. **No skill-to-tool mapping** — how `task_skills` table maps skills → toolsets
8. **No telemetry** — tool usage metrics, error tracking, observability
9. **No integration tests** — end-to-end agent tool loop tests
10. **No authoring docs** — developer guide for tool authors
11. **No safety/approval gating** — dangerous operations requiring user confirmation
12. **No dynamic tools** — runtime-registered tools (MCP servers, plugins)
13. **No delegation tool** — delegate_task (critical Hermes feature, not in any child)
14. **No tool-set profile** — different tool sets for different agent roles (builder, reviewer, architect)
15. **No CI gate** — tool schema compliance check

---

## RCASD Stage 2: CONSENSUS — Architecture Decisions

### Decision: Category A AgentTool Contract

**D-T10418-1**: Category A tools (LLM-callable) extend SdkToolIdentity with:
- OpenAI function-calling schema (name, description, parameters)
- Handler function (async + sync)
- Toolset membership
- Availability check (check_fn equivalent)
- Safety classification (safe / requires_approval / dangerous)
- Max result size budget

These contracts live in `packages/contracts/src/agent-tool.ts` (NEW).

### Decision: Self-Discovering Pattern

**D-T10418-2**: Adopt the Hermes self-discovering pattern:
- Tool files at `packages/core/src/tools/agents/<toolset>/<tool-name>.ts`
- Each file calls `agentToolRegistry.register()` at module load
- `discoverAgentTools()` scans the directory (TypeScript can use filesystem glob instead of AST parsing)
- Registry is a singleton with thread-safe R/W

### Decision: Duplicate Resolution

**D-T10418-3**: Keep T1739-T1746 as canonical children. Close T1785-T1791 as absorbed/superseded with cross-reference notes to the originals. The originals were filed first with more explicit AC definitions.

### Decision: Scope Boundaries

**D-T10418-4**: T10418 owns:
- Category A tool registry (register, discover, dispatch, schema generation)
- ~50 agent tool implementations (terminal, file, web, browser, memory, vision, media, cron, MCP, delegation, skills, todo, clarify, code execution, session search)
- CLI surface (`cleo tools list`, `cleo tools enable/disable`)
- Skill-to-tool mapping
- Tool safety gating

T10418 does NOT own:
- Category B SDK Tools (already exist — separate concern)
- CANT runtime (T10404) — but consumes its permissions model
- LLM tool-loop (packages/core/src/llm/) — but tools are callable from it
- BRAIN/memory storage — tools call into existing BRAIN SDK tools

---

## RCASD Stage 3: ARCHITECTURE DECISION — Target Architecture

### 3.1 Package Structure

```
packages/contracts/src/
├── sdk-tool.ts                  # EXISTING — Category B contract
└── agent-tool.ts                # NEW — Category A contract

packages/core/src/tools/
├── index.ts                     # EXISTING — Category B + C barrel
├── sdk/                         # EXISTING — Category B SDK tools
├── task-tools/                  # EXISTING — Category B
├── brain-tools/                 # EXISTING — Category B
├── engine-ops.ts                # EXISTING — Category C
├── agents/                      # NEW — Category A Agent Tools
│   ├── registry.ts              # AgentToolRegistry singleton
│   ├── discovery.ts             # discoverAgentTools()
│   ├── dispatch.ts              # dispatch() with error handling
│   ├── schema.ts                # Schema gen helpers
│   ├── safety.ts                # Safety classification + approval gating
│   ├── index.ts                 # Barrel
│   ├── terminal/
│   │   ├── terminal.ts          # Shell execution (PTY + non-PTY)
│   │   └── process.ts           # Process management
│   ├── file/
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── patch.ts
│   │   └── search-files.ts
│   ├── web/
│   │   ├── web-search.ts
│   │   └── web-extract.ts
│   ├── browser/
│   │   ├── browser-navigate.ts
│   │   ├── browser-snapshot.ts
│   │   ├── browser-click.ts
│   │   ├── browser-type.ts
│   │   ├── browser-scroll.ts
│   │   ├── browser-back.ts
│   │   ├── browser-press.ts
│   │   ├── browser-get-images.ts
│   │   ├── browser-vision.ts
│   │   ├── browser-console.ts
│   │   ├── browser-cdp.ts
│   │   └── browser-dialog.ts
│   ├── memory/
│   │   ├── memory.ts
│   │   └── session-search.ts
│   ├── vision/
│   │   └── vision-analyze.ts
│   ├── media/
│   │   ├── image-generate.ts
│   │   └── text-to-speech.ts
│   ├── cron/
│   │   └── cronjob.ts
│   ├── code/
│   │   ├── execute-code.ts
│   │   └── delegate-task.ts
│   ├── skills/
│   │   ├── skills-list.ts
│   │   ├── skill-view.ts
│   │   └── skill-manage.ts
│   ├── planning/
│   │   └── todo.ts
│   ├── interaction/
│   │   └── clarify.ts
│   ├── mcp/
│   │   ├── mcp-client.ts        # Native MCP client
│   │   ├── mcp-transport-stdio.ts
│   │   ├── mcp-transport-http.ts
│   │   └── mcp-discovery.ts
│   └── skill-mapping/
│       └── skill-to-toolset.ts  # task_skills → toolsets mapping
├── cli/
│   └── tools-cli.ts             # cleo tools list/enable/disable
└── __tests__/
    └── agents/                   # Agent tool tests
```

### 3.2 Data Flow

```
CANT agent definition (.cant file)
         │
         ├── agent <name>: permissions: [terminal, file, web]
         │
         ▼
CANT Runtime (T10404) ──► AgentToolRegistry.getDefinitions(["terminal","file","web"])
         │                        │
         │                        ├── returns OpenAI-format schemas for enabled tools
         │                        └── filters by toolset, check_fn availability, safety gating
         ▼
LLM Tool Loop (packages/core/src/llm/)
         │
         ├── LLM returns function_call: { name: "terminal", arguments: {...} }
         │
         ▼
AgentToolRegistry.dispatch("terminal", args)
         │
         ├── check_fn() → available?
         ├── safety classification → requires_approval?
         ├── handler(args) → result
         ├── max_result_size_chars truncation
         └── error classification + reporting
         │
         ▼
Back to LLM as tool_result message
```

### 3.3 CLI Surface

```
cleo tools list [--toolset <name>]     → LAFS envelope with tool inventory
cleo tools show <tool-name>            → tool schema + availability
cleo tools enable <tool-name>          → enable a disabled tool
cleo tools disable <tool-name>         → disable a tool
cleo tools check [--all]               → availability check report
```

### 3.4 Skill-to-Toolset Mapping

From ADR-089: "The `task_skills` table maps tasks to skills; the registry maps skills to toolsets."

```
task_skills table         skill_toolsets table
┌─────────────────┐       ┌─────────────────────┐
│ task_id          │       │ skill_name          │
│ skill_name       │──────►│ toolset(s)          │
└─────────────────┘       │ min_tools           │
                          │ max_tools           │
                          └─────────────────────┘
                                    │
                                    ▼
                          AgentToolRegistry.getDefinitions(...)
```

---

## RCASD Stage 4: SPECIFICATION — Acceptance Criteria for T10418

### 4.1 Saga ACs (T10418 itself — 20 ACs, updated from current)

**ACs 1-6: Foundation — Registry + Dispatch (T1739, T1740)**
- AC1: Self-discovering tool registry: scan `packages/core/src/tools/agents/` at startup; auto-register tools via module-level `agentToolRegistry.register()` calls; consumed by CANT agent permissions + Genkit tool definitions
- AC2: Agent-facing dispatch: extend existing dispatch with `agent.tool.*` op IDs routed to tool implementations; envelope contract per T10400 SDK API

**ACs 7-10: Tool Implementation — Phase 1 (T1741, T1742)**
- AC3: Terminal + file + search + git tools: ported from Hermes Agent Python; shell-safe (cant-runtime P06 rules); BoundaryEntry declared
- AC4: Web search + extract + browser tools: Tavily/Brave/Playwright integration; rate-limit + cost cap per call

**ACs 11-13: Tool Implementation — Phase 2 (T1743, T1746)**
- AC5: Memory + vision + media + cron tools: memory.* tools mirror SG-PSYCHE-FOUNDATION CANT permissions; vision via Gemini multimodal; cron via daemon scheduler
- AC6: MCP client: native MCP client in core SDK; replaces external mcp-tool dependency; supports stdio + sse + http transports

**ACs 14-17: Integration + Gaps (NEW)**
- AC7: Tool contracts in `@cleocode/contracts`: Category A AgentTool interface with OpenAI schema, handler, check_fn, safety classification
- AC8: IVTR coordination: consume T10377's 4 CORE tools subset (terminal, read_file, write_file, search_files) without duplicating implementations; use shared SDK primitives
- AC9: Skill-to-tool mapping: `task_skills` → toolsets resolution; SpawnManager injects correct tools per agent skill assignment
- AC10: Tool safety gating: each tool classified as safe / requires_approval / dangerous; CANT permissions enforce toolset access

**ACs 18-20: CLI + Observability + Docs (NEW)**
- AC11: `cleo tools list` verb returns registry inventory as LAFS envelope; consumed by `cleo doctor tools`
- AC12: Tool telemetry: usage counts, error rates, average latency per tool; surfaced in `cleo doctor tools --stats`
- AC13: Developer guide: `docs/guides/agent-tool-authoring.md` covering contract, registration, testing, safety classification

**ACs 21-24: Child completion (existing)**
- AC14-AC20: Complete all 6 canonical children (T1739, T1740, T1741, T1742, T1743, T1746)

**Additional ACs:**
- AC21: Delegation tool (delegate_task): spawn subagents with isolated contexts; respects max_concurrent_children / max_spawn_depth
- AC22: Integration test: full agent tool loop (LLM → tool call → dispatch → result → LLM) passes
- AC23: All tools registered in BOUNDARY_REGISTRY with ts-only intent per envelope-first doctrine
- AC24: CI gate: `lint-tool-schemas.mjs` validates all agent tool schemas against contract

### 4.2 IVTR Coordination (T10377)

T10377 SG-IVTR-AC-BINDING owns 4 CORE tools for the IVTR validation loop:
- terminal
- read_file
- write_file (patch)
- search_files

T10418 MUST:
1. Consume these via shared SDK primitives (not duplicate implementations)
2. Register them in the agent registry with `origin: "T10377-IVTR-CORE"`
3. Tag them as the validation-required subset
4. Ensure IVTR validator role has access to ONLY these 4 tools (not full registry)

---

## RCASD Stage 5: DECOMPOSITION — Child Tasks

### Dedup Resolution

Before decomposition, close duplicates:
- T1785 → absorbed by T1739
- T1786 → absorbed by T1741
- T1787 → absorbed by T1742
- T1790 → absorbed by T1743
- T1791 → absorbed by T1746

This leaves 6 canonical children, plus 15 NEW tasks = **21 total children**.

### Wave 0 — Contracts + Foundation (no deps, parallel-safe)

**T-TOOL-001 — Agent Tool Contract Types**
- Kind: specification
- Size: small
- Depends: none
- AC1: `packages/contracts/src/agent-tool.ts` with `AgentToolIdentity`, `AgentToolEntry`, `AgentToolSchema`, `ToolSafetyLevel`, `ToolDispatchResult`
- AC2: `AgentToolHandler` type: `(args: Record<string, unknown>) => Promise<string> | string`
- AC3: `ToolSafetyLevel` enum: `safe | requires_approval | dangerous`
- AC4: `ToolDispatchResult`: `{ result?: string; error?: { code: string; message: string; retryable: boolean } }`
- AC5: `ToolsetDefinition`: `{ name, description, tools: string[], includes: string[] }`
- AC6: Exported from `@cleocode/contracts` barrel
- Files: `packages/contracts/src/agent-tool.ts`

**T-TOOL-002 — AgentToolRegistry Singleton**
- Kind: implementation
- Size: medium
- Depends: T-TOOL-001
- AC1: `AgentToolRegistry` class at `packages/core/src/tools/agents/registry.ts`
- AC2: `register(name, toolset, schema, handler, check_fn?, safety?, max_result_size?)` method
- AC3: `deregister(name)` method — removes tool + cleans up empty toolsets
- AC4: `getDefinitions(toolNames)` → OpenAI-format tool schemas (filtered by check_fn)
- AC5: `dispatch(name, args)` → `ToolDispatchResult` (sync + async bridging)
- AC6: `getEntry(name)`, `getAllToolNames()`, `getToolsetNames()`, `getToolsForToolset(ts)`
- AC7: Thread-safe with `AsyncLocalStorage` or mutex
- AC8: Generation counter for cache invalidation
- AC9: Unit tests: register, deregister, dispatch, parallel access
- Files: `packages/core/src/tools/agents/registry.ts`, `__tests__/agents/registry.test.ts`

**T-TOOL-003 — Self-Discovery Engine**
- Kind: implementation
- Size: small
- Depends: T-TOOL-002
- AC1: `discoverAgentTools()` scans `packages/core/src/tools/agents/**/*.ts`
- AC2: Uses filesystem glob (not AST parsing — TypeScript imports are explicit)
- AC3: Import each tool module; tools self-register via module-level `agentToolRegistry.register()` calls
- AC4: Handles import failures gracefully (log warning, skip module, continue)
- AC5: Returns `{ imported: string[], failed: { module: string, error: string }[] }`
- AC6: Called at daemon startup and on tool hot-reload
- AC7: Unit tests: discovers mock tools, handles malformed modules
- Files: `packages/core/src/tools/agents/discovery.ts`, `__tests__/agents/discovery.test.ts`

**T-TOOL-004 — Tool Safety Gating**
- Kind: implementation
- Size: small
- Depends: T-TOOL-002
- AC1: `classifyToolSafety(schema, handler)` → `ToolSafetyLevel`
- AC2: Safe: read-only, no side effects (read_file, search_files, web_search, vision_analyze)
- AC3: Requires approval: side effects on project files (write_file, patch, terminal non-destructive)
- AC4: Dangerous: system-level, irreversible (terminal destructive, browser navigation, code exec)
- AC5: `requiresUserApproval(toolName, args)` → `{ required: boolean, reason?: string }`
- AC6: Approval token flow: `conduit_approvals` table integration per CANT runtime
- AC7: Unit tests: all safety classifications verified
- Files: `packages/core/src/tools/agents/safety.ts`, `__tests__/agents/safety.test.ts`

### Wave 1 — Core Tools (depends on Wave 0)

**T-TOOL-005 — Terminal + Process Tools** (consumed by T1741, runs in parallel with it)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002
- AC1: `terminal` tool: execute shell commands with timeout, PTY/non-PTY modes, working directory
- AC2: `process` tool: manage background processes (list, poll, log, wait, kill, write, submit, close)
- AC3: Worktree isolation: commands restricted to project worktree boundary
- AC4: Dangerous command detection: rm -rf, fork bombs, etc. — requires approval
- AC5: Result truncation at `maxResultSizeChars` configurable per tool
- AC6: Registered in agent registry with toolset: "terminal"
- AC7: check_fn: verifies terminal availability on host
- AC8: Unit tests: mocked child_process, PTY emulation
- Files: `packages/core/src/tools/agents/terminal/terminal.ts`, `process.ts`, tests

**T-TOOL-006 — File + Search + Patch Tools** (consumed by T1741)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002
- AC1: `read_file`: read with line numbers, pagination (offset/limit), encoding detection
- AC2: `write_file`: atomic write (temp + rename), directory creation, syntax check on .py/.json/.yaml/.ts
- AC3: `patch`: targeted find-and-replace with fuzzy matching (9 strategies), unified diff output
- AC4: `search_files`: ripgrep-backed regex content search + glob-based file search
- AC5: All tools respect worktree boundary (no traversal outside project root)
- AC6: Registered in agent registry with toolset: "file"
- AC7: Unit tests: all tools with real temp filesystem
- Files: `packages/core/src/tools/agents/file/*.ts`

**T-TOOL-007 — Web Search + Extract Tools** (consumed by T1742)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002
- AC1: `web_search`: query search engines, return titles/URLs/descriptions
- AC2: Backend abstraction: Tavily (default), Brave, SerpAPI — configurable
- AC3: `web_extract`: extract page content as markdown, PDF support
- AC4: Rate limiting: max N requests/minute, configurable per backend
- AC5: Cost tracking: token estimate per page extracted
- AC6: Registered in agent registry with toolset: "web"
- AC7: Unit tests: mocked HTTP responses
- Files: `packages/core/src/tools/agents/web/*.ts`

**T-TOOL-008 — Browser Automation Tools** (consumed by T1742)
- Kind: implementation
- Size: large
- Depends: T-TOOL-002
- AC1: `browser_navigate`: navigate to URL via Playwright
- AC2: `browser_snapshot`: accessibility tree snapshot (textual representation)
- AC3: `browser_click`, `browser_type`, `browser_press`: element interaction
- AC4: `browser_scroll` (up/down), `browser_back`
- AC5: `browser_get_images`: extract image URLs from page
- AC6: `browser_vision`: screenshot + AI vision analysis (multimodal model)
- AC7: `browser_console`: JS console log capture
- AC8: `browser_cdp`: Chrome DevTools Protocol access
- AC9: `browser_dialog`: handle browser dialogs (alert, confirm, prompt)
- AC10: check_fn: verifies Playwright binary availability
- AC11: Registered in agent registry with toolset: "browser"
- AC12: Unit tests: mocked Playwright
- Files: `packages/core/src/tools/agents/browser/*.ts`

**T-TOOL-009 — Memory + Session Search Tools** (consumed by T1743)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002, T-TOOL-004
- AC1: `memory`: read/write persistent memory entries (wraps existing observeBrain SDK tool)
- AC2: `session_search`: search past conversation history with summarization
- AC3: Memory operations mirror SG-PSYCHE-FOUNDATION CANT permissions
- AC4: Memory writes go through verifyAndStore gate (AST-grep CI enforced)
- AC5: Session search uses FTS5 on session messages table
- AC6: Registered in agent registry with toolsets: "memory", "session_search"
- AC7: Unit tests: mocked BRAIN store, mocked session DB
- Files: `packages/core/src/tools/agents/memory/*.ts`

**T-TOOL-010 — Vision + Media Tools** (consumed by T1743)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002
- AC1: `vision_analyze`: analyze images via multimodal LLM (Gemini or Claude)
- AC2: `image_generate`: text-to-image generation with configurable backends
- AC3: `text_to_speech`: text-to-audio via Edge TTS / ElevenLabs / OpenAI
- AC4: `video_analyze`: video analysis via multimodal model
- AC5: `video_generate`: text-to-video / image-to-video generation
- AC6: All media tools gated by provider API key availability (check_fn)
- AC7: Registered in agent registry with toolsets: "vision", "image_gen", "tts", "video", "video_gen"
- AC8: Unit tests: mocked provider APIs
- Files: `packages/core/src/tools/agents/vision/`, `media/`

### Wave 2 — Integration + Advanced Tools (depends on Wave 0 + Wave 1)

**T-TOOL-011 — MCP Client** (enhances T1746)
- Kind: implementation
- Size: large
- Depends: T-TOOL-002
- AC1: MCP stdio transport: spawn server process, communicate via stdin/stdout JSON-RPC
- AC2: MCP HTTP transport: SSE + HTTP POST with session management
- AC3: Tool discovery: `tools/list` → register in agent registry as dynamic tools (toolset: "mcp-<server>")
- AC4: Schema conversion: MCP tool schema → OpenAI function-calling format
- AC5: Dynamic deregister/reregister on `notifications/tools/list_changed`
- AC6: Server lifecycle: start on first use, health check, graceful shutdown
- AC7: MCP resource and prompt exposure (future capability)
- AC8: MCP OAuth support (`mcp_oauth.py` port)
- AC9: Unit tests: mock MCP server
- Files: `packages/core/src/tools/agents/mcp/*.ts`

**T-TOOL-012 — Delegation Tool**
- Kind: implementation
- Size: large
- Depends: T-TOOL-002, T10401 (daemon spawn)
- AC1: `delegate_task`: spawn subagent with isolated worktree context
- AC2: Task description + toolset specification + max_iterations
- AC3: Respects `max_concurrent_children` and `max_spawn_depth` config
- AC4: Subagent results returned as structured handoff (status, artifacts, observations)
- AC5: Dynamic schema overrides: description reflects current delegation limits
- AC6: Parallel subagent spawning: multiple delegate_task calls in parallel
- AC7: Integration with T10401 daemon SpawnManager
- AC8: Registered in agent registry with toolset: "delegation"
- AC9: Integration tests: spawn → work → handoff cycle
- Files: `packages/core/src/tools/agents/code/delegate-task.ts`

**T-TOOL-013 — Code Execution + Planning Tools** (consumed by T1743)
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002
- AC1: `execute_code`: run Python/JS scripts in sandboxed environment
- AC2: `todo`: create, update, list, complete task plan items
- AC3: `clarify`: ask user clarifying questions (multiple choice or open-ended)
- AC4: `skills_list`, `skill_view`, `skill_manage`: skill discovery and management
- AC5: All tools registered with appropriate toolsets
- AC6: Unit tests
- Files: `packages/core/src/tools/agents/code/`, `planning/`, `interaction/`, `skills/`

**T-TOOL-014 — Skill-to-Toolset Mapping**
- Kind: implementation
- Size: small
- Depends: T-TOOL-002
- AC1: `skill_toolsets` table in schema or registry config
- AC2: `resolveToolsForSkill(skillName)` → `string[]` (tool names)
- AC3: `resolveToolsetForSkills(skillNames[])` → merged tool name set
- AC4: Integration with SpawnManager: injects correct tools per agent skill assignment
- AC5: Default mapping: "ct-cleo" → [terminal, file, web, browser, memory, vision]
- AC6: Override via per-project skill config
- AC7: Unit tests
- Files: `packages/core/src/tools/agents/skill-mapping/`

**T-TOOL-015 — Cronjob Tool**
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002, T10401 (daemon scheduler)
- AC1: `cronjob`: create, list, update, pause, resume, remove, trigger scheduled tasks
- AC2: Cron expression parser (standard 5-field + seconds optional)
- AC3: Next-run calculation
- AC4: Integration with T10401 daemon cron scheduler tick
- AC5: Job history: last run, next run, success/failure count
- AC6: Registered in agent registry with toolset: "cronjob"
- AC7: Unit tests: cron expression parsing, next-run calc
- Files: `packages/core/src/tools/agents/cron/cronjob.ts`

### Wave 3 — CLI + Observability + Docs + CI (depends on Wave 1)

**T-TOOL-016 — CLI Surface**
- Kind: implementation
- Size: medium
- Depends: T-TOOL-002, T-TOOL-003
- AC1: `cleo tools list [--toolset <name>]` — LAFS envelope with tool inventory
- AC2: `cleo tools show <tool-name>` — tool schema + availability + safety level
- AC3: `cleo tools enable <tool-name>` — enable disabled tool
- AC4: `cleo tools disable <tool-name>` — disable tool
- AC5: `cleo tools check [--all]` — availability report for all tools/toolsets
- AC6: Output format: LAFS envelope per T10400 SDK API
- AC7: Integration with existing tools domain operations (toolsSkill*, toolsProvider*, etc.)
- AC8: Integration test: `cleo tools list` returns valid envelope
- Files: `packages/core/src/tools/cli/tools-cli.ts`

**T-TOOL-017 — IVTR 4-CORE Integration**
- Kind: implementation
- Size: small
- Depends: T-TOOL-002, T-TOOL-005, T-TOOL-006
- AC1: Register terminal, read_file, write_file (patch), search_files with `origin: "T10377-IVTR-CORE"` metadata
- AC2: IVTR validator role toolset: ONLY these 4 tools — defined in CANT permissions
- AC3: Shared implementations: no code duplication; tools imported from same modules
- AC4: IVTR validator can dispatch only these 4 tools (gated by toolset)
- AC5: `cleo tools check --role validator` verifies 4 tools available
- AC6: Unit tests: validator role access control
- Files: `packages/core/src/tools/agents/registry.ts` (metadata extension), `__tests__/`

**T-TOOL-018 — Tool Telemetry + Observability**
- Kind: implementation
- Size: small
- Depends: T-TOOL-002
- AC1: Per-tool metrics: invocation_count, error_count, avg_latency_ms, p95_latency_ms, last_error
- AC2: Metrics stored in memory (ring buffer) + optional persist to `conduit.db`
- AC3: `cleo doctor tools --stats` returns telemetry as LAFS envelope
- AC4: Telemetry hook: `onToolDispatch(name, args, result, latency)` for plugins
- AC5: Error classification: network, timeout, permission, validation, internal
- AC6: Unit tests: metrics accuracy
- Files: `packages/core/src/tools/agents/telemetry.ts`

**T-TOOL-019 — Integration Tests**
- Kind: testing
- Size: large
- Depends: T-TOOL-002 through T-TOOL-015
- AC1: Full agent tool loop test: LLM → terminal("echo hello") → result → LLM receives tool_result
- AC2: Tool dispatch error test: invalid tool name → error envelope
- AC3: Safety gating test: dangerous tool → approval required → approved → executed
- AC4: Self-discovery test: scan directory → register all tools → verify all present
- AC5: MCP integration test: mock MCP server → discover tools → dispatch
- AC6: Delegation test: delegate_task → subagent spawns → completes → handoff
- AC7: CLI integration test: `cleo tools list` → valid envelope
- AC8: Skill-to-toolset test: resolveToolsForSkill → verify tool list
- Files: `packages/core/src/tools/__tests__/agents/integration.test.ts`

**T-TOOL-020 — Developer Documentation**
- Kind: documentation
- Size: medium
- Depends: T-TOOL-002 through T-TOOL-005
- AC1: `docs/guides/agent-tool-authoring.md` — how to create a new agent tool
- AC2: Covers: contract, registration, handler patterns, testing, safety classification, check_fn
- AC3: Example: creating a "weather" tool from scratch
- AC4: Toolset definition guide
- AC5: MCP tool authoring guide (create MCP server → register in CLEO)
- AC6: Common patterns: async handlers, file operations, web requests, child_process
- Files: `docs/guides/agent-tool-authoring.md`

**T-TOOL-021 — CI Gate: Tool Schema Compliance**
- Kind: implementation
- Size: small
- Depends: T-TOOL-001
- AC1: `scripts/lint-tool-schemas.mjs` validates all agent tool schemas against contract
- AC2: Checks: required fields (name, description, parameters), valid JSON Schema draft-07
- AC3: Checks: all tools have registered toolset, safety classification, handler
- AC4: Checks: no orphaned tool entries (registered but file missing)
- AC5: CI integration: runs on every PR touching `packages/core/src/tools/agents/`
- AC6: Output: human-readable violation report with file:line references
- Files: `scripts/lint-tool-schemas.mjs`

---

### Wave Dependency Graph

```
Wave 0 (parallel):
  T-TOOL-001 (contracts) ──┐
  T-TOOL-002 (registry)  ←─┘
  T-TOOL-003 (discovery) ←── T-TOOL-002
  T-TOOL-004 (safety)    ←── T-TOOL-002
                           [T-TOOL-002,003,004 parallel-safe with 001 complete]

Wave 1 (parallel pairs — all depend on T-TOOL-002):
  T-TOOL-005 (terminal)   ←── T-TOOL-002
  T-TOOL-006 (file)       ←── T-TOOL-002
  T-TOOL-007 (web)        ←── T-TOOL-002
  T-TOOL-008 (browser)    ←── T-TOOL-002
  T-TOOL-009 (memory)     ←── T-TOOL-002, T-TOOL-004
  T-TOOL-010 (vision)     ←── T-TOOL-002

Wave 2 (depends on Wave 0 + Wave 1):
  T-TOOL-011 (MCP)        ←── T-TOOL-002
  T-TOOL-012 (delegation) ←── T-TOOL-002, T10401
  T-TOOL-013 (code/plan)  ←── T-TOOL-002
  T-TOOL-014 (skill-map)  ←── T-TOOL-002
  T-TOOL-015 (cronjob)    ←── T-TOOL-002, T10401

Wave 3 (depends on Wave 1 + Wave 2):
  T-TOOL-016 (CLI)        ←── T-TOOL-002, T-TOOL-003
  T-TOOL-017 (IVTR)       ←── T-TOOL-002, T-TOOL-005, T-TOOL-006
  T-TOOL-018 (telemetry)  ←── T-TOOL-002
  T-TOOL-019 (integ test) ←── T-TOOL-002 through T-TOOL-015
  T-TOOL-020 (docs)       ←── T-TOOL-002 through T-TOOL-005
  T-TOOL-021 (CI gate)    ←── T-TOOL-001
```

### Summary: 21 Total Children (6 existing + 15 new)

| ID | Title | Wave | Deps | Size |
|----|-------|------|------|------|
| T1739 | Agent-facing tool registry (canonical — supersedes T1785) | 0 | none | large |
| T1740 | Tool dispatch handlers | 0 | T1739 | medium |
| T1741 | Terminal + file + search + git tools (canonical — supersedes T1786) | 1 | T1740 | large |
| T1742 | Web + browser tools (canonical — supersedes T1787) | 1 | T1740 | large |
| T1743 | Memory + vision + media + cron tools (canonical — supersedes T1790) | 1 | T1740 | large |
| T1746 | MCP client (canonical — supersedes T1791) | 2 | T1740 | large |
| **NEW** T-TOOL-001 | Agent Tool Contract Types | 0 | none | small |
| **NEW** T-TOOL-002 | AgentToolRegistry Singleton | 0 | T-TOOL-001 | medium |
| **NEW** T-TOOL-003 | Self-Discovery Engine | 0 | T-TOOL-002 | small |
| **NEW** T-TOOL-004 | Tool Safety Gating | 0 | T-TOOL-002 | small |
| **NEW** T-TOOL-005 | Terminal + Process Tools | 1 | T-TOOL-002 | medium |
| **NEW** T-TOOL-006 | File + Search + Patch Tools | 1 | T-TOOL-002 | medium |
| **NEW** T-TOOL-007 | Web Search + Extract Tools | 1 | T-TOOL-002 | medium |
| **NEW** T-TOOL-008 | Browser Automation Tools | 1 | T-TOOL-002 | large |
| **NEW** T-TOOL-009 | Memory + Session Search Tools | 1 | T-TOOL-002,004 | medium |
| **NEW** T-TOOL-010 | Vision + Media Tools | 1 | T-TOOL-002 | medium |
| **NEW** T-TOOL-011 | MCP Client | 2 | T-TOOL-002 | large |
| **NEW** T-TOOL-012 | Delegation Tool | 2 | T-TOOL-002, T10401 | large |
| **NEW** T-TOOL-013 | Code Execution + Planning Tools | 2 | T-TOOL-002 | medium |
| **NEW** T-TOOL-014 | Skill-to-Toolset Mapping | 2 | T-TOOL-002 | small |
| **NEW** T-TOOL-015 | Cronjob Tool | 2 | T-TOOL-002, T10401 | medium |
| **NEW** T-TOOL-016 | CLI Surface (`cleo tools`) | 3 | T-TOOL-002,003 | medium |
| **NEW** T-TOOL-017 | IVTR 4-CORE Integration | 3 | T-TOOL-002,005,006 | small |
| **NEW** T-TOOL-018 | Tool Telemetry + Observability | 3 | T-TOOL-002 | small |
| **NEW** T-TOOL-019 | Integration Tests | 3 | T-TOOL-002..015 | large |
| **NEW** T-TOOL-020 | Developer Documentation | 3 | T-TOOL-002..005 | medium |
| **NEW** T-TOOL-021 | CI Gate: Tool Schema Compliance | 3 | T-TOOL-001 | small |

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| T10400 not shipped | T10418 blocked — no SDK API to plug into | T10400 is already in RCASD Stage 5; T10418 starts after T10400 Wave 0 |
| T10401 daemon not ready | Delegation + cronjob tools blocked | Stub tools with mock daemon; full integration when T10401 ships |
| T10377 IVTR scope unclear | May duplicate or miss 4 CORE tools | T-TOOL-017 explicitly coordinates; sync with T10377 owner before implementing |
| Duplicate children cause confusion | 5 duplicates in current tree waste effort | Close T1785-T1791 as absorbed; keep originals |
| Browser tools heavyweight | Playwright adds ~200MB to install size | check_fn gates availability; optional dependency |
| MCP spec evolving | Client implementation may need updates | Track MCP spec version; pin compatibility |

---

## Open Questions

1. **Should T1785-T1791 be closed-as-absorbed now, or left open as "futures"?**
   Recommendation: close-as-absorbed. They are ~95% duplicate ACs and add no new scope. Keep T1739-T1746 as canonical.

2. **What tools are in T10377's "4 CORE tools" subset?**
   Verified via North Star: terminal, read_file, write_file (patch), search_files. T-TOOL-017 explicitly coordinates.

3. **Should Category A tools share implementations with existing Category B SDK tools?**
   Yes — Category A agent tools wrap Category B SDK primitives. Example: memory tool wraps searchBrain/observeBrain from brain-tools/. File tools wrap existing filesystem utilities.

4. **What toolset does a Cleo agent get by default?**
   Proposed: `hermes-cli` equivalent: terminal, process, read_file, write_file, patch, search_files, web_search, web_extract, vision_analyze, image_generate, skills_list, skill_view, skill_manage, browser tools, text_to_speech, todo, memory, session_search, clarify, execute_code, delegate_task, cronjob. Gated by CANT permissions + check_fn availability.

5. **Should CLEO adopt Hermes' exact tool names or use CLEO-specific names?**
   Use Hermes tool names for familiarity (terminal, read_file, write_file, patch, search_files, web_search, web_extract, browser_navigate, etc.). These are well-known from the existing Hermes documentation.

---

*RCASD Stage 5 (Decomposition) complete. Next: create new tasks via `cleo add-batch`, close duplicates T1785-T1791, and update T10418 ACs.*
