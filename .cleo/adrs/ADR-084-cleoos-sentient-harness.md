# ADR-084: CleoOS Sentient Harness — Cleo Persona Substrate

**Status:** Accepted (numbered + accepted 2026-05-23 per owner directive; superseded-in-part by ADR-083 §2 for persona/role naming)
**Author:** Cleo Agent
**Date:** 2026-05-04 (drafted) / 2026-05-23 (numbered + accepted)
**Target:** `packages/cleo-os/` (runtime harness), `packages/core/` (SDK extensions), `packages/contracts/` (type extensions)
**Scope:** Gateway + Daemon Runtime layer ON TOP of existing CLEO SDK; carries the persistent **Cleo** persona (per ADR-083)
**Supersedes:** Previous draft that incorrectly proposed rebuilding core capabilities
**Related:** ADR-083 (Cleo Persona + Hierarchy Reconciliation — locks the names used here)

> **Cross-reference (2026-05-23):** Where this ADR uses "Orchestrator agent", "Cleo Agent", or other ad-hoc names, the canonical persona is **Cleo** (singleton root Orchestrator) per ADR-083 §2.1. The 51-task plan in §3 below predates the saga-first-class shipping (ADR-076 / T10113) — review each task before dispatching; some may be stale, superseded, or duplicate work already shipped.

---

## 1. Context

### 1.1 What Already Exists (CRITICAL — Do NOT Rebuild)

`packages/core/` (~227K LOC) already contains a comprehensive SDK:

| Module | What It Does | LOC |
|---|---|---|
| `agents/` | Agent registry, health monitoring, self-healing, capacity tracking, heartbeat protocol | ~4K |
| `llm/` | Full LLM layer: OpenAI/Anthropic/Gemini backends, credential resolver, caching, streaming, structured output | ~8K |
| `tools/` | Tools engine: skill discovery, dispatch, catalog, precedence, provider registry, adapter management | ~1K |
| `skills/` | Skills system: discovery, dispatch, injection, install, manifests, agents registry | ~5K |
| `memory/` | Research/manifest operations, context building | ~12K |
| `nexus/` | Cross-project intelligence: project registration, dependency analysis, graph building | ~3K |
| `sentient/` | Tier-1/2/3 daemon API: autonomous loop, tick execution, proposals, rate limiting, KMS, signed events | ~5K |
| `orchestration/` | Multi-agent workflow: spawn prompts, dependency analysis, atomicity, classify, harness hints | ~13K |
| `harness/` | Provider selection and adapter routing | ~500 |
| `sessions/` | Session management with llmtxt AgentSession adapter | ~6K |
| `hooks/` | CAAMP hook system: 16 canonical events + internal events, payload schemas, registry | ~2K |
| `caamp/` | CAAMP integration: batch install, injection, provider ops, capability checking | ~1K |
| `store/` | Data accessor, SQLite primitives, Drizzle ORM | ~15K |
| `conduit/` | Communication layer | ~3K |
| `context/` | Context management | ~2K |
| `pipeline/` | Pipeline operations | ~4K |
| `phases/` | Phase management | ~3K |
| `spawn/` | Spawn system | ~8K |
| `worktree/` | Worktree operations | ~2K |
| `validation/`, `verification/`, `metrics/`, `telemetry/`, `observability/`, `gc/`, `crypto/`, `security/`, `identity/`, `routing/`, `remote/`, `system/`, `ui/`, `templates/`, `formatters/`, `docs/`, `diagnostics/`, `engine/`, `deriver/`, `code/`, `codebase-map/`, `compliance/`, `reconciliation/`, `release/`, `research/`, `roadmap/`, `sequence/`, `snapshot/`, `stats/`, `sticky/`, `task-work/` | Supporting subsystems | ~100K+ |

**Other packages with specific concerns:**
- `packages/agents/` — Agent protocols/templates (NOT runtime)
- `packages/brain/` — Brain substrate (separate from core/memory/)
- `packages/nexus/` — Nexus package (separate from core/nexus/)
- `packages/skills/` — Skill definitions/profiles
- `packages/mcp-adapter/` — MCP adapter
- `packages/playbooks/` — Playbook DSL + runtime
- `packages/cant/` — CANT DSL + napi-rs bindings
- `packages/caamp/` — CAAMP spec + providers
- `packages/lafs/` — LAFS envelope spec
- `packages/runtime/` — Long-running process layer (polling, SSE, heartbeat, key rotation)
- `packages/adapters/` — Provider adapters (Claude Code, OpenCode, Cursor) using Vercel AI SDK
- `packages/git-shim/` — Git shim
- `packages/worktree/` — Worktree backend
- `packages/studio/` — SvelteKit frontend
- `packages/contracts/` — SSoT types (~27K LOC, 91 files)
- `packages/cleo/` — CLI only (~103K LOC, CLI commands)
- `packages/cleo-os/` — Currently just Pi launcher stubs (~4K LOC)

### 1.2 What Hermes Has That CleoOS Needs

Hermes Agent (Python, ~292K LOC) has these capabilities that CleoOS currently lacks:

| Hermes Component | Cleo Equivalent | Gap |
|---|---|---|
| Gateway (11K LOC, 20+ platforms) | NONE | **MAJOR GAP** |
| Auth system (3.4K LOC, 25+ providers) | `core/llm/credentials.ts` (basic) | **PARTIAL — needs expansion** |
| Tool registry (76 files, ~42K LOC) | `core/tools/` (948 LOC, skill-focused) | **PARTIAL — needs agent-facing tools** |
| Subagent delegation (1.2K LOC) | `core/orchestration/` (spawn system) | **PARTIAL — needs gateway integration** |
| Cron scheduler (1.1K LOC) | `core/sentient/` (tick-based) | **PARTIAL — needs job queue + delivery** |
| Web UI server (2.3K LOC) | `studio/` (SvelteKit, separate) | **MAJOR GAP — needs daemon management UI** |
| Agent loop engine (534 LOC) | `core/llm/` (full backends) | **MOSTLY COVERED** |
| Config/profiles (8.4K LOC) | `core/config/` | **PARTIAL — needs user-facing profiles** |
| Session store + delivery router | `core/sessions/` | **PARTIAL — needs gateway session routing** |
| Memory plugins | `core/memory/` | **MOSTLY COVERED** |
| Model metadata + budgets | `core/llm/` | **PARTIAL — needs catalog expansion** |

### 1.3 The Correct Architecture

**CleoOS is NOT a rebuild of core. It is the GATEWAY + DAEMON RUNTIME that consumes core.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER SURFACES                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   cleo CLI  │ │   Studio    │ │   Web UI    │ │   Messaging Platforms   │ │
│  │ (packages/  │ │ (packages/  │ │ (packages/  │ │ (Telegram, Discord,     │ │
│  │  cleo/)     │ │  studio/)   │ │  cleo-os/)  │ │  Slack, etc.)           │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                           CLEOOS RUNTIME                                      │
│                         (packages/cleo-os/)                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  Gateway Runner          │  Process Manager  │  Cron Scheduler        │  │
│  │  ├─ Platform adapters    │  ├─ PID files     │  ├─ Job definitions    │  │
│  │  ├─ Session routing      │  ├─ Status persist│  ├─ Due detection      │  │
│  │  ├─ Delivery router      │  ├─ Scoped locks  │  ├─ Subagent execution │  │
│  │  ├─ Media delivery       │  ├─ Graceful stop │  ├─ Delivery routing   │  │
│  │  └─ Home channel         │  └─ Replace marker│  └─ Origin resolution  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                         CLEO CORE SDK                                         │
│                       (packages/core/) — ~227K LOC                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   agents    │ │    llm      │ │   tools     │ │   skills                │ │
│  │  (registry, │ │ (backends,  │ │ (engine,    │ │ (discovery,             │ │
│  │   health,   │ │  creds,     │ │  dispatch,  │ │  dispatch,              │ │
│  │   capacity) │ │  cache)     │ │  catalog)   │ │  injection)           │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   memory    │ │   nexus     │ │   sentient  │ │   orchestration         │ │
│  │ (research,  │ │ (cross-proj │ │ (daemon,    │ │ (spawn,                │ │
│  │  manifests) │ │  graph)     │ │  tick,      │ │  classify,              │ │
│  │             │ │             │ │  proposals) │ │  atomicity)             │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   harness   │ │   sessions  │ │   hooks     │ │   caamp                 │ │
│  │ (provider   │ │ (llmtxt    │ │ (16 events  │ │ (batch,                │ │
│  │  selection) │ │  adapter)   │ │  + registry)│ │  injection)           │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   store     │ │   context   │ │   pipeline  │ │   + 30 more modules     │ │
│  │ (SQLite,    │ │ (project    │ │ (phases,    │ │   (see §1.1)            │ │
│  │  Drizzle)   │ │  context)   │ │  spawn)     │ │                         │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                         OTHER PACKAGES                                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   agents    │ │   brain     │ │   nexus     │ │   cant                  │ │
│  │ (templates) │ │ (substrate) │ │ (package)   │ │ (DSL + napi)           │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   adapters  │ │   runtime   │ │   mcp-adapt │ │   playbooks             │ │
│  │ (Vercel AI  │ │ (long-run   │ │ (MCP tools) │ │ (DSL + runtime)        │ │
│  │  SDK bridge)│ │  processes) │ │             │ │                         │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                         CONTRACTS (SSoT)                                      │
│                       (packages/contracts/)                                   │
│  All cross-package types, interfaces, Zod schemas, operation params/results     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Decision

### D1 — CleoOS builds ONLY what core doesn't have

CleoOS (`packages/cleo-os/`) is restricted to:
1. **Gateway** — Platform adapters for 20+ messaging platforms + session/delivery routing
2. **Daemon Runner** — Process management (PID files, status persistence, scoped locks, graceful shutdown)
3. **Cron Scheduler** — Job queue + execution using core's sentient/orchestration
4. **Auth Expansion** — OAuth/API key provider registry extending core/llm/credentials
5. **Web UI (Daemon Management)** — REST API + frontend for managing the running daemon
6. **CLI Integration** — `cleo os` subcommands as thin wrappers

### D2 — Core gets EXTENDED where gaps exist

Where core has partial coverage, extend it IN PLACE:
- `core/llm/credentials.ts` → Add OAuth device code flow, PKCE, token refresh for 25+ providers
- `core/tools/` → Add agent-facing tools (terminal, file, web, browser, media) alongside existing skill tools
- `core/sentient/` → Add cron job queue integration
- `core/sessions/` → Add gateway session metadata (platform, chat_id, delivery routing)
- `core/hooks/` → Add gateway-specific hooks (onMessage, onDelivery, onPlatformConnect)

### D3 — Package boundaries are sacred

| Package | What Lives Here | What DOES NOT |
|---|---|---|
| `packages/core/` | SDK primitives, business logic, store, agents, llm, tools, skills, memory, nexus, sentient, orchestration, harness, sessions, hooks, caamp | NO gateway adapters, NO daemon process mgmt, NO platform-specific code |
| `packages/cleo-os/` | Gateway adapters, daemon runner, cron scheduler, web UI for daemon mgmt, CLI `cleo os` commands | NO tool implementations, NO LLM backends, NO agent registry, NO store logic |
| `packages/cleo/` | CLI command handlers, dispatch, argument parsing | NO runtime logic, NO business logic |
| `packages/contracts/` | Types, interfaces, Zod schemas | NO implementation |
| `packages/runtime/` | Long-running process primitives (polling, SSE, heartbeat) | NO gateway-specific code |
| `packages/adapters/` | Provider adapters (Claude Code, OpenCode, Cursor) using Vercel AI SDK | NO platform messaging adapters |
| `packages/agents/` | Agent templates, protocols, meta-agents | NO runtime registry |
| `packages/cant/` | CANT DSL parser + napi-rs bindings | NO orchestration logic |
| `packages/studio/` | SvelteKit web portal | NO daemon management |

### D4 — Reuse over rebuild

Every capability must be checked against core BEFORE building new:
1. Does `packages/core/src/<module>/` already have this? → USE IT
2. Does `packages/<other>/` already have this? → USE IT
3. Is there a gap that needs filling? → EXTEND the existing module
4. Only if genuinely new → CREATE in appropriate package

---

## 3. Work Structure (51 Tasks Remapped)

### Phase 1: Foundation (Extend Core Auth + Config)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1738 | `packages/core/` (design) | Design how CleoOS consumes core SDK |
| T1781 | `packages/core/src/llm/` | EXTEND credential resolver: add OAuth device code flow, PKCE, token refresh for 25+ providers |
| T1782 | `packages/core/src/config/` | EXTEND config system: add user-facing profiles, .env merging, config validation |
| T1783 | `packages/core/src/store/` | EXTEND store: add gateway session schema, cron job queue schema to existing SQLite |
| T1784 | `packages/cant/` | Wire CANT parser (already exists) to CleoOS runtime |
| T1747 | `packages/cant/` | Wire Rust CANT parser to TypeScript (napi-rs already exists) |

### Phase 2: Agent Core (Extend Core Tools + LLM)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1739 | `packages/core/src/tools/` | EXTEND tools engine: add agent-facing tool registry alongside skill tools |
| T1740 | `packages/core/src/tools/` | EXTEND tool dispatch: add handler dispatch for agent tools |
| T1741 | `packages/core/src/tools/` | Add terminal, file, search, git tools to agent tool registry |
| T1742 | `packages/core/src/tools/` | Add web search, web extract, browser tools to agent tool registry |
| T1743 | `packages/core/src/tools/` | Add memory, vision, media, cron, MCP tools to agent tool registry |
| T1744 | `packages/core/src/llm/` | EXTEND LLM loop: add retry/failover patterns from Hermes |
| T1745 | `packages/core/src/orchestration/` | EXTEND spawn system: add subagent delegation with isolation |
| T1746 | `packages/mcp-adapter/` | EXTEND MCP adapter: add native MCP client integration |
| T1785 | `packages/core/src/tools/` | Build self-discovering agent tool registry (extends existing skill registry) |
| T1786 | `packages/core/src/tools/` | Port core agent tools (terminal, file, search, git) |
| T1787 | `packages/core/src/tools/` | Port web agent tools (search, extract, browser) |
| T1788 | `packages/core/src/llm/` | Build agent-facing LLM tool loop (extends existing cleoLlmCall) |
| T1789 | `packages/core/src/orchestration/` | Implement subagent delegation with swarm support |
| T1790 | `packages/core/src/tools/` | Port remaining agent tools (memory, vision, media, cron, MCP) |
| T1791 | `packages/mcp-adapter/` | Implement MCP client in core SDK |

### Phase 3: Gateway (Build in CleoOS)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1792 | `packages/cleo-os/` | Build GatewayRunner: PID files, status persistence, scoped locks, graceful shutdown |
| T1793 | `packages/cleo-os/` | Implement Telegram platform adapter |
| T1794 | `packages/cleo-os/` | Implement Discord platform adapter |
| T1795 | `packages/cleo-os/` | Implement Slack platform adapter |
| T1796 | `packages/cleo-os/` | Implement WhatsApp platform adapter |
| T1797 | `packages/cleo-os/` | Build SessionStore + DeliveryRouter (uses core/sessions/ for persistence) |
| T1798 | `packages/cleo-os/` | Implement Signal, Matrix, Mattermost, HomeAssistant adapters |
| T1799 | `packages/cleo-os/` | Implement Feishu, WeCom, Weixin, DingTalk, QQBot adapters |
| T1800 | `packages/cleo-os/` | Implement Email, SMS, Webhook, API Server, BlueBubbles, Local TUI adapters |

### Phase 4: Orchestration (Extend Core + Build in CleoOS)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1748 | `packages/cant/` | Implement CANT token resolution (extends existing CANT parser) |
| T1749 | `packages/cant/` | Build CANT-to-spawn-prompt compiler |
| T1750 | `packages/core/src/harness/` | Implement CleoNativeHarnessAdapter (extends existing harness selection) |
| T1751 | `packages/core/src/worktree/` | Implement branch-lock worktree spawning |
| T1752 | `packages/core/src/agents/` | Add agent health monitoring and self-healing (extends existing health) |
| T1753 | `packages/cleo-os/` | Deprecate Pi/Claude-Code external harnesses (remove from cleo-os) |
| T1754 | `packages/agents/` | Migrate Hermes SKILL.md files to CANT skill definitions |
| T1755 | `packages/skills/` | Unify skill directory and deprecate legacy paths |
| T1801 | `packages/core/src/orchestration/` | Build SwarmController (extends existing spawn/classify) |
| T1802 | `packages/cleo-os/` | Implement CronEngine: uses core/sentient/ for ticks, adds job queue + delivery |
| T1803 | `packages/core/src/agents/` | Build Workspace + Agent Hierarchy Manager (extends existing registry) |
| T1804 | `packages/cant/` | Implement CANT Cantbook Execution Engine |

### Phase 5: Surface (Build in CleoOS + Extend CLI)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1805 | `packages/cleo/` | Build `cleo os` CLI commands (thin wrappers around cleo-os runtime) |
| T1806 | `packages/cleo-os/` | Build Web UI: REST API + frontend for daemon management |
| T1807 | `packages/cleo-os/` | Integrate CleoOS with core SDK (wire everything together) |
| T1808 | `packages/core/src/hooks/` | Build Gateway Hooks System (extends existing CAAMP hooks) |

### Phase 6: Polish (Extend Core + Document)

| Task | Target Package | What It Actually Does |
|---|---|---|
| T1809 | `packages/core/src/memory/` | Implement Memory Plugins and Context Engine (extends existing) |
| T1810 | `packages/core/src/llm/` | Implement Model Metadata and Token Budget System (extends existing registry) |
| T1811 | `packages/core/src/diagnostics/` | Build Health Monitoring and Doctor System (extends existing) |
| T1812 | `packages/cleo-os/` | Performance optimization and stress testing |
| T1813 | `docs/` | Write comprehensive documentation |

---

## 4. Consequences

### Positive
- **No duplication**: Core's ~227K LOC is fully leveraged, not rebuilt
- **Single SDK surface**: External consumers use `@cleocode/core` for everything
- **Clear boundaries**: cleo-os is gateway/runtime only; core is SDK only
- **Faster delivery**: Extending existing modules is faster than ground-up builds
- **Type safety**: All extensions use existing contracts from `packages/contracts/`

### Negative
- **Must understand core deeply**: Implementers must know what's in core before adding
- **Refactor risk**: Extending existing modules may require refactoring them first
- **Coordination**: Changes to core affect cleo-os, studio, cli, mcp-adapter simultaneously

### Risks + Mitigations
| Risk | Mitigation |
|---|---|
| Core module doesn't support extension point | Refactor core module first (separate task), then extend |
| Circular dependency cleo-os <-> core | cleo-os only imports from core; core never imports from cleo-os |
| Breaking core API for existing consumers | Use ADR-057 SSoT pattern: contracts first, core second, consumers third |
| Performance overhead of gateway in Node.js | Benchmark against Hermes baseline; optimize event loop |

---

## 5. Compliance

- [ ] Every new file created MUST pass Package-Boundary Check against §D3
- [ ] Every task description MUST reference the correct target package
- [ ] No tool implementation in `packages/cleo-os/` — only gateway/runtime
- [ ] No LLM backend in `packages/cleo-os/` — use `core/llm/`
- [ ] No store logic in `packages/cleo-os/` — use `core/store/`
- [ ] All types imported from `packages/contracts/` — never inline
- [ ] Biome check passes: `pnpm biome check --write .`
- [ ] Build passes: `pnpm run build`
- [ ] Tests pass: `pnpm run test`

---

## 6. References

- ADR-057: Contracts/Core SSoT layering
- ADR-052: SDK Consolidation (Vercel AI SDK)
- ADR-055: Agents Architecture + Meta-Agents
- ADR-056: DB SSoT and release completion invariant
- T1737 epic: CleoOS Sentient Harness
- `packages/core/src/index.ts` — full module listing
- `packages/core/src/tools/index.ts` — existing tools engine
- `packages/core/src/llm/index.ts` — existing LLM layer
- `packages/core/src/agents/index.ts` — existing agent dimension
- `packages/core/src/sentient/index.ts` — existing sentient daemon API
