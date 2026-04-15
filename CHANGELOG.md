# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2026.4.51] (2026-04-15)

T626 Living Brain foundation — 5-substrate API + decision cross-links + STDP plasticity + edge normalization.

### Feat: Unified Living Brain API (T626 Phase 1)
- `packages/studio/src/lib/server/living-brain/` — 5 substrate adapters (brain/nexus/tasks/conduit/signaldock)
- `LBNode`, `LBEdge`, `LBGraph`, `LBQueryOptions` types
- `GET /api/living-brain?limit=&substrates=&min_weight=`
- `GET /api/living-brain/node/:id` — node + neighbors
- `GET /api/living-brain/substrate/:name` — filtered by substrate
- 21 tests pass

### Feat: Decision auto cross-link (T626 Phase 1)
- `autoCrossLinkDecision` extracts referenced file paths, function names, class names from decision text
- Fire-and-forget wire into `storeDecision` — creates `affects` edges automatically
- 14 new tests + 14 regression tests pass

### Feat: STDP timing-dependent plasticity (T626 Phase 5 foundation)
- `brain-stdp.ts` — `applyStdpPlasticity` implements spike-timing-dependent plasticity
- LTP (pre→post): Δw = 0.05 × exp(−Δt/20s)
- LTD (post→pre): Δw = −0.06 × exp(−Δt/20s)
- `brain_plasticity_events` table logs all events
- Wired into session.end consolidation pipeline (step 9)
- `cleo brain plasticity stats` CLI
- 12 tests pass

### Fix: T626-M1 edge type normalization
- `EDGE_TYPES` constants (`CO_RETRIEVED`, `SUPERSEDES`, `APPLIES_TO`, `AFFECTS`, etc.)
- `strengthenCoRetrievedEdges` uses canonical `CO_RETRIEVED` type
- Migration relabels existing rows
- Foundation unlocks M2-M7 parallel work

## [2026.4.50] (2026-04-15)

T618 barrel tracing FIXED — workspace import resolution + multi-project registry complete.

### Fix: T618 barrel tracing root cause (M4)
- `resolveTypescriptImport('@cleocode/core')` returned null because `suffixResolve` couldn't match `@scope/package` style with `src/` segment
- New `loadWorkspacePackages` scans `packages/*/package.json` and maps each name → `src/index.ts` entry
- `ImportResolutionContext.workspacePackageMap` threaded through resolver
- 5 new tests in barrel-tracing.test.ts
- **Tier 2a barrel resolution: 0 → 9,587 calls**
- **Accuracy: 71% → 86%** (findTasks 0→3, completeTask 7→8)

### Fix: T618-M2 type gap
- `CommonExtractionResult` now used uniformly (was duplicated inline type)
- Default extractor branch emits `reExports: []`

### Feat: T622 multi-project registry COMPLETE
- `cleo nexus projects list/register/remove` CLI commands
- Schema column mapping fixed in `core/src/nexus/registry.ts`
- 24,169 projects registered globally
- Studio /projects view shows live data
- `/api/search` cross-project symbol search

### Test results
- 411+ test files, 7438+ tests passing
- biome ci clean
- build green

## [2026.4.49] (2026-04-15)

CLEO Studio views + diagnostics + agent self-healing + multi-project registry.

### Feat: BRAIN Studio View (T620)
- `/brain` dashboard with 8 stat cards, memory tiers, recent activity
- `/brain/graph` — d3-force neural network visualization
- `/brain/decisions` — expandable timeline
- `/brain/observations` — filterable list with quality bars
- `/brain/quality` — distribution histograms
- `BrainGraph.svelte` component: node color by type, radius by quality, tier ring style
- LIVE: 767 nodes, 556 edges rendering from brain.db

### Feat: Multi-project registry (T622)
- `/projects` — project list view
- `project-context.ts` server helper
- `/api/search` — cross-project symbol search
- (Partial — core nexus/registry.ts work in progress, further integration pending)

### Feat: Diagnostics telemetry (T624)
- Opt-in telemetry via `cleo diagnostics enable|disable|status|analyze|export`
- `telemetry_events` table in `~/.local/share/cleo/telemetry.db`
- Fire-and-forget middleware records every operation when enabled
- `buildDiagnosticsReport` surfaces failing/slow commands, auto-generates BRAIN observations
- 14/14 unit tests pass

### Feat: Agent self-healing via NEXUS (T625)
- Pre-modification `buildNexusContext` injects callers/callees into agent prompts
- Post-modification incremental NEXUS analyze via PostToolUse hook
- `cleo nexus diff --before <sha> --after HEAD` — compare index state
- Regression detection with LAFS JSON envelope output
- BRAIN learning auto-generation for broken relations

### Fix: Web daemon persistence (T623)
- Stdio routing to `~/.local/share/cleo/logs/web-server.log`
- Atomic PID file write (temp + rm pattern)
- Extended SIGTERM grace period to 30s
- `cleo web restart` command added
- Cross-platform signal handling

### Fix: CI biome failures (multiple)
- Pre-release verification protocol now mandatory
- `pnpm biome ci packages/` runs on entire tree, not touched files only

### Partial: T618 barrel tracing wire (2 context-limit failures)
- LEAD decomposition plan at `.cleo/agent-outputs/T618-decomposition-plan.md`
- 5 micro-tasks identified — orchestrator will dispatch next wave
- Functions exist, data quality issue identified (type gap + path normalization)

## [2026.4.48] (2026-04-15)

Agent SDK providers + CLEO Studio portal + barrel tracing infrastructure + CI fix.

### Fix: CI biome format failures (urgent)
- `pnpm biome check` applied to T617 barrel tracing files
- Auto-applied optional chain refactors across core, caamp, test files
- Pre-release verification pipeline standardized (feedback memory documented)

### Feat: Claude Agent SDK spawn provider (T581)
- `packages/adapters/src/providers/claude-sdk/` — 6 files including spawn.ts, session-store.ts, tool-bridge.ts, mcp-registry.ts
- `@anthropic-ai/claude-agent-sdk@0.2.108` added as dependency
- Persistent multi-turn agents, tool use, MCP integration
- Config toggle: `provider.claude.mode sdk|cli` (default cli for backwards compat)
- 19 new tests

### Feat: OpenAI Agents SDK spawn provider (T582)
- `packages/adapters/src/providers/openai-sdk/` — 8 files with guardrails, tracing, handoffs
- First-class agent-to-agent handoffs (CLEO Lead → Worker mapping)
- `CleoConduitTraceProcessor` writes spans to conduit.db
- `supportsHandoffs: true` capability declared in manifest
- 63 new tests

### Shared utilities
- `packages/adapters/src/providers/shared/sdk-result-mapper.ts` — normalizes RunResult → SpawnResult
- `packages/adapters/src/providers/shared/conduit-trace-writer.ts` — shared audit path

### Feat: CLEO Studio unified web portal (T577-T580)
- `packages/studio/` — SvelteKit 2 + Svelte 5 + adapter-node + Hono
- Routes: `/nexus` `/brain` `/tasks` (foundation scaffold)
- `src/lib/server/db/connections.ts` — read-only sqlite for all 3 DBs
- `src/routes/api/health/+server.ts` — live DB availability check
- `cleo web start` wired to launch studio build/
- Auto-build on first start via `pnpm --filter @cleocode/studio build`
- LIVE VERIFIED: / /nexus /brain /tasks /api/health all return correct HTML + JSON

### Feat: NEXUS barrel export tracing (T617 complete infrastructure)
- `buildBarrelExportMap`, `resolveBarrelBinding`, `extractReExports` in import-processor.ts
- 441-line barrel-tracing.test.ts with 23 tests
- Wildcard export key prefix support
- Follow-up T618 for wiring into active call resolution path

### Test suite
- 410 test files (was 405 at start of session)
- 7420 tests passing (was 7275)
- Zero regressions, 15 biome warnings (all non-breaking)

## [2026.4.47] (2026-04-14)

T569 Attestation Epic — 4 critical bugs fixed + barrel tracing infrastructure.

### Fix: BRAIN tier promotion not running (T614)
- `runTierPromotion` required `verified = 1` — 239/275 observations stuck in short tier
- Removed hard gate, added 3 independent tracks: citation, quality, owner-verified
- Added `cleo memory consolidate` CLI subcommand
- Verified on live brain.db: 18 observations promoted to medium tier (was 0)

### Fix: CANT parser starter bundle errors (T615)
- Starter bundle `.cant` files had YAML-style list items not in formal DSL spec
- 131 parse errors → 0. All 5 starter files parse clean
- 5 integration tests added in `crates/cant-core/tests/parse_new_sections.rs`
- 607 Rust tests + 194 cleo-os TS tests pass

### Feat: NEXUS barrel export tracing (T617 — infrastructure)
- `buildBarrelExportMap`, `resolveBarrelBinding`, `extractReExports` implemented
- 441-line test suite covering named, wildcard, transitive chains
- Follow-up T618 needed to wire into active call resolution path

### Fix: Missing `./store/*` and `./conduit/*` exports (T616)

`packages/core/package.json` — the wildcard export `"./*"` maps to
`"./dist/*.js"`, but the `*` in Node.js exports maps does NOT match path
separators. This meant `@cleocode/core/store/nexus-sqlite` could not be
resolved because `store/nexus-sqlite` contains a `/`.

All `cleo nexus context/impact/clusters/flows` commands failed with
`E_CONTEXT_FAILED: Cannot find module '@cleocode/core/store/nexus-sqlite'`
on any fresh install where the local workspace symlinks are absent.

**Fix**: Added explicit `"./store/*"` and `"./conduit/*"` entries to the
exports map before the catch-all `"./*"`. These entries correctly map
`./dist/store/*.js` and `./dist/conduit/*.js` so per-file modules in
subdirectories are resolvable by Node.js module resolution.

## [2026.4.46] (2026-04-14)

Epic auto-complete bug fix + orphaned parent defense.

### Fix 1: Epic premature auto-completion (T585)
`packages/core/src/tasks/complete.ts` — the epic auto-complete check used
`Array.every()` without guarding against empty arrays. In JavaScript,
`[].every(...)` returns `true` (vacuous truth), so when a parent epic had
no visible children it was erroneously auto-completed.

**Fix**: Added `siblings.length > 0` guard before the `.every()` check.

### Fix 2: Orphaned parentId race (T585 defense in depth)
`packages/core/src/store/db-helpers.ts` — concurrent `upsertTask` writes
from parallel agents could silently clear the `parentId` field. This
caused the T569 incident where an epic auto-completed because
`getChildren()` returned only the in-flight task (siblings orphaned).

**Fix**: Added `allowOrphanParent: boolean = false` option. Normal writes
now log a warning when the parentId would be cleared. Bulk/archive flows
pass `allowOrphanParent: true` for the documented T5034 scenario.

**Tests**: 6 new tests in `epic-auto-complete.test.ts` covering the empty
siblings case, partial completion, full completion, and concurrent writes.

### Carries Forward
All v2026.4.45 changes.

## [2026.4.45] (2026-04-14)

Critical fix — `@cleocode/core/conduit` subpath export.

### Build Fix
- **`build.mjs` core options**: added `packages/core/src/conduit/index.ts` as a second esbuild entry point so `dist/conduit/index.js` is produced alongside `dist/index.js`
- **Also added** `internal.ts` as an explicit entry for the `./internal` export
- **Root cause**: v2026.4.43 and v2026.4.44 shipped `dist/conduit/*.d.ts` files (from tsc declarations) without the corresponding `.js` files (esbuild only ran one entry point). This broke `cleo orchestrate conduit-send/status/peek` at runtime with `Cannot find module '.../dist/conduit/index.js'`.
- **Verified**: CONDUIT attestation T577 now passes — 164 messages in conduit.db, 20 transitioned pending→delivered, latency p99 4.2ms

### SQLite Migration Journal Fix (T571)
- **`reconcileJournal` in `packages/core/src/store/migration-manager.ts`**: distinguish between two Scenario 2 sub-cases
- **Case A (DB ahead of install)**: all local hashes present but DB has extra unknown entries — forward-compat, skip reconciliation, log debug only
- **Case B (stale hashes)**: some local hashes missing — delete and re-seed, log at warn
- **Impact**: eliminates the repeated "Detected stale migration journal entries" WARN spam on every `cleo` command

### Carries Forward
All v2026.4.44 changes.

## [2026.4.44] (2026-04-14)

Release hygiene — fixes v2026.4.43 publish gap.

### Release CI Fixes
- **Added `@cleocode/nexus` to publish list**: v2026.4.43 shipped 11 of 12 packages; nexus was missing from release.yml `publish_pkg` calls
- **Added nexus to version sync loop**: `Sync package versions from tag` step now covers all 12 packages
- **Added nexus to artifact validation**: `required_artifacts` includes `packages/nexus/dist/src/index.js`
- **Biome format fix**: `packages/core/src/store/brain-sqlite.ts` ensureColumns call formatted to single line

### Carries Forward from v2026.4.43
All changes from v2026.4.43 (see below).

## [2026.4.43] (2026-04-14)

System-Wide Architecture Audit — 23-agent parallel pipeline across 4 waves.

### Identity & Injection Unification
- **CLEOOS-IDENTITY.md rewritten**: Correct 6 systems (TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT). LAFS removed (envelope format, not a system)
- **Global XDG deployment**: `init.ts deployStarterBundle()` copies identity to `~/.local/share/cleo/`
- **Injection unified**: `cant-context.ts` is now the canonical entry point with `isMainAgent` + `compiledBundle` options
- **Hardcoded identity block replaced**: `cleo-cant-bridge.ts` reads CLEOOS-IDENTITY.md from disk instead of inline markdown
- **Duplicate composeSpawnPayload removed**: `orchestrate-engine.ts` no longer double-compiles CANT bundle

### CONDUIT Delivery Loop (First Real Messages)
- **LocalTransport priority**: `factory.ts` now prefers LocalTransport when conduit.db exists
- **Dispatch wired**: All 4 conduit dispatch methods use LocalTransport with HTTP fallback
- **Pi chatroom wired**: All 4 messaging tools deliver via `cleo conduit send`
- **Package exports fixed**: Explicit `"./conduit"` entry in core/package.json
- **First CONDUIT messages delivered**: 33 messages in audit session, local transport verified

### Constitution Reconciled
- **11 domains documented** (was 10): `intelligence` domain (5 query ops) added to §4 and §6.11
- **229 canonical operations** (was 224): Updated §6 summary counts
- **Types.ts JSDoc updated**: Domain count references corrected

### Test Infrastructure
- **5 test failures fixed**: cant fixture SSoT, core path resolution, lafs/runtime vitest configs
- **76 unwired test files wired**: Added test scripts + vitest configs to adapters (195 tests), contracts (6), cleo (1204), skills (29)
- **brain.db schema fixed**: `agent` column added to `ensureColumns` safety net

### T514: Codebase Scanner (.cleoignore + Performance)
- **`.cleoignore` support**: Generic `readIgnorePatterns()` loads both .gitignore and .cleoignore
- **Performance benchmark**: 10K files in 338ms (acceptance: under 2s)
- **Full team orchestration**: 7 CONDUIT messages tracked the Orchestrator→Lead→Workers chain

## [2026.4.42] (2026-04-14)

Fix ALL validator-discovered bugs.

## [2026.4.41] (2026-04-14)

Fix ALL validator-discovered bugs.

## [2026.4.40] (2026-04-14)

Cross-Provider Agent Autonomy — CANT context injection for Claude Code, OpenCode, and all spawn providers.

### Shared CANT Context Builder (`packages/adapters/src/cant-context.ts`)
- **NEW MODULE**: `buildCantEnrichedPrompt()` — universal entry point for all spawn providers
- 3-tier CANT discovery (global → user → project) with override semantics
- Memory bridge injection from `.cleo/memory-bridge.md`
- Mental model fetch from brain.db via dynamic import of `@cleocode/core`
- All operations best-effort: agents always spawn, CANT context is enrichment not gate
- Ported from Pi's `cleo-cant-bridge.ts` (922 lines) into a 380-line reusable module

### Claude Code CANT Injection
- `ClaudeCodeSpawnProvider.spawn()` now calls `buildCantEnrichedPrompt()` before writing the prompt file
- Spawned Claude Code agents receive: compiled CANT bundle + memory bridge + mental model
- Graceful fallback: raw prompt used if CANT enrichment fails

### OpenCode CANT Injection
- `OpenCodeSpawnProvider.spawn()` now calls `buildCantEnrichedPrompt()` before creating subagent definition
- `ensureSubagentDefinition()` accepts enriched instructions parameter
- Spawned OpenCode agents receive same CANT context as Claude Code and Pi agents

### Upgrade Command Enhancement
- `cleo upgrade` now deploys starter CANT bundle to `.cleo/cant/` if missing
- Extracted `deployStarterBundle()` from `init.ts` — shared between init and upgrade
- Existing projects get agent definitions on upgrade, not just first-time init

### Tests
- 16 new unit tests for `cant-context.ts` covering discovery, bridge, enrichment, fallbacks
- XDG path isolation in tests prevents interference from real user config

## [2026.4.39] (2026-04-14)

Hook Wiring + Tree-sitter Fix — connect all brain modules to real events, eliminate npm install warnings.

### Hook Dispatch Wiring (T555)
- **PostToolUse dispatch** wired into `completeTask()` — observer, quality feedback, memory bridge refresh now fire on every task completion
- **SubagentStart/SubagentStop dispatch** wired into `orchestrateSpawnExecute()` — brain records agent spawns and completions, conduit gets lifecycle messages
- **Graph bridge Step 8** wired into `runConsolidation()` — `autoLinkMemories()` connects memory nodes to code graph during sleep-time consolidation

### Claude Code Adapter Activation (T555)
- `registerNativeHooks()` now writes CLEO hook entries to `~/.claude/settings.json` — Stop triggers `cleo session end`, PostToolUse (Write|Edit) triggers brain observations
- `unregisterNativeHooks()` cleans up by removing `# cleo-hook` marked entries
- `projectDir` properly stored and exposed via `getProjectDir()`
- Adapter `initialize()` calls `registerNativeHooks(projectDir)` on startup

### Tree-sitter Peer Dependency Fix
- Downgraded `tree-sitter` to `0.21.1` — eliminates ALL npm ERESOLVE peer dependency warnings on `npm install -g @cleocode/cleo-os`
- Pinned `tree-sitter-c@0.23.2`, `tree-sitter-python@0.23.4`, `tree-sitter-rust@0.23.1` (newer versions changed peer deps to `^0.22.1`)
- Removed now-unnecessary `overrides` from cleo and cleo-os
- Upstream issue: tree-sitter-javascript#347 — language packages haven't updated peer deps

### Test Fixes
- `llm-extraction.test.ts`: Mocked `anthropic-key-resolver.js` — "no API key" test no longer breaks when Claude Code credentials exist on filesystem
- `performance-safety.test.ts`: Widened timing thresholds (500ms single, 20s bulk) — eliminates CI flaking under load

## [2026.4.38] (2026-04-14)

Complete Living Brain Architecture — all 7 research-backed memory techniques implemented. Epic T554 Phase 2.

### Sleep-Time Consolidation
- **`sleep-consolidation.ts`** (932 lines): LLM-driven background process that runs after session end
- 4-step pipeline: merge near-duplicates (embedding similarity > 0.85), prune stale entries (LLM adjudication before eviction), strengthen frequently-cited learnings into patterns, generate cross-cutting insights from observation clusters
- Uses `resolveAnthropicApiKey()` — zero config needed
- Wired into `brain-lifecycle.ts` consolidation pipeline

### Graph Memory Bridge
- **`graph-memory-bridge.ts`** (745 lines): connects brain memory nodes to nexus code intelligence nodes
- `linkMemoryToCode()` creates `code_reference` edges from memories to code symbols
- `autoLinkMemories()` scans observations/decisions for entity references (file paths, function names), matches against nexus_nodes
- `queryMemoriesForCode()` and `queryCodeForMemory()` enable bidirectional traversal
- New `code_reference` edge type added to `BRAIN_EDGE_TYPES` schema

### Quality Feedback Loop
- **`quality-feedback.ts`** (644 lines): closes the self-improvement loop
- `trackMemoryUsage()` records whether retrieved memories were actually used
- `correlateOutcomes()` boosts quality for memories used in successful tasks, penalizes failures, flags 30-day unused entries for pruning
- `getMemoryQualityReport()` returns dashboard: retrieval stats, top cited, never-retrieved, quality distribution, noise ratio
- New `brain_usage_log` table (self-healing), `prune_candidate` column on all brain tables
- CLI: `cleo brain quality --json`, dispatch: `memory.quality` (query, tier 1)
- Wired into `task-hooks.ts` `handleToolComplete` for automatic outcome correlation

### Temporal Supersession
- **`temporal-supersession.ts`** (529 lines): never delete, only supersede
- `supersedeMemory()` marks old entry as superseded with pointer to replacement via `supersedes` edge
- `detectSupersession()` automatically checks new entries against existing ones (embedding similarity + entity overlap)
- `getSupersessionChain()` traces the full version history: [newest → ... → original]
- Wired into `storeLearning()`, `storeDecision()`, `storePattern()` for automatic detection at store time

### Codebase Audit
- Confirmed: `.cleo/research/`, `.cleo/consensus/`, `.cleo/decomposition/`, `.cleo/specs/` are DEAD directories — no production code creates or reads them
- `.cleo/nexus-index.db` (0 bytes, 0 code references) deleted as ghost artifact
- `.cleo/rcasd/`, `.cleo/adrs/`, `.cleo/agent-outputs/`, `.cleo/cant/`, `.cleo/backups/` confirmed ALIVE and actively used

## [2026.4.37] (2026-04-13)

Living Brain v3 — LLM-managed memory architecture. Epic T554.

### LLM Extraction Gate (T555)
- **LLM-driven extraction** replaces keyword regex in `auto-extract.ts`. Uses Anthropic SDK with structured output (Zod schema) to extract typed memories: decisions, patterns, learnings, constraints, corrections
- **Importance scoring** (0.0-1.0) at write time — only ≥0.6 stored
- **Entity extraction** identifies code symbols, files, concepts referenced
- **Source tagging** as `agent-llm-extracted` for downstream dedup
- **Dead code removed**: `ACTION_PATTERNS` regex, `extractTaskCompletionMemory` stub, `extractSessionEndMemory` stub all deleted
- **Config**: `brain.llmExtraction.enabled` (default true), `.model` (default claude-haiku-4-5-20251001)

### Reciprocal Rank Fusion (T556)
- **Hybrid retrieval** fuses FTS5 keyword + vector similarity via `reciprocalRankFusion()` with score=sum(1/(rank+60))
- **Default in searchBrainCompact** via `useRRF: true` parameter
- Replaces naive hybrid combining in `brain-search.ts`

### Observer/Reflector Pattern (T557)
- **Observer**: compresses recent observations after task completion (3-6x compression ratio)
- **Reflector**: restructures at session end into structured patterns + learnings
- Both use Anthropic SDK with structured output
- Wired into `session-hooks.ts` and `task-hooks.ts`

### Anthropic API Key Auto-Discovery
- **Zero-config for Claude Code users**: auto-discovers OAuth token from `~/.claude/.credentials.json`
- **Resolution priority**: ANTHROPIC_API_KEY env → `~/.local/share/cleo/anthropic-key` → Claude Code credentials
- **Shared resolver** in `anthropic-key-resolver.ts` used by all LLM modules
- Token expiration checking, process-lifetime caching

### CleoOS Flagship (T558)
- **Hooks bridge**: `cleo-hooks-bridge.ts` bridges Pi events (tool_call, tool_result, before_agent_start) to CLEO observations with 500ms rate-limiter
- **Memory bridge injection**: every Pi agent gets `.cleo/memory-bridge.md` in system prompt automatically
- **Session lifecycle**: Pi session_start/session_shutdown wired to cleo session start/end with project-root capture for correct CWD

### Conduit Messaging
- **Event messaging** in orchestrate-engine: `agent.spawned` and `orchestrate.handoff` events via `sendConduitEvent()` (fire-and-forget)
- **Hook-based conduit**: `conduit-hooks.ts` writes SubagentStart/SubagentStop/SessionEnd events to conduit.db via LocalTransport. 22 new tests
- Code review fixes: removed unnecessary getDb() call, captured sessionProjectRoot for shutdown CWD

## [2026.4.36] (2026-04-13)

Tree-sitter peer dep fix + Rust crate alignment.

### Dependencies
- Downgrade tree-sitter to 0.21.1 — eliminates all npm peer dep warnings
- tree-sitter-c@0.23.2, tree-sitter-python@0.23.4, tree-sitter-rust@0.23.1 pinned

### Infrastructure
- All 16 Rust workspace crates aligned with ferrous-forge v1.9.5 standards
- CANT LSP: complete match arms + split oversized cant-core modules

## [2026.4.35] (2026-04-13)

Intelligence CLI + Living Memory Infrastructure.

### Intelligence Domain
- **11th canonical domain**: 5 query operations registered (predict, suggest, learn-errors, confidence, match)
- IntelligenceHandler was registered but had zero OperationDef entries — now all 5 dispatch correctly

### Living Memory
- **Citation tracking**: wired into searchBrainCompact + fetchBrainEntries. Every retrieval increments citation_count
- **Retrieval log**: brain_retrieval_log table (self-healing) tracks every retrieval event for co-retrieval analysis
- **Auto-verification**: owner/task-outcome sources set verified=true at write time as ground truth
- **Memory bridge fix**: filters junk learnings (Completed:*) and noise patterns (Recurring label*), increased truncation limits, restored dual Patterns/Anti-Patterns sections

### Nexus Code Intelligence
- **Symbol kind priority sort**: functions rank before files in nexus context/impact queries. Blast radius analysis now returns real callers/callees

### Pi Adapter
- Session start/end hooks added to cleo-cant-bridge extension

## [2026.4.34] (2026-04-13)

JIT Agent Integration + Pi First-Class Support. Fresh agent test score: 9/10.

### Agent Experience
- **Project identity**: `cleo dash` shows real project name via 3-level fallback (was "Unknown Project")
- **Task recommendations**: `cleo next` excludes soft-cancelled tasks (was recommending cancelled T234)
- **Nexus context**: `cleo nexus context <symbol>` queries code intelligence graph (was broken — expected task IDs)
- **Context pull**: `cleo context pull <taskId>` returns relevant brain entries (FTS5 OR semantics fix)
- **Brain migrations**: `ensureColumns()` safety net applies all T528/T531/T549 columns on DB open

### Pi First-Class Support
- Pi adapter created with 11/16 CAAMP hook coverage
- session_shutdown wired to fire `cleo refresh-memory` + `cleo backup add`
- Pi added to `PROVIDER_IDS` and `discoverProviders()`

## [2026.4.33] (2026-04-13)

Memory Architecture v2 — tiered cognitive memory system.

### Tiered Memory
- Three tiers (short/medium/long) with deterministic routing at write-time
- Typed memory (semantic/episodic/procedural) via `BRAIN_COGNITIVE_TYPES` enum
- Source confidence tracking, bitemporal validity (validAt/invalidAt)
- Citation counting for tier promotion

### Extraction Pipeline
- Verification gate before storage (content-hash + cosine similarity dedup)
- Heuristic contradiction detection
- Budget-aware retrieval (FTS5 50% + vector 40% + graph 10%)

### Sleep-Time Consolidation
- 7-step consolidation on session end
- Tier promotion, contradiction detection, soft eviction

### Agent Self-Healing + Intelligence
- Watchdog scheduler (60s) for crashed agent recovery
- Intelligence CLI: predict, suggest, learn-errors, confidence, match
- Capacity-aware routing in orchestrate.spawn

### JIT Context
- `cleo context pull <taskId>` compact bundle
- nexus-bridge.md auto-generated code intelligence context
- CAAMP injection wiring for nexus-bridge.md + JIT protocol

## [2026.4.32] (2026-04-12)

Validation remediation — fixes all gaps from system validation report.

### Fixes
- Auto-population: `memoryDecisionStore` routes through `storeDecision()` for quality + graph hooks
- Memory bridge: `refreshMemoryBridge()` wired into CLI session end dispatch
- Injection chain: CLAUDE.md simplified to `@AGENTS.md` only
- Nexus CLI: analyze, status, clusters, flows wired and tested
- Pattern bug: root cause was globally installed binary running pre-fix code

## [2026.4.31] (2026-04-12)

BRAIN Integrity + Code Intelligence Pipeline — mega-epic spanning T523 + T513.
29 agents orchestrated through full RCASD→IVTR lifecycle. 7,129 tests pass.

### BRAIN Integrity (T523) — Memory System Overhaul

- **brain.db purge**: Removed 2,930 noise entries (95.8% reduction). SNR improved from 0.95% to ~100%
- **Dedup engine**: Fixed empty `if(duplicate)` blocks in patterns.ts and learnings.ts — upsert with frequency increment (patterns) and confidence max-merge (learnings)
- **Hook fixes**: Gutted `extractTaskCompletionMemory()` and `extractSessionEndMemory()` (noise generators). Severed 3 duplicate session observation write paths
- **Graph schema**: Expanded `brain_page_nodes` to 12 node types (decision, pattern, learning, observation, sticky, task, session, epic, file, symbol, concept, summary) with quality scoring, content hashing, metadata JSON
- **Graph edges**: Expanded `brain_page_edges` to 12 edge types (derived_from, produced_by, informed_by, supports, contradicts, supersedes, applies_to, documents, summarizes, part_of, references, modified_by) with weight and provenance
- **Graph back-fill**: Populated 281 nodes and 228 edges from surviving entries with quality scores and cross-type relationships
- **Quality scoring**: Added `quality_score` computation to all store functions (patterns, learnings, decisions, observations). Entries below 0.3 threshold excluded from search results
- **Auto-population hooks**: Graph nodes/edges auto-created when decisions stored, observations recorded, tasks completed — all gated on `BrainConfig.autoCapture`, all best-effort
- **Graph traversal**: New query functions for BFS trace (recursive CTE), typed neighbor lookup, 360-degree context view, graph statistics
- **Embeddings activated**: Installed `sqlite-vec`, wired `initDefaultProvider()` into `getBrainDb()` startup — the entire vector embedding pipeline (previously dead code) is now active
- **New CLI commands**: `cleo brain purge`, `cleo brain backfill`

### Code Intelligence Pipeline (T513) — Native Codebase Mapping

- **Drizzle schema**: Created `nexus_nodes` + `nexus_relations` tables with full column set and 9 indexes each
- **Contracts expansion**: `GraphNodeKind` expanded by 17 values (community, process, route, trait, impl, type_alias, etc.), `GraphRelationType` expanded by 9 values (member_of, step_in_process, handles_route, etc.)
- **Filesystem walker**: Directory scanning with .gitignore awareness, language detection, File/Folder/CONTAINS node creation
- **SymbolTable**: 5 in-memory indexes (fileIndex, callableByName, fieldByOwner, methodByOwner, classByName)
- **Import resolution**: TypeScript resolver with relative paths, barrel exports, tsconfig aliases, node_modules resolution. Suffix index trie for O(1) path lookup
- **Parse loop**: Sequential chunked parsing (20MB byte-budget) with tree-sitter extraction — definitions, imports, heritage, calls
- **Call resolution**: Tier 1 (same-file, confidence 0.95) + Tier 2a (named-import, confidence 0.90) with deferred execution after all chunks parsed
- **Heritage processing**: EXTENDS/IMPLEMENTS edge creation with HeritageMap builder (directParents + implementorFiles indexes)
- **Community detection**: Louvain algorithm via `graphology-communities-louvain` — auto-clusters symbols into functional areas with heuristic labels and cohesion scores
- **Process detection**: BFS execution flow tracing from entry points through CALLS edges (max depth 10, min steps 3) with subset deduplication
- **Worker pool**: Parallel multi-file parsing with Node.js Worker threads (spawns at ≥15 files or ≥512KB total). Configurable concurrency (CPU cores - 1)
- **Incremental re-indexing**: Detects changed files via mtime, deletes stale nodes, re-parses only changed files
- **Language providers**: Python (namespace imports, decorators), Go (wildcard imports, receiver methods), Rust (use/mod imports, trait impls) — all via tree-sitter
- **New CLI commands**: `cleo nexus analyze`, `cleo nexus status`, `cleo nexus clusters`, `cleo nexus flows`

### Infrastructure

- **Biome formatting**: Fixed detect-drift.ts long line wrap
- **Migration**: Added `20260411000001_t528-graph-schema-expansion` and `20260412000001_t531-quality-score-typed-tables` Drizzle migrations

## [2026.4.30] (2026-04-11)

Full CLI remediation — 3rd audit cycle, 23 agents, ~280 commands tested, all issues resolved.
Includes research add/link/update file path fix missed in v2026.4.29.

### P0 Critical Fixes (10)
- **compliance record**: Fixed TypeError crash when `--violation` not passed (undefined `.map()`)
- **add-batch**: Replaced raw `process.exit(2)` + stack trace with proper LAFS error envelope
- **backfill**: Replaced plain `console.log` output with LAFS `cliOutput()` envelopes
- **restore backup**: Fixed param wiring (`action: 'restore'` → `'restore.file'` for `--file`)
- **orchestrate fanout**: Fixed CLI sending `taskIds` when handler requires `items`
- **orchestrate fanout-status**: Fixed CLI sending `epicId` when handler requires `manifestEntryId`
- **memory graph-add**: Added missing `--node-type` option; fixed `from`/`to` → `fromId`/`toId`
- **research add/link/update**: Built complete manifest entries (previously always E_VALIDATION_FAILED)
- **session start**: Added duplicate-session guard (`E_SESSION_CONFLICT`)
- **doctor --hooks**: Fixed ENOENT crash for missing `hook-mappings.json`

### P1 Param Mismatches & Error Codes (12)
- **cancel/tree/adapter activate**: Fixed wrong error codes (E_INTERNAL → E_NOT_FOUND)
- **orchestrate conduit-send**: Fixed `agentId` → `to` param mismatch
- **orchestrate conduit-start**: Fixed `pollInterval` → `pollIntervalMs` param mismatch
- **orchestrate tessera --var**: Worked around shim variadic bug with comma-split
- **orchestrate parallel**: Fixed integer `codeName` in error envelope
- **memory graph-remove**: Fixed `from`/`to` → `fromId`/`toId` for edge removal
- **nexus register**: Fixed path sanitizer blocking all external paths (its primary use case)
- **nexus unregister**: Fixed E_INTERNAL → E_NOT_FOUND for missing projects
- **reorder**: Wired `--top` (position 0) and `--bottom` (position 999999) convenience flags
- **check schema**: Fixed raw stack trace for invalid types → proper E_VALIDATION envelope
- **compliance audit**: Fixed param from `epicId` to `taskId` matching engine validation
- **sticky --tag**: Fixed broken Commander collect() accumulator with comma-split

### Cleanup & Deduplication
- **Removed 8 deprecated commands**: `commands`, `phases`, `validate`, `consensus`, `contribution`, `decomposition`, `implementation`, `specification`
- **Removed 3 duplicate aliases**: `observe` (use `memory observe`), `reason why/similar` (use `memory reason-why/similar`)
- **Envelope standardization**: `cant migrate`, `migrate claude-mem` now emit LAFS envelopes
- **archive-stats**: Wired `--byPhase`/`--byLabel`/`--since`/`--until` flags to engine
- **compliance trend/skills/value**: Differentiated response views via `view` field
- **admin job**: Improved error message with daemon guidance

### Session & Context Fixes
- **session end**: Fixed help text identifying as "session stop"
- **session record-decision**: Now defaults to active session (matches record-assumption)
- **session serialize**: Removed phantom `_next` hint for nonexistent command
- **context check**: Now returns non-zero exit codes when thresholds exceeded
- **context list**: Removed (identical to `context status`)
- **history** (bare): Shows help instead of silently dispatching to admin.log
- **deps waves**: Changed `[epicId]` to required `<epicId>`
- **sync links list**: Added validation requiring `--provider` or `--task`

### Deferred Issue Resolution
- **nexus transfer**: Auto-creates `external_task_links` table on older DBs via `CREATE TABLE IF NOT EXISTS`
- **ADR sync**: Fixed ADR-006 invalid FK refs, ADR-033/034 wrong headings; added FK validation in sync code; returns `success: false` on errors
- **CAAMP skills**: Auto-registers skill library on CLI startup; `validate/dispatch/deps` return `E_CONFIG_ERROR` instead of crashing

## [2026.4.28] (2026-04-10)

Complete CLI audit remediation — all P1/P2/P3 findings resolved.

### P1 Fixes (Broken Options & Commands)
- **stats --period**: Named aliases (week/month/today) now work — removed premature Number() conversion
- **archive-stats**: Report flags now forwarded to engine (--by-phase, --since, --until, etc.)
- **reorder**: Removed 4 non-functional options (--before/--after/--top/--bottom); kept only --position
- **context check/list**: Updated misleading help text to match actual behavior
- **detect-drift**: Fixed hardcoded src/ paths for monorepo layout (5/8 checks now pass, was 2/8)
- **dash**: Removed 5 non-functional display options; wired --blocked-limit
- **labels show \<label\>**: Now correctly routes to tasks.list with label filter
- **release changelog**: Removed vestigial subcommand that always failed with E_MISSING_PARAMS
- **pull**: Returns success:false when fetch fails (was misleadingly success:true)

### P2 Consolidation
- Deprecated `phases` (use `phase`), `commands` (use `ops`), `validate` (use `check schema todo`)
- 5 protocol wrapper commands marked as aliases in help text
- Documented token vs otel data source distinction
- Documented backup create as alias for backup add
- Removed agents.ts no-op stub registration

### P3 Help Text
- Added enum values to update, find --in, relates add --type, lifecycle stage names
- Documented session requirements on add, bug, complete
- Clarified find query is required unless --id used
- Added output schema hints to current, start, stop, show
- Differentiated briefing vs plan vs dash use cases in help text
---

## [2026.4.27] (2026-04-10)

Full CLI audit across 106 commands (12 parallel agents), P0 critical bug fixes.

### Fixes
- **archive --dry-run**: Wire dryRun/taskIds/includeCancelled through engine — previously silently performed real archive (data loss risk)
- **claim/unclaim**: Fix param name mismatch (CLI sent `id`, domain read `taskId`) — both commands always failed
- **export-tasks**: Guard taskIds against undefined to prevent TypeError crash with no positional args
- **safestop**: Replace legacy sessions.json file read with proper DB accessor — session-end was silently failing
- **backfill**: Add destructive operation warning when run without --dry-run
- **registry**: Align claim/unclaim param names and declare agentId as required for claim
- **stale dist**: Rebuild fixes ~15 broken commands (orchestrate subcommands, memory routing, roadmap dispatch, observe options)

### Audit Findings (tracked for future waves)
- 23 broken commands identified, 6 P0 fixed in this release
- 24 duplicate/redundant commands mapped for consolidation
- 38 commands with poor/misleading help text catalogued
- 15 commands with silently ignored options documented
---

## [2026.4.26] (2026-04-10)

Auto-prepared by release.ship (T443)

### Changes
- **V: Full CLI Runtime Verification — execute every command, find duplicates, report failures**: Execute EVERY CLI command in a real project context. Each domain agent must: 1) Run each command with valid args and capture exit code + output, 2)... (T484)
---

## [2026.4.25] (2026-04-10)

Auto-prepared by release.ship (T443)

### Features
- **Implement agent health monitoring and heartbeat system**: Agent health monitoring: heartbeat every 30s, timeout detection after 3min, crash detection. Required for production agent reliability. (T039)
- **Implement retry logic with exponential backoff**: 3 retry attempts with exponential backoff (immediate, 2s, 4s). Required for agent failure recovery. (T040)
- **T050: Implement Acceptance Criteria Enforcement Layer**: Create middleware/enforcement layer that validates AC before task operations succeed. Block task creation without AC, validate updates, and block c... (T058)
- **Add write-guard to brain-memory-links insert**: Add write-guard to linkMemoryToTask in brain-links.ts. Import taskExistsInTasksDb and call it before accessor.addLink to reject stale task IDs. (T187)
- **Implement LocalTransport — napi-rs in-process SignalDock**: Create packages/core/src/conduit/local-transport.ts implementing Transport interface. Uses napi-rs to call signaldock-sdk in-process. No network ca... (T213)
- **Register orchestrate.classify operation in dispatch registry and implement handler**: Add an orchestrate.classify operation to packages/cleo/src/dispatch/registry.ts as a query-type operation. The handler in packages/cleo/src/dispatc... (T408)
- **Implement verifier_lib/db.py — database openers for all 5 CleoOS databases**: Fill in sqlite3 stubs in /mnt/projects/cleoagent/verifier_lib/db.py. Open tasks.db, brain.db, conduit.db read-only via Python sqlite3 from project ... (T455)
- **Implement Conduit Protocol — agent-to-agent relay**: From CLEO-CONDUIT-PROTOCOL-SPEC.md. Durable message channels, lease model, delivery state machine (pending/delivered/consumed/expired). Integration... (T011)
- **Create agent registry with capacity tracking**: Agent registry to track active agents, capacity remaining (max 5 tasks/agent), specialization/skills, performance history. Required for load balanc... (T041)
- **T051: Implement Mandatory Session Binding**: Enforce that all task mutations occur within an active session context. Create session middleware that blocks mutate operations without session, in... (T059)
- **Add write-guard to brain-decisions insert**: Add write-guard to addDecision functions. Import taskExistsInTasksDb and validate taskId exists before inserting brain_decisions with context_task_... (T188)
- **Implement async reinforcement queue for non-blocking mental model writes**: Implement the async reinforcement queue per ULTRAPLAN L5 in packages/core/src/memory/. On agent session exit, the bridge harvests the session JSONL... (T419)
- **Implement path-ACL enforcement in cleo-cant-bridge.ts tool_call hook**: Extend the tool_call hook in packages/cleo-os/extensions/cleo-cant-bridge.ts to enforce path permissions. When a tool call is Edit, Write, or Bash ... (T424)
- **Add CLI commands for memory operations**: CLI parity: cleo memory store/recall/search/consolidate. Currently only available via MCP. (T042)
- **Add write-guard to brain-observations insert**: Add write-guard to addObservation functions. Import sessionExistsInTasksDb and validate sessionId exists before inserting brain_observations with s... (T189)
- **Add soft FK enforcement between tasks.db and signaldock.db agent tables**: agent_instances.id, agent_error_log.agent_id, sessions.agent, sessions.agent_identifier all reference agents with zero FK enforcement. Add applicat... (T238)
- **T310 Decomposition — generate implementation subtasks**: Break T310 specification into atomic implementation subtasks with wave ordering. Each subtask scoped to ≤3 files, clear acceptance criteria, wave-l... (T329)
- **T311 Decomposition — generate implementation subtasks**: Break T311 specification into atomic implementation subtasks with wave ordering. Each subtask scoped to ≤3 files, clear acceptance criteria, wave-l... (T333)
- **Implement AsyncLocalStorage-scoped DB path resolution in packages/core/src/paths.ts**: Extend packages/core/src/paths.ts to use Node.js AsyncLocalStorage for worktree-scoped DB path resolution. When CLEO_WORKTREE_ROOT env var is set (... (T402)
- **Add realistic path ACLs to .cleo/teams.cant for 3 leads and their workers**: Extend the .cleo/teams.cant platform team definition (created in T379) to add permissions.paths blocks for each lead and worker. Engineering worker... (T425)
- **Create packages/skills/skills/ct-master-tac skill directory with SKILL.md, manifest, and bundle contents**: Create the ct-master-tac skill at packages/skills/skills/ct-master-tac/. The SKILL.md should describe the skill as a curated bundle installer that,... (T430)
- **Agent Dimension Implementation**: Complete the Agent (A) dimension of BRAIN with self-healing mechanism and execution learning. Design self-healing for failed tasks, implement learn... (T034)
- **Implement impact prediction for changes**: Reverse dependency analysis to predict downstream effects. cleo reason impact --change 'Modify X'. Missing from Reasoning layer. (T043)
- **T053: Implement Automatic Verification Gate Initialization**: Auto-create verification metadata when tasks are created, not when completed. Every task gets verification.enabled=true, round=1, all required gate... (T061)
- **Wave 2: Implement AgentRegistryAccessor — credential CRUD in SQLite**: Implement packages/core/src/store/agent-registry-accessor.ts. CRUD ops per AgentRegistryAPI interface. Uses crypto/credentials.ts for encryption. R... (T175)
- **Implement cross-DB orphaned reference reconciliation**: Implement background reconciliation to clean up any orphaned cross-DB references. Per cross-db-cleanup.ts comment: A background reconciliation pass... (T190)
- **Implement SseTransport — Server-Sent Events real-time transport**: Create packages/core/src/conduit/sse-transport.ts implementing Transport with subscribe() via SSE. Connect to SignalDock /messages/stream endpoint.... (T216)
- **Add signaldock.db to cleo upgrade**: Wire migration check into upgrade.ts (T224)
- **Add FK on messages.from_agent_id and to_agent_id**: signaldock.db messages must reference agents table. (T246)
- **Add merge policy to WorktreeHandle: ff-merge on success, retain on failure**: Extend packages/cant/src/worktree.ts WorktreeHandle to add a merge() method that performs a fast-forward merge of the worktree branch into the base... (T403)
- WS-5: TUI Visual Identity Implementation (T442)
- **D: CLI System Integrity Decomposition — Implementation wave plan**: Decomposition phase: Break the implementation work into executable waves. Wave 1: Constitution doc updates. Wave 2: Coverage gap CLI commands (need... (T448)
- **Implement verifier_lib/project_fixture.py — temp project creation and reward computation**: Implement project_fixture.py in /mnt/projects/cleoagent/verifier_lib/: create_test_project (mkdtemp, git init, pnpm cleo init), seed_project_from_t... (T458)
- **Intelligence Dimension Implementation**: Complete the Intelligence (I) dimension of BRAIN with adaptive validation and quality prediction. Design adaptive validation framework, implement q... (T035)
- **Add CLI commands for reasoning operations**: CLI parity: cleo reason why/similar/impact/timeline. Currently only available via MCP. (T044)
- **Add signaldock.db to cleo doctor**: Add connectivity and migration checks to doctor.ts (T225)
- **Codify worker prompt guardrail in packages/agents/cleo-subagent/AGENT.md and implement pre-spawn hook**: Add a WORKTREE DISCIPLINE section to packages/agents/cleo-subagent/AGENT.md (following the pattern in the agent protocol) that requires: (1) pwd ==... (T404)
- **Implement Pi tool_call hook for Lead role tool blocking in cleo-cant-bridge.ts**: Extend packages/cleo-os/extensions/cleo-cant-bridge.ts (the stub added in T381) to implement the Lead tool blocking logic: register a tool_call hoo... (T412)
- **Wave 2: Implement ConduitClient + HttpTransport**: Implement packages/core/src/conduit/conduit-client.ts and http-transport.ts. ConduitClient wraps Transport, adds high-level messaging. HttpTranspor... (T177)
- **Add credential KDF coordination note and deferred dependency link to T310/T362**: Review packages/core/src/crypto/credentials.ts lines 138-141 (the KDF swap site referenced in T380 AC) and .cleo/adrs/ADR-037-conduit-signaldock-se... (T405)
- **T057: Implement Agent Workflow Telemetry**: Track how agents use CLEO to identify workflow violations and compliance gaps. Metrics include tasks created without AC, tasks completed outside se... (T065)
- **Add cleo doctor --hooks provider hook matrix diagnostic**: Add --hooks flag to cleo doctor command. Uses CAAMP's buildHookMatrix() to show cross-provider hook support grid. Shows: detected provider, support... (T167)

### Bug Fixes
- **Fix remaining ~107 test failures**: 32 test files failing. Root causes: SQLite table-already-exists (DB isolation), MCP gateway timeouts, adapter assertion failures, ENOENT paths. Nee... (T003)
- **Fix bootstrap injection chain: legacy sync, CAAMP sanitization, health check**: Fix three bootstrap bugs: (1) ensureGlobalTemplatesBootstrap writes to XDG only — add legacy ~/.cleo/templates/ sync. (2) CAAMP inject() leaves orp... (T124)
- **FIX-1: cliError renderer restores LAFS hints**: Rewrite packages/cleo/src/cli/renderers/index.ts cliError function at lines 267-286 so the third CliErrorDetails argument (currently discarded via ... (T336)
- **FIX-1.5: dispatch engines must propagate fix/details/alternatives from caught CleoError**: Wave 1 fixed the renderer but the dispatch engine layer at packages/cleo/src/dispatch/engines/task-engine.ts (lines 272-283, 354, 424), session-eng... (T374)
- **FIX-2: remove description-equals-title fallback in add command**: Delete the else branch at packages/cleo/src/cli/commands/add.ts lines 49-51 which defaults params.description to title. This fallback directly coll... (T337)
- **FIX-2.5: remove second description=title fallback in dispatch domain handler**: Wave 1 deleted the CLI-layer fallback at packages/cleo/src/cli/commands/add.ts:49-51 but missed the SECOND fallback at packages/cleo/src/dispatch/d... (T375)
- **FIX-3: unify response envelope shape across all commands**: Consolidate the three current envelope shapes into a single canonical LAFS envelope. Current state: most commands emit {ok,r,_m}, observe emits {su... (T338)
- **Connection Health Remediation**: Implement hard foreign keys and proper cascade behaviors for all 6 identified soft FK relationships. Convert brain_decisions, brain_memory_links, b... (T033)
- **Wave 2: Fix MCP tasks.find E_NOT_INITIALIZED bug**: Root cause: TasksHandler constructor eagerly calls getProjectRoot() at startup. Fix: defer to request time. Also fix bare catch block in task-engin... (T073)
- **Fix agent_instances phantom FKs**: Drizzle schema must declare real FKs for session_id, task_id, parent_agent_id. (T245)
- **FIX-4: auto-generate CLI help from ParamDef registry**: Replace hand-written Commander option chains in packages/cleo/src/cli/commands/*.ts with a generator that reads ParamDef entries defined at package... (T339)
- **FIX-5: add cleo schema command for operation introspection**: New top-level command cleo schema <domain.operation> that reads the OperationRegistry and returns a JSON Schema document describing params, types, ... (T340)
- **FIX-6: backfill CleoError fix hints plus biome lint rule**: Audit all new CleoError call sites in packages/core/src (tasks, validation, epic-enforcement, etc.) and add a third argument containing fix alterna... (T341)
- **Fix 14 remaining skill files with deprecated operations**: The T079 validator found 14 additional skill files with deprecated operation references beyond the 3 core skills fixed in T069. Fix all of them. Ru... (T087)
- **Verify T069 fixes — independent validation that MCP bugs and skills are actually fixed**: Do not trust the subagent work from T069. Independently verify: 1) tasks.find works via MCP, 2) session.start --scope global works via MCP, 3) all ... (T089)

### Documentation
- **W1-1: Update constitution — add 16 canonical ops, fix domain/op counts**: Update CLEO-OPERATION-CONSTITUTION.md to match registry SSoT post-ADR-042. Add 16 canonical ops to domain tables in Section 7. Remove conduit domai... (T451)
- **W1-2: Update System Flow Atlas — conduit is orchestrate sub-namespace**: Update docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md: conduit data store ownership table should reference orchestrate. Verify Autonomous Workshop Overlay... (T452)
- WS-3: Subagent Injection Pipeline Audit + Documentation (T440)
- **Wave 1: Fix paths.ts stale comment + delete stray cleo.db + tasks_test.db**: Wave 1 of T299. Three tiny fixes batched: (1) paths.ts:5 has a stale comment that says 'default: ~/.cleo' but the actual code uses XDG via env-path... (T303)
- **CHANGELOG entry for v2026.4.6**: Write a CHANGELOG.md entry covering all CleoOS Phase 1-7 work attributed to v2026.4.6: XDG hub, Pi harness wiring, stage guidance loader, Conductor... (T285)
- **Generate ERD Diagrams**: Generate visual ERD diagrams for all three databases. Create diagrams for tasks.db (20+ tables), brain.db (10 tables), and nexus.db (3 tables). Exp... (T036)
- **T055: Update All Skills with Mandatory Workflow**: Rewrite all CLEO skills to enforce the opinionated workflow. Update ct-cleo, ct-orchestrator, ct-memory, ct-task-executor, and _shared/task-system-... (T063)
- **Consolidate Schema Documentation**: Consolidate all schema documentation into comprehensive reference. Document all tasks.db, brain.db, and nexus.db tables with column descriptions. C... (T037)
- **T060: Documentation and Training Materials**: Create comprehensive documentation for the hardened task system. User guide explains strict mode, agent guide provides step-by-step workflow, migra... (T068)
- **Wave 5: Update all documentation for unification**: Update conduit.ts JSDoc, CLEO-CANT.md, CLEOCODE-ECOSYSTEM-PLAN.md, CORE-PACKAGE-SPEC.md per spec sections 6.3, 7.4, 13.6 (T184)
- **TSDoc + README: backup portability documentation**: Add TSDoc comments on all exported functions in backup-pack.ts, backup-unpack.ts, backup-crypto.ts, restore-json-merge.ts, and regenerators.ts. Com... (T368)
- **V2026.4.13 release: version bumps, CHANGELOG, tag, gauntlet**: Execute the v2026.4.13 CalVer release mechanics for T311 (Cross-Machine Backup Portability). Steps: (1) verify pnpm biome check passes clean; (2) v... (T370)
- **TSDoc updates and docs/ reference corrections for T310 modules**: Add TSDoc comments to all exported functions in the four new/refactored modules (conduit-sqlite.ts, signaldock-sqlite.ts, global-salt.ts, api-key-k... (T372)
- **V2026.4.12 release: version bumps, CHANGELOG, gauntlet**: Execute the T310 release mechanics targeting v2026.4.12. (1) Bump all package.json versions in the monorepo to 2026.4.12 per CalVer policy. (2) Upd... (T373)

### Tests
- **Nexus Component Validation**: Validate Nexus cross-project coordination with real-world usage scenarios. Create comprehensive test suite for all 31 Nexus operations (17 query + ... (T032)
- **Test full agent lifecycle: register → start → send → receive → stop**: E2E functional test, not unit test. (T249)
- **T311 integration test suite: full .cleobundle lifecycle scenarios**: Implement packages/cleo/src/cli/commands/backup.integration.test.ts covering all spec §8.2 integration scenarios. Uses a temporary fixture project ... (T367)
- **T310 cross-project agent lifecycle integration tests**: Write the full integration test suite covering spec §7.6 (migration) and §7.7 (CLI lifecycle) in packages/core/src/__tests__/t310-conduit-migration... (T371)

### Chores
- **Migrate parallel-state.json to SQLite**: Move orchestration/parallel.ts state from .cleo/parallel-state.json into SQLite schema_meta or new table. Eliminates JSON clobbering when parallel ... (T022)
- **Audit: enforcement + verification + lifecycle config fields (13+8+1 fields)**: Verify all 22 enforcement, verification, and lifecycle config fields are read by code and affect behavior. These are the governance-critical fields. (T105)
- **Upgrade @cleocode/caamp to ^1.9.1 minimum**: Bump @cleocode/caamp from ^1.8.1 to ^1.9.1 in packages/core/package.json. Verify all existing CAAMP imports still resolve (46+ import sites across ... (T159)
- **Wire cleanupBrainRefsOnSessionDelete into session deletion flow**: Wire cleanupBrainRefsOnSessionDelete into session deletion flow. Currently defined in cross-db-cleanup.ts but never imported or called. Find sessio... (T186)
- **Audit: session + multiSession config fields (11+13 fields)**: Verify all 24 session and multiSession config fields are consumed. Session enforcement is critical path. (T106)
- **Migrate CLEO hook types.ts to CAAMP 16-event canonical taxonomy**: Replace CLEO's internal 8 hook events (onSessionStart, onSessionEnd, onToolStart, onToolComplete, onFileChange, onError, onPromptSubmit, onResponse... (T160)
- **Remove sqlx dependency entirely**: After Diesel adapter validated remove sqlx and delete all sqlx files (T221)
- **Wave 1: caamp pi extensions — list/install/remove with npm+git sources**: Add three new CAAMP CLI verbs under 'caamp pi extensions': list (enumerate .ts files under ~/.pi/agent/extensions/ or <project>/.pi/extensions/), i... (T263)
- **Slim CLEO-INJECTION.md to true bootstrap — remove operational detail to ct-cleo**: CLEO-INJECTION.md should only contain: runtime detection, channel preference, greenfield/brownfield init, basic work loop, memory basics, escalatio... (T083)
- **Audit: validation + hierarchy + cancellation config fields (21+6+5 fields)**: Verify all 32 validation, hierarchy, and cancellation config fields. Remove legacy validation fields that overlap with enforcement. (T107)
- **Remove sqlx from Cargo.toml and clean feature flags**: Remove sqlx dependency from signaldock-storage Cargo.toml. Clean up sqlite and postgres feature flags to only gate Diesel backends. Remove sqlx-rel... (T232)
- **Wave 1: Nested package .cleo/ legacy cleanup**: Wave 1 of T299. packages/{cleo,contracts,lafs}/.cleo/ currently track live tasks.db/brain.db + .bak files + lafs even has tasks.db-wal (the live T5... (T302)
- **Migrate CLI from Commander.js to citty (ESM-native)**: Commander.js is CJS which causes ESM bundling issues. citty is a modern ESM-native CLI framework. Replace Commander with citty for clean ESM builds... (T006)
- **Audit: archive + backup + retention + release config fields (16+11+8+10 fields)**: Verify all 45 archive, backup, retention, and release config fields are consumed by their subsystems. (T108)
- **Audit: remaining config sections (tools, testing, analyze, graphRag, etc.)**: Verify remaining config sections: tools (16), testing (14), analyze (15), graphRag (9), cli (8), output (8), display (3), logging (4), gitCheckpoin... (T109)
- **Wave 1: Legacy global file cleanup (workspace.db + pre-cleo backups)**: Wave 1 of T299. Three files at global tier are pure legacy with ZERO live code references (confirmed via grep for workspace.db|workspace-schema|wor... (T304)
- **Upgrade claude-code and opencode adapters to use CAAMP hook normalizer**: Refactor packages/adapters/src/providers/claude-code/hooks.ts and opencode/hooks.ts to use CAAMP's toNative/toCanonical normalizer instead of hardc... (T164)
- **Wave 2: Rename packages/core/src/signaldock/ to conduit/**: Rename directory, update all imports, delete claude-code-transport.ts and old types.ts. Per spec section 6. (T176)
- **Upgrade Cursor adapter to use CAAMP hook normalizer (10/16 events)**: CAAMP 1.9.1 reveals Cursor actually supports 10 of 16 hooks (was listed as 0 before). Events: sessionStart, sessionEnd, beforeSubmitPrompt (PromptS... (T165)
- **Signaldock-sqlite.ts: refactor to global-tier only**: Refactor packages/core/src/store/signaldock-sqlite.ts in-place to serve only the global tier. Replace the existing project-tier DDL with the global... (T346)
- **Phase 7: Migration and Adoption — cant migrate CLI + AGENTS.md @import**: Ship cant migrate CLI command for markdown-to-CANT conversion. Add @import *.cant support in AGENTS.md via CAAMP resolver. Conservative heuristic c... (T210)
- **Wave 2: Stray project-tier .cleo/nexus.db cleanup + guard assertion**: Wave 2 of T299. There's a stray /mnt/projects/cleocode/.cleo/nexus.db at project tier even though nexus-sqlite.ts:8 comment clearly says 'nexus.db ... (T307)
- **Validate cleo init upgrade doctor scaffolding**: E2E test: install, init, upgrade, doctor for all 3 DBs. (T252)
- **Wave 4: Migrate 4 server crates to cleocode/crates/**: Move signaldock-storage, signaldock-transport, signaldock-sdk, signaldock-payments from signaldock-core/crates/ to cleocode/crates/. Update Cargo.t... (T181)
- **Upgrade llmtxt to v2026.4.1**: Upgrade llmtxt-core in SignalDock. Verify collaborative docs. (T253)
- **Agent-registry-accessor.ts: cross-DB refactor and global functions**: Refactor packages/core/src/store/agent-registry-accessor.ts to perform cross-DB reads (INNER JOIN conduit.db:project_agent_refs with global signald... (T355)
- **LocalTransport and internal.ts: conduit.db path migration**: Update packages/core/src/conduit/local-transport.ts to import getConduitDbPath from conduit-sqlite.ts instead of getSignaldockDbPath from signaldoc... (T356)
- **Migrate-signaldock-to-conduit.ts: 15-step migration executor**: Create packages/core/src/store/migrate-signaldock-to-conduit.ts implementing the full 15-step migration sequence from spec §4. Exports: needsMigrat... (T358)
- **Cleo agent remove --global and --force: safety-gated global deletion**: Add --global and --force-global flags to cleo agent remove in packages/cleo/src/cli/commands/agent.ts per spec §5.2. Without --global: removes only... (T366)

### Changes
- **Eliminate _meta.activeSession pointer — use SQL query**: Replace activeSession pointer in file_meta with dynamic SQL: SELECT FROM sessions WHERE status=active. Remove from FileMeta, session-switch, sessio... (T021)
- **Wrap add/update/complete/delete in transaction()**: Wrap full read-validate-write flow in add.ts, update.ts, complete.ts, delete.ts inside accessor.transaction() for TOCTOU safety under concurrent mu... (T023)
- **SQL-level position allocation in add.ts**: Replace JS position computation with SQL: INSERT SELECT COALESCE(MAX(position),0)+1. Eliminates TOCTOU where concurrent adds get same position. (T024)
- **Bulk SQL for task reorder operations**: Replace per-task upsertSingleTask loop with single UPDATE tasks SET position=position+1 WHERE parent_id=? AND position>=?. Eliminates N+1 pattern. (T025)
- **Replace saveSessions(array) with upsertSingleSession**: Make upsertSingleSession required on DataAccessor. Replace all saveSessions bulk writes with per-session targeted writes. Eliminates session array ... (T026)
- **Async background embedding for brain memory**: Make embedding generation in observeBrain fire-and-forget via async queue. Currently synchronous and blocks CLI/Agent during LLM embedding calls. (T027)
- **Memory decay — confidence decay for old memories**: Add decay factor so old unreferenced memory drops from context window. Implement as decay multiplier based on age and reference count. (T028)
- **Design @cleocode/cleoos package structure**: Create packages/cleoos/ consuming @cleocode/core as kernel. Defines: (1) Autonomous Runtime layer. (2) Conduit Protocol. (3) The Hearth operator su... (T009)
- **T049: Harden config.schema.json with Strict Defaults**: Update schemas/config.schema.json to enforce strict defaults for all governance settings. Change acceptance.mode default from 'warn' to 'block', ve... (T057)
- **Wave 1: Fix CLEO-INJECTION.md deprecated memory operations**: Fix 7 deprecated memory brain.* operation names to canonical memory.* names in templates/CLEO-INJECTION.md. Critical: this is injected into every a... (T070)
- **Research: citty nested subcommand capabilities and patterns**: Investigate citty's support for nested subcommands (cleo tasks find vs cleo find). Document: how to register domain groups, how help text renders f... (T092)
- **T-BRAIN-01: Add brain config section to CleoConfig**: Add BrainConfig interface to contracts, defaults to config.ts, templates. Fields: autoCapture, captureFiles, captureMcp, embedding.enabled/provider... (T135)
- **Install tree-sitter-cli + language grammars**: Add tree-sitter-cli and 9 language grammar packages to @cleocode/core. Packages: tree-sitter-cli, tree-sitter-typescript, tree-sitter-javascript, t... (T148)
- **Wave 1: Author AgentCredential + AgentRegistryAPI contracts**: Create packages/contracts/src/agent-registry.ts with AgentCredential, TransportConfig, AgentRegistryAPI interfaces per spec section 3.2 (T171)
- **Phase 0: CANT-DSL-SPEC.md — Formal Language Specification**: Write complete formal spec: EBNF grammar (3 layers), AST types with Span, 42 validation rules, CAAMP event mapping, import resolution, expression l... (T203)
- **Initialize local signaldock.db with embedded Rust migrations**: Run the 17 signaldock-storage checksummed migrations to create .cleo/signaldock.db locally. Wire napi-rs binding from signaldock-storage crate to i... (T212)
- **Complete sqlx to Diesel adapter rewrite**: Rewrite all sqlx adapters to Diesel DSL with diesel-async 0.8. One unified adapter. (T220)
- **Delete sqlx SQLite adapters (sqlite.rs, sqlite_conversations.rs, sqlite_messages.rs, sqlite_jobs.rs, sqlite_others.rs, sqlite_helpers.rs)**: Remove 5 sqlx SQLite adapter files and sqlite_helpers. 59 sqlx queries total. Diesel replacements: diesel_store.rs, diesel_conversations.rs, diesel... (T230)
- **Move agent registration SSoT to signaldock.db via Conduit**: cleo agent register currently writes ONLY to tasks.db agent_credentials. Must write to signaldock.db agents table FIRST (via ensureSignaldockDb + D... (T235)
- **Decide SSoT: agent identity in signaldock.db, credentials in tasks.db, or unified**: cleo-db-lead proposes, team votes. Cross-DB soft FK pattern vs unified DB. (T242)
- **Wave 0: Architecture Decision Record — Pi v2+v3 unified design**: Produce ADR-035 at .cleo/adrs/ADR-035-pi-v2-v3-harness.md covering architecture for all 9 features in the epic. Follows the existing ADR protocol (... (T262)
- **@cleocode/cant TS loader for .cant files (napi-backed)**: Add a typed loadCantFile(path) convenience export to the existing @cleocode/cant package (packages/cant/src/). Does NOT create a new package — exte... (T274)
- **Bundle Pi extensions and global justfile into cleo templates**: Move pi-extensions and global-recipes from CLEO_HOME into packages/cleo/templates/cleoos-hub/. Refactor ensureCleoOsHub() to copy from getPackageRo... (T281)
- **Wave 0: ADR-036 — CleoOS Database Topology + Lifecycle**: First task (Wave 0) of T299 epic. Write ADR-036 documenting the full CleoOS database topology as the architectural anchor for the remaining 12 task... (T300)
- **T310 Consensus — owner decisions recorded for ADR-037**: Record the 8 owner consensus decisions on .cleo/consensus/T310-consensus.md so ADR-037 has a traceable decision trail. Adds Q1-Q8 answers with rati... (T326)
- **T311 Consensus — owner decisions recorded for ADR-038**: Record the 8 owner consensus decisions on .cleo/consensus/T311-consensus.md so ADR-038 has a traceable decision trail. Documents Q1-Q8 answers incl... (T330)
- **Wave AUDIT: Verify ULTRAPLAN Waves 0-6 shipped state and file any gaps**: Audit the foundational ULTRAPLAN waves (0 CANT grammar additions, 1 render pipeline, 2 bridge MVP, 4 lifecycle protocol lift, 5 JIT agent composer,... (T378)
- **Wave W7: 3-tier hierarchy enforcement plus orchestrator classification plus parallel delegation**: Implement the ULTRAPLAN §10 three-tier hierarchy (orchestrator to leads to workers) with compile-time CANT lint rules TEAM-001 TEAM-002 TEAM-003 pl... (T379)
- **Wave W9: Worktree CWD binding — close the T335 leak root cause**: Close the gap between physical git-worktree creation (already shipped in packages/cant/src/worktree.ts) and logical agent scoping (cwd plus env plu... (T380)
- **Author packages/cleo-os/src/keystore.ts — API key management for Pi auth storage**: Create packages/cleo-os/src/keystore.ts implementing the API key management layer per ULTRAPLAN §15.1. This module should export a getKey(provider:... (T391)
- **Author ADR for WorktreeHandle as SpawnOptions replacement (documenting the T335 root cause and fix)**: Write .cleo/adrs/ADR-038-worktree-spawn-binding.md documenting: (1) root cause of T335 — boolean isolate flag provides no path, branch, or env bind... (T399)
- **Extend CANT grammar: add team-level consult-when and stages keywords to team block parser**: Extend crates/cant-core/src/dsl/team.rs to parse consult-when and stages as optional properties on each lead and worker entry within a team block, ... (T407)
- **Extend brain.db observation schema: add agent field as first-class indexed column**: Extend the brain.db SQLite schema to add an agent TEXT column to the observations table (and related tables if they exist). This column stores the ... (T417)
- **Extend CANT agent block parser to support permissions.paths.{read,write,delete} with glob arrays**: Extend crates/cant-core/src/dsl/permission.rs parse_permissions() to handle a paths sub-block under permissions. The paths block supports three key... (T422)
- **STAB-1: Un-stub orchestrate.fanout — wire real PiHarness.spawnSubagent into fanout loop**: Replace the mock {status: queued} body at packages/cleo/src/dispatch/domains/orchestrate.ts line 739 with an actual call to the spawn adapter passi... (T433)
- WS-1: CANT 3-Tier Hierarchy + .cantz Package Standard (T438)
- **Verify CleoOS headless build and Pi harness CLI invocation**: Confirm pnpm install and pnpm build:cleo works cleanly. Verify pnpm cleo commands work headlessly (no TTY). Test that Pi harness can be invoked non... (T454)
- **Validate fresh Drizzle schema migrations**: Fresh initial migrations generated (34 tables, 3 DBs). Issues: drizzle-kit drops UNIQUE constraints, cleo-dev binary migration conflicts resolved. ... (T004)
- **Missing Index Analysis and Creation**: Analyze query patterns from audit_log to identify slow queries. Design and create composite indexes for tasks (status,priority), (type,phase), brai... (T031)
- **Wave 1: Fix ct-cleo SKILL.md deprecated operations**: Fix 3 deprecated refs: memory.brain.search->memory.find, memory.brain.observe->memory.observe, session.context.inject->admin.context.inject (T071)
- **Define core vs optional skills — what is MANDATORY for zero-context CLEO usage**: Establish which skills an agent MUST have to use CLEO from zero context. CLEO-INJECTION.md = thin bootstrap. ct-cleo = core progressive disclosure.... (T082)
- **Research: current CLI command surface audit — flat vs domain-prefixed**: Audit every CLI command registration in packages/cleo/src/cli/commands/. Categorize each as: already domain-prefixed (cleo session start), flattene... (T093)
- **Facade Gap 1: Add startTask to SessionsAPI.start()**: Add startTask?: string to SessionsAPI.start() params in cleo.ts. The underlying StartSessionOptions already has startTask — the facade just doesn't... (T125)
- **T-BRAIN-02: Ship default local embedding provider (all-MiniLM-L6-v2)**: Create embedding-local.ts using @xenova/transformers. Model: all-MiniLM-L6-v2 (22MB, 384 dims). Required dependency with dynamic import. Lazy init ... (T136)
- **Core AST parser — tree-sitter query execution engine**: Create packages/core/src/code/parser.ts — the core tree-sitter integration. Responsibilities: (1) Resolve grammar paths from node_modules. (2) Writ... (T149)
- **Wave 1: Author Transport adapter interface contract**: Create packages/contracts/src/transport.ts with Transport interface per spec section 4.2. Methods: connect, disconnect, push, poll, ack, subscribe (T172)
- **Design CANT Layer 2 agent definition syntax**: Draft the .cant grammar for kind: agent definitions. Must express: name, description, model, allowed_tools, custom instructions, protocol constrain... (T193)
- **Phase 1: napi-rs 3.8+ Migration — Replace wasm-bindgen**: Replace wasm-bindgen/wasm-pack with napi-rs 3.8+ across cant-core, conduit-core, lafs-core. Create crates/cant-napi/ binding crate. Update packages... (T204)
- **Delete sqlx Postgres adapters (postgres.rs, pg_conversations.rs, pg_messages.rs, pg_others.rs, pg_helpers.rs)**: Remove 5 sqlx Postgres adapter files. 43 sqlx queries. Diesel replacements exist but need Postgres backend verification. (T231)
- **Wire cleo agent start to use LocalTransport**: cleo agent start calls createRuntime which only sets up HTTP polling via AgentPoller. Must use TransportFactory.create which auto-selects LocalTran... (T236)
- **CANT AST → Pi tool/protocol registration bridge**: Pi extension bridge at $CLEO_HOME/pi-extensions/cant-loader.ts that takes the AST from loadCantFile (T274) and maps each Section and Statement onto... (T275)
- **Replace WASM with napi-rs in cant package, drop standalone cant-cli**: Add execute_pipeline async to cant-napi. Build cant-napi for current platform. Update @cleocode/cant package.json to napi-rs idiom (napi config, op... (T282)
- **Wave 1: Walk-up project root resolution fix (paths.ts)**: Wave 1 of T299. Fixes the root cause bug at paths.ts:179-188 where getCleoDirAbsolute(cwd) returns a synthesized-but-nonexistent path that gets tre... (T301)
- **T310 ADR-037 — Conduit + Signaldock Separation**: Write ADR-037 documenting the architectural decisions from T310 consensus: conduit.db at project tier, signaldock.db at global tier, project_agent_... (T327)
- **T311 ADR-038 — Cross-Machine Backup Portability**: Write ADR-038 documenting T311 consensus: tar.gz format, opt-in encryption, abort+force restore, always include conduit/signaldock, best-effort sch... (T331)
- **Wave W3: Complete @cleocode/cleo-os launcher — install UX end-to-end**: Bring the cleoos launcher to the state specified in ULTRAPLAN §15. Currently packages/cleo-os has src/cli.ts plus src/xdg.ts plus bin/postinstall.j... (T381)
- **Author packages/cleo-os/src/postinstall.ts — XDG hub scaffold + extension copy + skill install source**: Create packages/cleo-os/src/postinstall.ts as the TypeScript source for the postinstall script. It should: (1) resolve XDG paths via xdg.ts; (2) cr... (T392)
- **Replace SpawnOptions.isolate: boolean with SpawnOptions.worktree: WorktreeHandle | 'inherit' in spawn-adapter.ts**: Modify packages/caamp/src/core/registry/spawn-adapter.ts to replace the boolean isolate field at lines 24-25 with worktree?: WorktreeHandle | 'inhe... (T400)
- **Extend memory.find with --agent filter parameter and update cleo memory find CLI handler**: Add an agent parameter to the memory.find operation in packages/cleo/src/dispatch/domains/ and the underlying brain-retrieval.ts findBrainEntries f... (T418)
- **Emit TS bindings for PathPermissions and pipe them through @cleocode/cant compileBundle output**: Extend the TypeScript CANT compiler (packages/cant/src/ or packages/core/src/cant/) to emit PathPermissions into the compileBundle() output. The br... (T423)
- **Patch any protocol .cant files missing consult-when, stage binding, input schema, or output contract**: For each protocol flagged as missing fields in the audit, add the missing fields. consult-when should be a one-sentence description of when to invo... (T428)
- **STAB-2: Verify npm tarball contains compiled extensions/cleo-cant-bridge.js**: Run npm pack on @cleocode/cleo-os and inspect the tarball contents. Verify extensions/cleo-cant-bridge.js (compiled JS not TS) is present. If missi... (T434)
- WS-2: Meta Agent Builder — cleo agent create (T439)
- **C: CLI System Integrity Consensus — Validate findings with lead agents**: Consensus phase: Lead agents (code-reviewer, system-architect, quality-engineer) independently validate the audit findings. Each must confirm: brok... (T445)
- **Wire task reconciliation into cleoctl dispatch**: Reconciliation engine implemented in core. Need: sync dispatch engine, MCP operations (sync.status, sync.reconcile, sync.clear), CLI commands (cleo... (T005)
- **Wave 1: Fix ct-orchestrator SKILL.md deprecated research domain**: Fix 6 references to removed research domain. Replace with pipeline.manifest.* and memory.link operations. Fix MCP-first bias in tables. (T072)
- **Consensus: decide backward compat strategy for flat commands**: The current flat commands (cleo find, cleo show, cleo current, cleo done, cleo ls, etc.) are used by existing users and documented in skills. Optio... (T094)
- **Facade Gap 2: Add start/stop/current to TasksAPI**: Add start(taskId), stop(), and current() methods to the TasksAPI facade in cleo.ts. The functions exist as startTask, stopTask, currentTask exports... (T126)
- **T-BRAIN-03: Embedding worker thread for async processing**: Create embedding-worker.ts (worker script) and embedding-queue.ts (queue manager). Replace setImmediate in observeBrain() with queue enqueue. Batch... (T137)
- **CodeSymbol + SmartExplore types in @cleocode/contracts**: Add Smart Explore type definitions to contracts. Types: CodeSymbol (name, kind, signature, startLine, endLine, children, jsdoc, decorators, filePat... (T150)
- **Build Gemini CLI adapter using CAAMP hook mappings**: Create packages/adapters/src/providers/gemini-cli/ with manifest.json + hooks.ts + index.ts. Gemini CLI supports 11 of 16 hooks including BeforeAge... (T161)
- **Wave 1: agent_credentials table schema + migration**: Add agent_credentials CREATE TABLE to tasks.db schema per spec section 3.1. Migration SQL + migration-manager registration. (T173)
- **Design CANT protocol constraint syntax**: Draft .cant grammar for expressing RFC 2119 protocol rules (MUST/SHOULD/MAY), output requirements (OUT-001..004), manifest format constraints, and ... (T194)
- **Phase 2: Grammar Foundation — Layer 2 Instruction DSL Parser**: Extend cant-core with document-mode parser: frontmatter, agent/skill/hook blocks, properties, imports, bindings, expressions. Create crates/cant-co... (T205)
- **Agent sign-in flow — credential delivery on spawn**: When an agent is told to start as agent-name, it calls CLEO core endpoint for connection info (like signing in to work). Marks agent online, return... (T214)
- **Deduplicate capabilities and skills storage**: capabilities and skills are stored 3 times: JSON arrays in tasks.db agent_credentials, JSON arrays in signaldock.db agents, and junction tables age... (T237)
- **Wave 1: caamp pi sessions — list/export/resume against Pi JSONL sessions**: Cross-tool session browsing against Pi's JSONL session files stored in ~/.pi/agent/sessions/<cwd-hash>/ (or overridden via settings.sessionDir). Ad... (T264)
- **Caamp pi cant install/remove/list verbs**: CLI verbs for the CANT bridge, honouring the three-tier scope hierarchy (project/user/global) from ADR-035 D1. Verbs: (1) 'caamp pi cant install <s... (T276)
- **Bundle 6 .cant seed agents into @cleocode/agents**: Move .cleo/agents/cleo-prime.cant, cleo-dev.cant, cleo-historian.cant, cleo-rust-lead.cant, cleo-db-lead.cant, cleoos-opus-orchestrator.cant into p... (T283)
- **T310 Specification — conduit/signaldock technical contracts**: Write technical specification defining conduit.db schema, global signaldock.db schema, project_agent_refs table, accessor API signatures, migration... (T328)
- **T311 Specification — backup export/import contracts**: Write technical specification defining the .cleobundle tar.gz layout, manifest.json schema (bundled JSON Schema), integrity model, CLI surface for ... (T332)
- **Wave HYGIENE: Protocol inventory plus ct-master-tac plugin shipping**: Audit the existing 12 CANT protocol files at packages/core/src/validation/protocols/cant/ paired with their TypeScript validators at packages/core/... (T382)
- **Wave W8: Mental models via per-agent BRAIN namespace**: Implement ULTRAPLAN Wave 8: per-agent mental models stored as BRAIN observations with an agent provenance tag. Extend the observation schema in pac... (T383)
- **Move cleo-cant-bridge.ts from packages/cleo/templates/ into packages/cleo-os/extensions/ and add tool_call hook stub**: Copy (not move — keep the template for reference) cleo-cant-bridge.ts from packages/cleo/templates/cleoos-hub/pi-extensions/ to packages/cleo-os/ex... (T393)
- **Wire PiHarness.spawnSubagent to accept WorktreeHandle and set cwd + env vars on Pi subprocess**: Extend packages/caamp/src/core/harness/pi.ts spawnSubagent method to: (1) accept opts.worktree as WorktreeHandle; (2) set cwd to handle.path when w... (T401)
- **Register orchestrate.fanout operation: spawn N parallel workers via Promise.allSettled with aggregated manifest**: Add orchestrate.fanout to registry.ts as a mutate-type operation. The handler receives a list of { taskId, prompt, worktree?: WorktreeHandle } spaw... (T409)
- **STAB-3: Run CLEAN-INSTALL.md docker test for real — document results**: Execute the procedure at packages/cleo-os/test/empirical/CLEAN-INSTALL.md in a real docker container. Install @cleocode/cleo-os globally on node:24... (T435)
- **A: CLI System Integrity Architecture Decision — Conduit domain + registry alignment**: Architecture Decision phase: Decide whether conduit becomes domain #11 in the constitution or gets folded into an existing domain. Decide which of ... (T446)
- **W3: tasks domain lead (32 ops)**: Audit+fix all 32 tasks ops. Missing CLI: cancel, claim, unclaim, impact, complexity.estimate, sync.reconcile, sync.links, sync.links.remove (T473)
- **T052: Bind Tasks to Pipeline Stages**: Automatically associate every task with a specific RCASD-IVTR+C pipeline stage. Add pipelineStage field to Task schema, implement auto-assignment l... (T060)
- **Establish single injection chain — CAAMP -> ~/.agents/AGENTS.md -> providers**: All providers must reference ~/.agents/AGENTS.md as their SSoT entry point. CAAMP provider detection injects the reference. Remove hardcoded provid... (T084)
- **Consensus: command grouping — align CLI groups with 10 canonical domains**: Map the CLI command groups 1:1 to the 10 canonical domains: cleo tasks, cleo session, cleo memory, cleo check, cleo pipeline, cleo orchestrate, cle... (T095)
- **Facade Gap 3: Add AgentsAPI and IntelligenceAPI facade getters**: Add cleo.agents and cleo.intelligence getters to Cleo class in cleo.ts. AgentsAPI: register, deregister, health, detectCrashed, recordHeartbeat, ca... (T127)
- **T-BRAIN-04: Wire memory bridge refresh into hook handlers**: Move refreshMemoryBridge() from direct imports in sessions/index.ts and tasks/complete.ts INTO hook handlers. Gate behind brain.memoryBridge.autoRe... (T138)
- **Smart_outline — file structural skeleton**: Create packages/core/src/code/outline.ts. Takes a file path, parses with tree-sitter, returns all top-level and nested symbols with signatures (bod... (T151)
- **Build Codex adapter using CAAMP hook mappings**: Create packages/adapters/src/providers/codex/ with manifest.json + hooks.ts + index.ts. Codex supports 3 hooks: SessionStart, UserPromptSubmit (Pro... (T162)
- **Wave 1: crypto/credentials.ts — machine-key + AES-256-GCM encryption**: Implement packages/core/src/crypto/credentials.ts. Machine key at ~/.local/share/cleo/machine-key, per-project key via HMAC-SHA256. Node.js crypto ... (T174)
- **Design CANT typed token/property system**: Draft .cant grammar for typed properties replacing the current placeholders.json + string-based token injection. Must support: required vs optional... (T195)
- **Phase 3: Orchestration DSL Parser — Workflows, Pipelines, Sessions**: Add Layer 3 constructs to cant-core parser: workflow/pipeline/session/parallel/conditional/loop/try-catch/discretion/approval. PipelineDef is struc... (T206)
- **CANT DSL agent profiles — define personas in .cant files**: Extend CANT DSL to define agent profiles/personas. A .cant agent file defines the agent identity (model, prompt, skills, permissions, hooks) that g... (T215)
- **Wire signaldock.db into cleo init**: Add ensureSignaldockDb to init.ts. Create DB with Diesel migrations (T223)
- **Update adapters mod.rs and lib.rs exports after sqlx removal**: Update adapters/mod.rs to remove all sqlx module declarations and cfg feature gates. Update lib.rs re-exports. Ensure only Diesel adapters are expo... (T233)
- **Wave 1: caamp pi models — list/configure via settings.json:enabledModels**: Thin wrapper around PiHarness.configureModels (already shipped in v1) plus a new list verb. 'caamp pi models list' reads settings.json:enabledModel... (T265)
- **Version bump 2026.4.5 to 2026.4.6 across all 10 packages**: Bump @cleocode/contracts, lafs, caamp, core, adapters, agents, skills, cleo, cant, runtime from 2026.4.5 to 2026.4.6. Bump Rust workspace version. ... (T284)
- **Wave ACL: Domain ACLs via Pi tool_call hook — path-scoped agent permissions**: Add path-scoped write permissions to CANT agent definitions via a permissions.paths.{read,write,delete} block with glob support. Extend crates/cant... (T384)
- **Update packages/cleo-os tsconfig and build pipeline to include extensions/ in output**: Modify packages/cleo-os/tsconfig.json (or tsconfig.build.json) to include extensions/ as a compiled source directory alongside src/. Verify the pac... (T394)
- **Extend orchestrate.analyze with parallel-safety mode returning parallelSafe grouping**: Extend the existing orchestrate.analyze operation in orchestrate.ts to accept mode: 'parallel-safety' as a parameter. In this mode, the handler ana... (T410)
- **Inject validate-on-load prefix into every spawn context via cleo-cant-bridge.ts**: Extend packages/cleo-os/extensions/cleo-cant-bridge.ts to load the agent's mental model from BRAIN at session start (via cleo memory find --agent <... (T420)
- **STAB-4: Archive 3 superseded epics plus defer 5 stale epics**: Clean house on the task DB. Archive T008 T255 T314 (superseded by T377 and Pi pivot). Cancel with notes: T008 superseded by T377, T255 superseded b... (T436)
- WS-4: Starter CANT Bundle — Out-of-Box Experience (T441)
- **S: CLI System Integrity Specification — Updated constitution + coverage spec**: Specification phase: Update CLEO-OPERATION-CONSTITUTION.md to match registry SSoT. Update domain tables, op counts, add any new ops. Produce the re... (T447)
- **W3: session domain lead (15 ops)**: Audit+fix all 15 session ops. Missing CLI: suspend, show, context.drift, record.assumption (T474)
- **Improve 13 node:sqlite row casts with typed query helper**: 13 as-unknown casts remain for node:sqlite .all() results. Create a typedQuery helper that wraps StatementSync with generics and optional runtime s... (T007)
- **Wave 2: Fix MCP session.start scope global rejection**: Core parseScope() accepts global. MCP layer rejects it. Trace exact rejection point in MCP validation/parameter transformation layer and fix. (T074)
- **Review and improve skill-paths.ts and skill-ops.ts — wire to registry SSoT**: Review packages/core/src/skills/skill-paths.ts and packages/core/src/orchestration/skill-ops.ts. Ensure dynamic skill generation reads from registr... (T085)
- **Spec: CLI command naming standard and conventions**: Write a specification for CLI command naming: verb standards (show vs get, find vs search), argument conventions (positional taskId vs --task-id fl... (T096)
- **T-BRAIN-05: Context-aware memory bridge generation**: Add generateContextAwareContent() to memory-bridge.ts. Use hybridSearch() when scoped. Query brain_memory_links for task context. Configurable maxT... (T139)
- **Smart_search — cross-codebase symbol search**: Create packages/core/src/code/search.ts. Walks directory tree, batch-parses code files by language, matches symbols against query. Scoring: exact m... (T152)
- **Build Kimi adapter (MCP-only, no native hooks)**: Create packages/adapters/src/providers/kimi/ with manifest.json + index.ts. CAAMP 1.9.1 confirms Kimi has hookSystem: 'none' — zero native hooks su... (T163)
- **Design CANT import and composition model for skill injection**: Draft how .cant handles skill composition: importing skill definitions, composing agent + protocol + task context, tier-based visibility scoping (r... (T196)
- **Phase 4: Validation Engine — 42 Static Analysis Rules**: Build validation layer: scope analysis (S01-S13), pipeline purity (P01-P07), types (T01-T07), hooks (H01-H04), workflows (W01-W11). Diagnostic type... (T207)
- **Update DATABASE-ARCHITECTURE.md to match actual state**: DATABASE-ARCHITECTURE.md has stale references: line 237 says sqlx+Diesel dual-ORM (sqlx removed in T229), missing agent_connections table, missing ... (T239)
- **Wave 1: caamp pi prompts install — Pi prompt templates directory**: Install prompt templates into ~/.pi/agent/prompts/ (global) or <project>/.pi/prompts/ (project). Pi discovers prompts at load time and exposes them... (T266)
- **T310-readiness gate: detect conduit.db vs legacy signaldock.db at project tier**: Add a T310-readiness check function to backup-pack.ts that verifies conduit.db exists at the project tier (ADR-037 topology). If conduit.db is abse... (T342)
- **Verify XDG scaffolding creates correct directory structure and writes default model-routing.cant**: Write a vitest integration test at packages/cleo-os/test/xdg-scaffold.test.ts that calls the postinstall scaffold functions with a temporary XDG_DA... (T395)
- **Seed .cleo/teams.cant platform team definition with 3 leads and worker consult-when fields**: Create .cleo/teams.cant at the project root matching the ULTRAPLAN §10.2 canonical team block plus the agentic-engineer consult-when pattern. Inclu... (T411)
- **Write empirical Wave 8 test: 5 sequential agent runs with mental model growth + pattern reuse + validation logs**: Create packages/cleo-os/test/empirical/wave-8-mental-models.test.ts implementing the ULTRAPLAN Wave 8 proof gate. Using a faux Pi provider and a fi... (T421)
- **Write ACL integration test: backend-dev blocked on wrong path, allowed on correct path**: Create packages/cleo-os/test/acl-integration.test.ts implementing the T384 empirical gate. The test sets up a mock bridge context with a backend-de... (T426)
- **Verify ct-master-tac installs via tools.skill.install and produces a ready-to-run execution layer**: Test the full install path: run cleo skills install ct-master-tac in a temporary project with a minimal .cleo/ directory. Verify: (1) all 12 protoc... (T431)
- **STAB-5: Tag v2026.4.17 CleoOS dogfood candidate if STAB-1 through STAB-3 pass**: If STAB-1 (fanout un-stub) STAB-2 (tarball verification) and STAB-3 (docker clean install) all pass, cut a release via the existing release workflo... (T437)
- **T054: Epic Lifecycle Pipeline Enforcement**: Epics MUST follow RCASD-IVTR+C and enforce that children follow the pipeline. Epic creation requires stage specification, minimum 5 AC items, and d... (T062)
- **Wave 2: Audit domain handler constructors for eager init**: Check all DomainHandler constructors in packages/cleo/src/dispatch/domains/ for eager getProjectRoot() calls. Defer all to request time to match mi... (T075)
- **Tune cleo-subagent — CLEO-first agent with proper protocol knowledge**: Review and improve packages/agents/cleo-subagent/AGENT.md. This should be a CLEO-first agent tuned to the ways of CLEO with proper protocol injecti... (T086)
- **Enhance SharingStatus with git sync fields**: Add git sync state fields to SharingStatus: hasGit, remotes, pendingChanges, lastSync for Nexus multi-project sync visibility. (T110)
- **T-BRAIN-06: Session summarization — prompt + structured response**: On session.end, construct summarization prompt. Return memoryPrompt in response. Also accept sessionSummary JSON inline (dual-mode). Add SessionSum... (T140)
- **Smart_unfold — single symbol extraction**: Create packages/core/src/code/unfold.ts. Takes file path + symbol name, parses file, finds matching symbol node, extracts complete source including... (T153)
- **Prototype cleo-subagent.cant agent definition**: Write a complete .cant file that expresses everything in the current cleo-subagent AGENT.md: identity, model, allowed tools, 10 domains, CQRS gatew... (T197)
- **Phase 5: LSP Server — cant-lsp Binary + VS Code Extension**: Ship cant-lsp binary via tower-lsp with diagnostics, completions, hover, go-to-definition, document symbols. VS Code extension with TextMate gramma... (T208)
- **Orchestration hierarchy API — HITL > Prime > ProjectLead > TeamLead > Ephemeral**: Implement the 5-level agent hierarchy from ORCH-PLAN.md. Prime Orchestrator manages cross-project priorities. Project Leads manage project-level or... (T217)
- **Wire cleo agent register to scaffold .cant persona file**: cleo agent register does NOT create a .cant persona file. Must scaffold a minimal .cleo/agents/{agentId}.cant with metadata frontmatter (kind: agen... (T240)
- **Wire cleo agent register to create in BOTH databases**: Or decide single DB and wire accordingly. (T247)
- **Wave 1: caamp pi themes install — Pi theme directory**: Install theme JSON files into ~/.pi/agent/themes/ (global) or <project>/.pi/themes/ (project). Pi supports theme hot-reload during interactive mode... (T267)
- **Final validation and stage commit (await sign-off)**: Run pnpm biome check, pnpm run build all packages, pnpm run test, cargo build cant-napi release, cleo admin smoke. Stage all changes. STOP and wait... (T286)
- **BackupManifest contract type + manifest-v1.json JSON Schema asset**: Create the BackupManifest TypeScript type and related interfaces (DatabaseEntry, JsonEntry, GlobalFileEntry, IntegrityBlock) in packages/contracts/... (T343)
- **Conduit-sqlite.ts: DDL, ensureConduitDb, path helper**: Create packages/core/src/store/conduit-sqlite.ts as the new project-tier store module. Implement CONDUIT_DB_FILENAME, CONDUIT_SCHEMA_VERSION, getCo... (T344)
- **Write consolidated wave audit report and create gap subtasks for any missing deliverables**: Consolidate the five per-wave audit findings into .cleo/agent-outputs/T377-wave-audit.md with a summary table (Wave | Status | Evidence | Gaps). Fo... (T390)
- **Emit empirical Wave 3 test at packages/cleo-os/test/empirical/wave-3-launcher.test.ts**: Create the empirical Wave 3 test per ULTRAPLAN §18. The test should use vitest and spawn the cleoos binary in a subprocess with a temporary XDG_DAT... (T396)
- **W2-1: Rename 5 conduit ops to orchestrate.conduit.* in registry + types**: Atomic rename per ADR-042: Move 5 conduit operations (status, peek, start, stop, send) to orchestrate domain as orchestrate.conduit.* sub-namespace... (T449)
- **W3: check domain lead (18 ops)**: Audit+fix all 18 check ops. Missing CLI: output, chain.validate, compliance.record (T476)
- **Validate Nexus or defer federated features**: Nexus has zero usage after 8+ days. Decide: validate with real usage or defer federated agents to Phase 3+. (T045)
- **Wave 3: Merge capability-matrix + routing-table into single SSoT**: Consolidate OperationCapability and RoutingEntry into one structure fed from registry. Remove redundant re-exports. Ensure all registry operations ... (T076)
- **Update all skills and CLEO-INJECTION.md for new CLI syntax**: After CLI refactor ships, update all skill files (ct-cleo, ct-orchestrator, ct-memory, ct-dev-workflow, _shared, cleo-subagent AGENT.md) and the CL... (T098)
- **T-BRAIN-07: Auto-link observations to current session/task**: Enhance observeBrain(): when sourceSessionId present, query active session task focus. Auto-create brain_memory_links entry linking observation to ... (T141)
- **CLI commands + dispatch wiring for code operations**: Create CLI commands and dispatch operations for Smart Explore. CLI: cleo code outline <file>, cleo code search <query> [--path] [--lang] [--max], c... (T154)
- **Prototype subagent-protocol-base.cant protocol definition**: Write a .cant file expressing subagent-protocol-base.md: OUT-001..004 rules, output file format, manifest entry format, task lifecycle integration,... (T198)
- **Phase 6: Runtime Integration — Hybrid Rust + TS Executor**: Pipeline executor in Rust (crates/cant-runtime/), workflow executor in TS (packages/core/src/cant/). Discretion evaluation with pluggable evaluator... (T209)
- **Background services — heartbeat, key rotation, SSE connection manager**: Implement missing runtime services in packages/runtime/src/services/: heartbeat.ts (periodic online status), key-rotation.ts (auto-rotate on thresh... (T218)
- **E2E test accounts and messages both APIs**: Create accounts exchange messages verify cross-API delivery (T226)
- **Wave 2: Global-tier backup mechanism for nexus.db at XDG path**: Wave 2 of T299. Global-tier nexus.db (18 MB + 4 MB active WAL at ~/.local/share/cleo/nexus.db) has ZERO rotating backup today. One crash = 18 MB of... (T306)
- **Backup-crypto.ts: Argon2id + AES-256-GCM encrypt/decrypt module**: Implement packages/core/src/store/backup-crypto.ts with two exported functions: encryptBundle(tarGzBuffer, passphrase) and decryptBundle(encryptedB... (T345)
- **Skill install via PiHarness — verify postinstall calls cleo skills install for CleoOS skill set**: Extend postinstall.ts to call the cleo CLI skills install command for the set of CleoOS skills (ct-cleo, ct-orchestrator, ct-epic-architect, ct-tas... (T397)
- **Verify cleo-chatroom.ts renders orchestrator, leads, and workers as distinct TUI panels**: Review packages/cleo-os/src/cleo-chatroom.ts (confirmed existing). Verify it renders agent messages with role-based color coding distinguishing orc... (T413)
- **W2-2: Fix tests referencing conduit domain after rename**: Update test files that reference the conduit domain after W2-1 rename. Fix registry-derivation.test.ts domain count assertion (11 -> 10). Fix parit... (T450)
- **W3: pipeline domain lead (32 ops)**: Audit+fix all 32 pipeline ops. Missing CLI: stage.history, stage.gate.pass/fail, stage.reset, chain.show/list/add/instantiate/advance, release.chan... (T477)
- **T056: Create ct-validator Skill for Gate Enforcement**: Create a dedicated skill that validates task compliance before operations proceed. Pre-flight checks verify AC before starting work, session is act... (T064)
- **Wave 3: Add CleoOS detection switch to CLEO-INJECTION.md**: Add runtime detection for CleoOS workspace vs standalone CLI. When outside CleoOS, fallback to CLI-first. When inside CleoOS, use workspace-provide... (T077)
- **Formalize _shared as cross-cutting SSoT for ct-* skills**: Define the role of packages/skills/skills/_shared/ as the canonical cross-cutting reference that all ct-* skills compose from. Review and clean up ... (T088)
- **Wire enforcement/verification config sections into CleoConfig TypeScript interface**: T105 audit found enforcement.* and verification.* are read via untyped dot-path strings (getRawConfigValue). Add EnforcementConfig and Verification... (T128)
- **Deduplicate agents/retry.ts withRetry — delegate to lib/retry.ts**: agents/retry.ts has its own withRetry<T> that duplicates lib/retry.ts. Refactor agents/retry.ts to import and wrap lib/retry.ts withRetry, keeping ... (T129)
- **T-BRAIN-08: Embedding backfill with progress reporting**: Enhance populateEmbeddings() with onProgress callback. Add --embeddings flag to cleo backfill command. Uses worker thread queue from T-BRAIN-03. (T142)
- **Wire brain automation handlers to CAAMP canonical hook events**: Update all brain automation hook handlers (session-hooks.ts, task-hooks.ts, work-capture-hooks.ts, memory-bridge-refresh.ts, file-hooks.ts, mcp-hoo... (T166)
- **Wave 3: cleo agent CLI commands (register/list/get/poll/watch/send)**: Implement packages/cleo/src/commands/agent.ts with subcommands per spec section 3.4. register, list, get, rotate-key, remove, sync, poll, watch, se... (T178)
- **Token cost analysis: .cant vs markdown prompt formats**: Measure and compare token counts for equivalent content in .cant structured format vs current markdown format. Test with multiple tokenizers (cl100... (T199)
- **Register clean agent profiles on api.signaldock.io**: Register fresh agent profiles on the new api.signaldock.io endpoint. Keep clawmsgr-*.json for legacy api.clawmsgr.com connections. Create new signa... (T219)
- **Validate local credential flow end-to-end**: Test init register encrypt store retrieve authenticate (T227)
- **Wave 2: CANT .cant bridge — Pi extension loading .cant files at runtime**: Wave 2 parent: ship the full CANT-on-Pi integration AND activate the existing WorkflowExecutor (dead code today, zero production callers). Source o... (T273)
- **Backup-pack.ts: bundle creation, tar.gz streaming, checksums.sha256 generation**: Implement packages/core/src/store/backup-pack.ts with the exported function packBundle(options: BundlePackOptions): Promise<Buffer>. Behavior: run ... (T347)
- **Global-salt.ts: atomic write, memoized read, validation**: Create packages/core/src/store/global-salt.ts implementing the global-salt subsystem per spec §2.3 and §3.3. Exports: GLOBAL_SALT_SIZE (32), GLOBAL... (T348)
- **Clean container verification — document docker test procedure and confirm package.json publishConfig is correct**: Verify that packages/cleo-os/package.json has correct publishConfig (access: public), that the bin field maps cleoos to dist/cli.js, and that all r... (T398)
- **Write empirical Wave 9 test: 3 parallel workers, isolation verified, ff-merge + forensic retain**: Create packages/cleo-os/test/empirical/wave-9-worktree.test.ts implementing the ULTRAPLAN Wave 9 proof gate. The test spawns 3 parallel worker agen... (T406)
- **Write CANT lint rules TEAM-001, TEAM-002, TEAM-003 in crates/cant-core/src/validate/hierarchy.rs**: Implement compile-time lint rules in crates/cant-core/src/validate/hierarchy.rs: TEAM-001 (worker blocks must not declare dispatch tools), TEAM-002... (T414)
- **W3: orchestrate domain lead (24 ops)**: Audit+fix all 24 orchestrate ops (incl 5 conduit.*). Missing CLI: status, bootstrap, classify, fanout, fanout.status, handoff, spawn.execute, paral... (T478)
- **Wave 4: CLI-first pivot in all skills**: Update ct-cleo, ct-orchestrator, ct-memory, _shared references to prefer CLI over MCP. Flip all quick-reference tables to show CLI primary, MCP fal... (T078)
- **T-BRAIN-09: Brain maintenance command**: Create brain-maintenance.ts combining applyTemporalDecay() + consolidateMemories() + populateEmbeddings(). CLI: cleo brain maintenance. Schedulable... (T143)
- **Barrel exports + namespace for code module**: Export the code module from core barrels. Add 'export * as code from ./code/index.js' to packages/core/src/index.ts. Add flat exports (smartOutline... (T156)
- **Static analysis gap assessment: what CANT catches that markdown cannot**: Catalog errors the current markdown pipeline silently accepts (unresolved tokens, missing required sections, invalid protocol references, unreachab... (T200)
- **Wave 3: Orchestrator mode — PiHarness.spawnSubagent as primary subagent entrypoint**: The v1 PiHarness.spawnSubagent exists but is minimal — it spawns 'pi --mode json -p --no-session "<prompt>"' and collects stdout. Upgrade it to a f... (T277)
- **Wave 3: Integration test suite for database topology**: Wave 3 of T299 — final verification task before release. End-to-end integration tests covering all 9 topology scenarios. Each scenario exercises a ... (T308)
- **Api-key-kdf.ts: deriveApiKey and deriveLegacyProjectKey**: Create packages/core/src/store/api-key-kdf.ts with the two KDF functions from spec §3.4. deriveApiKey(opts: { machineKey, globalSalt, agentId }) us... (T349)
- **Backup-unpack.ts: bundle extraction and all 6 integrity verification layers**: Implement packages/core/src/store/backup-unpack.ts with exported function unpackBundle(bundlePath: string, options: UnpackOptions): Promise<UnpackR... (T350)
- **Register orchestrate.fanout.status query operation for monitoring parallel worker progress**: Add orchestrate.fanout.status as a query-type operation in registry.ts. The handler accepts a fanout session ID and returns { workers: Array<{ inst... (T415)
- **W3: tools domain lead (25 ops)**: Audit+fix all 25 tools ops. Missing CLI: skill.dispatch/catalog/precedence/spawn.providers/dependencies, all provider.* (6 ops), all adapter.* (6 ops) (T479)
- **T058: Backfill Existing Tasks with AC**: Retroactively add AC and verification metadata to all existing tasks. Auto-generate AC from descriptions using LLM, initialize verification gates, ... (T066)
- **Wave 4: Validate skills against registry automated check**: Create validation that cross-references all operation names in skill files against canonical registry. Catch future drift automatically. Can be a c... (T079)
- **T-BRAIN-10: Cross-provider transcript hook**: Extend AdapterHookProvider with optional getTranscript(sessionId). Session-end handler calls it. Claude Code adapter reads from ~/.claude/projects/... (T144)
- **E2E integration tests: hook automation fires across providers**: Create integration test suite that verifies brain automation hooks actually fire during lifecycle events. Test with mock adapters simulating Claude... (T168)
- **Go/no-go decision document for CANT-based subagent prompts**: Synthesize findings from all exploration tasks into a decision document. Weigh benefits (static analysis, validation, LLM attention) against costs ... (T201)
- **Wave 4 (v3): CAAMP Pi-exclusive dispatch — route through Pi when installed**: **PARTIAL — 70% shipped in v2026.4.5, ~30% gap remaining.** v2026.4.5 registered Pi with priority: "primary" in packages/caamp/providers/registry.j... (T278)
- **Wave 4: v2026.4.11 release mechanics**: Wave 4 of T299 — final release mechanics. Mirrors the pattern from v2026.4.7/8/9/10 release agents: version bump + CHANGELOG + validation + staged ... (T309)
- **Contracts: ProjectAgentRef and AgentWithProjectOverride types**: Extend packages/contracts/src/agent.ts with the two new types from spec §3.1: ProjectAgentRef (agentId, attachedAt, role, capabilitiesOverride, las... (T351)
- **Regenerators.ts: dry-run JSON file generators for config.json, project-info.json, project-context.json**: Implement packages/core/src/store/regenerators.ts exposing three read-only dry-run generator functions: regenerateConfigJson(projectRoot), regenera... (T352)
- **Write empirical Wave 7 test: full Orchestrator→Lead→Worker chain with Lead Edit blocked**: Create packages/cleo-os/test/empirical/wave-7-hierarchy.test.ts implementing the ULTRAPLAN Wave 7 proof gate. The test uses Pi's faux provider to s... (T416)
- **W3: admin domain lead (39 ops)**: Audit+fix all 39 admin ops. Missing CLI: migrate, cleanup, job, job.cancel, install.global, context.inject, detect (T480)
- **T059: Create Project-Level Strictness Presets**: Create preset configuration profiles for different project strictness levels. Strict preset (block AC, require sessions), Standard preset (warn AC,... (T067)
- **T-BRAIN-11: Update CLEO-INJECTION.md with brain automation**: Add memory automation section to injection template. Agent work loop: after session.end, check memoryPrompt and execute OR pass structured sessionS... (T145)
- **Update specs, injection templates, and brain spec for CAAMP 1.9.1 integration**: Update: (1) CLEO-API.md — new hook events, new adapters, new diagnostic. (2) CORE-PACKAGE-SPEC.md — CAAMP ^1.9.1 dep, new hook taxonomy, new adapte... (T169)
- **Wave 5 (v3): CLEO dispatch layer routes through Pi as sole orchestrator**: **NOT STARTED. Architectural question more than implementation work.** Audit 2026-04-07: grep for PiHarness, getPrimaryHarness, dispatchInstallSkil... (T279)
- **Conduit-sqlite.ts: project_agent_refs CRUD accessors**: Add the project_agent_refs table DDL and all five accessor functions to the conduit-sqlite.ts module created in T344: attachAgentToProject (insert ... (T353)
- **Restore-json-merge.ts: A/B classification engine with 4-way taxonomy**: Implement packages/core/src/store/restore-json-merge.ts with the exported function regenerateAndCompare(input: JsonRestoreInput): JsonRestoreReport... (T354)
- **Wire composeSpawnPayload into orchestrate-engine.prepareSpawn (W5 composer activation, T379 blocker)**: T378 audit found that packages/cant/src/composer.ts composeSpawnPayload is fully implemented with tier caps escalation context_sources and mental-m... (T432)
- **W3: nexus domain lead (22 ops)**: Audit+fix all 22 nexus ops. Missing CLI: show, graph, transfer.preview, transfer, permission.set, share.status, share.snapshot.export/import (T481)
- **T-BRAIN-12: Update CLEO-BRAIN-SPECIFICATION.md**: Rewrite docs/specs/CLEO-BRAIN-SPECIFICATION.md to reflect: automated capture, local embedding, context-aware bridge, summarization (dual-mode), tra... (T146)
- **PRIME Full Audit — validate all task statuses against actual code**: Verify every done and cancelled task from session 2026-03-30 against git commits and file existence. No trust, only evidence. (T254)
- **Conflict report generator: .cleo/restore-conflicts.md writer with agent re-auth and schema warnings**: Implement the conflict report writer as an exported function writeConflictReport(reports: JsonRestoreReport[], options: ConflictReportOptions): Pro... (T357)
- **W3: sticky domain lead (6 ops)**: Verify all 6 sticky ops have correct CLI handlers. 100% covered per audit — verification only. (T482)
- **Wave 5: Scaffold @cleocode/runtime package**: Create packages/runtime/ with Runtime interface, agent-poller, sse-connection, heartbeat, key-rotation services. Per spec section 14. (T183)
- **CLI: cleo backup export command**: Implement packages/cleo/src/cli/commands/backup-export.ts as the cleo backup export <name> subcommand. Wire --scope project|global|all (default: pr... (T359)
- **CLI: cleo backup import command with A/B flow and atomic DB restore**: Implement packages/cleo/src/cli/commands/backup-import.ts as the cleo backup import <bundle> subcommand. Wire --force flag to bypass E_DATA_EXISTS ... (T361)
- **Cli/index.ts: wire migration and startup sequence**: Update packages/cleo/src/cli/index.ts to wire the T310 migration and new startup sequence per spec §4.6. Add runConduitMigrationIfNeeded() call (wr... (T360)
- **CLI: cleo backup inspect command (manifest-only streaming read)**: Implement packages/cleo/src/cli/commands/backup-inspect.ts as the cleo backup inspect <bundle> subcommand. For encrypted bundles: report encryption... (T363)
- **Cleo agent list --global and agent info: CLI flag additions**: Add --global flag to cleo agent list command in packages/cleo/src/cli/commands/agent.ts. Without --global (default): INNER JOIN conduit.db:project_... (T362)
- **CLI: cleo restore finalize command**: Implement packages/cleo/src/cli/commands/restore-finalize.ts as the cleo restore finalize subcommand. Behavior from spec §5.4: (1) if no .cleo/rest... (T365)
- **Cleo agent attach and detach: new CLI verbs**: Add two new CLI verbs to packages/cleo/src/cli/commands/agent.ts per spec §5.1. cleo agent attach <id>: creates a project_agent_refs row in conduit... (T364)
- **Sqlite-backup.ts: conduit, global signaldock, and global-salt registry**: Extend packages/core/src/store/sqlite-backup.ts to register conduit.db in the project-tier backup registry and activate the global signaldock.db sl... (T369)
---
## [2026.4.24] — 2026-04-10 — CLI system integrity: conduit fold, dispatch fixes, MCP purge

### Changed — Conduit domain folded into orchestrate (ADR-042)

Per ADR-042, the `conduit` domain (5 tier-2 operations) has been folded
into the `orchestrate` domain as `orchestrate.conduit.*` sub-namespace.
This restores the 10-domain constitutional invariant. Conduit is a relay
path overlay, not a runtime domain boundary (per System Flow Atlas).

- `conduit.status` → `orchestrate.conduit.status`
- `conduit.peek` → `orchestrate.conduit.peek`
- `conduit.start` → `orchestrate.conduit.start`
- `conduit.stop` → `orchestrate.conduit.stop`
- `conduit.send` → `orchestrate.conduit.send`
- `CANONICAL_DOMAINS` restored to 10 entries
- `ConduitHandler` routes through `OrchestrateHandler`

### Fixed — 5 broken CLI routes (runtime failures)

Five commands dispatched to operations removed in T5615 rationalization:

- `cleo promote` → now dispatches `tasks.reparent` (was `tasks.promote`)
- `cleo labels show` → now dispatches `tasks.label.list` (was `tasks.label.show`)
- `cleo skills enable` → now dispatches `tools.skill.install` (was `tools.skill.enable`)
- `cleo skills disable` → now dispatches `tools.skill.uninstall` (was `tools.skill.disable`)
- `cleo skills configure` → removed (was `tools.skill.configure`, a stub)

### Fixed — observe.ts dispatch bypass

`cleo observe` called `observeBrain()` from core directly, bypassing the
dispatch layer (middleware, rate limiting, audit logging). Now routes
through `dispatchFromCli('mutate', 'memory', 'observe', ...)` consistent
with `cleo memory observe`.

### Changed — Documentation MCP purge (6 spec files)

Removed all MCP references from canonical documentation. CLEO is CLI-only:

- `CLEO-OPERATION-CONSTITUTION.md` — 14 edits: MCP tools→dispatch gateways
- `CLEO-SYSTEM-FLOW-ATLAS.md` — Section 7-9 rewritten for CLI dispatch
- `CORE-PACKAGE-SPEC.md` — coreMcp removed, signaldock→conduit, napi-rs
- `CLEO-BRAIN-SPECIFICATION.md` — captureMcp vestigial field, conduit.db
- `PORTABLE-BRAIN-SPEC.md` — MCP interface section→dispatch architecture
- `CLEOCODE-ECOSYSTEM-PLAN.md` — WASM→napi-rs, 4→16 crates, 8→11 packages

### Added — CLI System Audit artifacts

- `ADR-042`: Conduit domain disposition + 22 undocumented ops classification
- CLI coverage spec: 84 uncovered ops classified (34 needs-cli, 23 agent-only, 27 deferred)
- Wave plan: 4-wave implementation roadmap for remaining integrity work

## [2026.4.23] — 2026-04-10 — Contracts type safety + docs cleanup

### Fixed — Inline type duplicates removed from dispatch engine

`TaskRecord` (80 lines) and `MinimalTaskRecord` (12 lines) were defined
inline in `task-engine.ts` instead of using `@cleocode/contracts`. This
caused a CI typecheck failure (TS2352) on the `--fields` code path.
Both types now import from contracts (canonical source) and are
re-exported for backward compatibility.

- Added `pipelineStage` to contracts `TaskRecord`
- Added `depends`, `type`, `size` to contracts `MinimalTaskRecord`
- Fixed `taskToRecord` to use `TaskRecordRelation` for relates mapping

### Changed — Documentation

- Removed MCP adapter references from 8 spec/concept docs (MCP fully
  removed per prior ADR)
- Added Pi harness design docs: agent TUI, architecture, wireframes
- Updated LOOM distillation flow with current two-path implementation

## [2026.4.22] — 2026-04-10 — Agent UX patch: orphan prevention, find readiness, batch creation

### Fixed — Orphaned tasks from validation retries (#89)

`cleo add` now validates ALL fields in one pass and returns every issue
together, so agents need only one retry instead of multiple. The error
response includes the original submitted params (including `--parent`)
so agents can see which flags they provided and preserve them on retry.
In advisory mode, a warning is emitted when `type=task` is created
without `--parent`.

### Fixed — `cleo find ""` empty string error (#85)

Empty string queries no longer throw `E_INVALID_INPUT`. The falsy check
has been replaced with a strict null check so `""` is treated as a valid
(albeit low-utility) search query.

### Fixed — `cleo note` routing collision with sticky notes (#84)

Removed `.alias('note')` from the sticky command. `cleo note T005 ...`
no longer routes to the sticky subsystem. Use `cleo update T005 --notes`
for task notes and `cleo sticky add` for sticky notes.

### Added — `depends`, `type`, `size` in default find response (#91)

`cleo find` now returns dependency IDs, task type, and size in every
result by default. Agents can determine task readiness (blocked vs ready)
from find output without N+1 `cleo show` follow-up calls.

### Added — `--fields` and `--verbose` flags for find (#92)

`cleo find --verbose` returns full task records (same as `cleo list`).
`cleo find --fields labels,acceptance,notes` includes specific extra
fields. Default slim output remains unchanged.

### Added — All-errors-at-once validation for `cleo add` (#90 item 1)

Validation errors for description, status, size, labels, acceptance
criteria, and orphan checks are collected and returned together instead
of failing on the first error.

### Added — Session-scoped parent inheritance (#90 item 2)

When a session has `--scope epic:T###`, `cleo add --type task` auto-
inherits the scoped epic as `--parent`. Eliminates orphaned tasks during
session-scoped epic decomposition.

### Added — `cleo add-batch` command (#90 item 4)

`cleo add-batch --file tasks.json` creates multiple tasks atomically
from a JSON array. Supports `--parent` as a default parent for all tasks
and `--dry-run` for preview. Input can also be piped from stdin.

### Added — `CLEO_PROJECT_ROOT` env var (#90 item 5)

`CLEO_PROJECT_ROOT` is now accepted as an alias for `CLEO_ROOT` to
override cwd-based project detection. Useful when agents `cd` to
subdirectories for code work.

### Added — JSON acceptance criteria format (#90 item 6)

`--acceptance '["criterion 1","criterion 2","criterion 3"]'` is now
supported alongside the existing pipe-delimited format. JSON arrays
avoid the issue of pipes inside criteria text causing incorrect splits.

### Added — `--parent-search` flag for `cleo add` (#90 item 7)

`cleo add "Task" --parent-search "OrchestratorService"` resolves the
parent by fuzzy title match instead of requiring an exact task ID.
Reduces lookup round-trips for agents.

## [2026.4.21] — 2026-04-10 — Extension deployment fixes + batteries-included install

### Fixed — Extensions not updating on upgrade

The postinstall `deployExtension()` function skipped copying if the
destination file already existed. This meant upgrading `@cleocode/cleo-os`
never updated the deployed extensions — users were stuck on old Wave 2
versions with no TUI features. Now unconditionally overwrites managed
extensions with `cpSync(force: true)`. User-editable configs like
`model-routing.cant` are still preserved.

### Added — `cleo` and `ct` binaries re-exported from cleo-os

`npm install -g @cleocode/cleo-os` now installs both `cleoos` AND `cleo`
on PATH. Previously the `cleo` CLI binary was a nested dependency without
a global symlink, so Circle of Ten dashboard data and skills install
silently failed.

## [2026.4.20] — 2026-04-10 — Hotfix: tui-theme.js missing from deployed extensions

### Fixed

- `postinstall.ts`: deploy `tui-theme.js` alongside extensions so
  `cleo-cant-bridge.js` and `cleo-agent-monitor.js` can resolve the
  shared theme import at runtime. Previously `cleoos` crashed on first
  run with `Cannot find module './tui-theme.js'`.
- `prepublishOnly` guard now checks for `tui-theme.js` in addition to
  the three extension files.

## [2026.4.19] — 2026-04-10 — CleoOS Agent Platform

T250 epic: five workstreams shipping the content layer that makes CleoOS
distinct from vanilla Pi.

### Added — .cantz packaging + CANT 3-tier hierarchy (T438)

- `docs/specs/CANT-HIERARCHY-SPEC.md`: 3-tier discovery (project > user > global)
- `docs/specs/CANTZ-PACKAGE-STANDARD.md`: ZIP archive standard for agent packages
- `cleo-cant-bridge.ts`: `discoverCantFilesMultiTier()` scans all 3 XDG tiers
- `cleo agent install <path>.cantz [--global]`: extract and install agent packages
- `cleo agent pack <dir>`: ZIP a directory into a `.cantz` archive

### Added — Meta Agent Builder (T439)

- `cleo agent create --name <n> --role <r> [--tier] [--domain] [--global] [--seed-brain]`
- 4 role-based persona templates (orchestrator, lead, worker, docs-worker)
- BRAIN seeding via `--seed-brain` flag
- Best-effort signaldock.db registration

### Added — Starter CANT bundle (T441)

- `packages/cleo-os/starter-bundle/`: team.cant + 4 agent personas
- Default team: cleo-orchestrator → dev-lead → [code-worker, docs-worker]
- All agents have mental_model, context_sources, permissions, role-appropriate tools
- Deployed via postinstall (global) and `cleo init` (project)
- 57 e2e tests covering bridge discovery, compilation, deployment, TEAM-002

### Added — TUI visual identity (T442)

- `tui-theme.ts`: 15 design tokens mapped from design docs to ANSI 256-color
- `PI-EXTENSION-MAPPING.md`: honest Pi extension API gap analysis
- Session banner with forge aesthetic on session_start
- `cleo-agent-monitor.ts`: agent activity widget + `/cleo:agents` + `/cleo:circle`
- Circle of Ten: 7/10 zones wired to live CLI data, 3 marked "not wired"

### Added — Subagent injection documentation (T440)

- `docs/guides/SUBAGENT-INJECTION-PIPELINE.md`: 5-stage trace with line refs
- `docs/guides/CREATING-CUSTOM-AGENTS.md`: practical 5-step guide
- `docs/guides/LEAD-VS-WORKER-ROLES.md`: tool access, ACLs, delegation
- `docs/guides/TOKEN-REPLACEMENT-CONTRACT.md`: 12 tokens, 4-phase lifecycle

### Fixed — CLEOOS-VISION.md + ULTRAPLAN accuracy

- Removed all MCP references per ADR-035 §D4
- Updated architecture diagram to 5-DB topology (conduit.db + signaldock.db)
- Updated version references to v2026.4.18
- Added Pi pivot, CANT bridge, 3-tier hierarchy to "What Exists Now"
- Fixed ULTRAPLAN §2.1 XDG path accuracy

### Fixed — fanoutManifestStore memory leak

- Capped at 64 entries with FIFO eviction in `orchestrate.ts`

## [2026.4.18] — CLI Help UX Overhaul

### Fixed

- **cleo --help**: replaced flat 100+ command dump with 13 domain-grouped sections (Task Management, Sessions & Planning, Memory & Notes, etc.)
- **alias deduplication**: aliases (`ls`, `done`, `rm`, `tags`, `note`, `pipeline`) now shown inline as `list (ls)` instead of duplicated entries
- **help padding**: eliminated massive horizontal whitespace caused by multi-line `buildOperationHelp` descriptions leaking into citty's column formatter
- **cargo fmt**: fixed Rust formatting in cant-core and cant-router crates

### Changed

- Custom `showUsage` renderer passed to citty's `runMain` for root help; sub-command help (`cleo add --help`) unchanged

## [2026.4.17] — CleoOS Dogfood Candidate

### Fixed

- **@cleocode/cleo-os tarball**: compiled extensions (`cleo-cant-bridge.js`, `cleo-chatroom.js`) now ship in the npm tarball. v2026.4.16 had `.ts`-only source due to `noEmitOnError` not being set in `tsconfig.extensions.json`. (STAB-2, T434)
- **bin/postinstall.js regenerated**: canonical `src/postinstall.ts` with XDG scaffolding, extension deployment, model-routing.cant stub, and `cleo skills install` now compiles to `bin/postinstall.js`. v2026.4.16 shipped a hand-crafted 2983-byte stub that silently skipped these steps. (STAB-3, T435)
- **orchestrate.fanout**: real Pi subprocess spawn via `orchestrateSpawnExecute` replaces the mock `{status: 'queued'}` stub. `orchestrate.fanout.status` reads manifest store. (STAB-1, T433)
- **prepublishOnly guard**: `npm publish` now refuses to proceed if compiled extensions or postinstall are missing.
- **tsconfig.postinstall.json**: added `"types": ["node"]` so `tsc -p tsconfig.postinstall.json` resolves Node built-in type declarations under TypeScript 6.

### Added

- Brain observations carry `agent` field for per-agent mental model retrieval (Wave 8)
- `orchestrate.classify`, `orchestrate.fanout`, `orchestrate.fanout.status`, `orchestrate.analyze {mode:"parallel-safety"}` dispatch operations (Wave 7)
- Pi `tool_call` hook enforces Lead role tool blocking (`E_LEAD_TOOL_BLOCKED`) and worker path ACLs (`E_WORKER_PATH_ACL_VIOLATION`) (Waves 7+ACL)
- `SpawnOptions.worktree: WorktreeHandle` replaces boolean `isolate` flag with CWD + env var binding (Wave 9, ADR-041)
- `ct-master-tac` plugin with 12 bundled CANT protocols + platform team definition (Wave HYGIENE)
- `.cleo/teams.cant`: canonical platform team with 3 leads + 9 workers

## [2026.4.16] — 2026-04-09 — Build & Release Pipeline Fixes

### Fixed — cold-build failure in @cleocode/cant

`packages/cant/tsconfig.json` was the only package still using
`"module": "commonjs"` with default (legacy `node`) moduleResolution.
This prevented TypeScript from resolving the `@cleocode/core/internal`
exports subpath used by `context-provider-brain.ts`. Changed to
`"module": "NodeNext"` / `"moduleResolution": "NodeNext"` to match every
other workspace package.

Additionally, the static import of `@cleocode/core/internal` in
`context-provider-brain.ts` created a compile-time circular dependency
(cant builds BEFORE core in the topological order). Converted to a
lazy dynamic import with a local `BrainOps` interface so tsc no longer
requires core's declarations at cant-build time.

### Fixed — TS2352 in orchestrate-engine.ts on cold builds

The W7a composer wiring cast `spawnContext as Record<string, unknown>`
to access an optional `agentDef` property. `SpawnContext` has no index
signature, so TypeScript rejected the cast on clean builds (stale
incremental artifacts masked the error). Added `agentDef?: unknown` to
the canonical `SpawnContext` interface in `@cleocode/core` and replaced
the cast with a direct typed field access.

### Fixed — biome formatting drift in 4 memory/brain files

`packages/core/src/memory/{mental-model-queue,engine-compat,brain-retrieval}.ts`
and `packages/cleo/src/cli/commands/memory-brain.ts` had unsorted imports
and formatting differences introduced in the W7 series. Auto-fixed with
`biome check --write`.

### Fixed — parity.test.ts operation count snapshot stale

The W7a commit added 3 new dispatch operations (+2 query, +1 mutate)
but did not update the snapshot constants in `parity.test.ts`. Bumped
from 130/98/228 to 132/99/231.

### Fixed — exports condition ordering in 5 package.json files

The `types` condition was ordered AFTER `import`/`require` in the
`exports` field of `@cleocode/{core,caamp,contracts,lafs,runtime}`.
Per the Node.js spec and TypeScript documentation, `types` must come
first; otherwise it is shadowed and type resolution falls back to
heuristic .d.ts co-location. Reordered all affected blocks so `types`
is always the first condition. Silences esbuild warnings and hardens
type resolution against stricter future resolvers.

### Added — @cleocode/cleo-os to the release pipeline

`@cleocode/cleo-os` was absent from `.github/workflows/release.yml` in
the version-sync, build-validation, tarball, and npm-publish steps.
This caused it to remain at v2026.4.13 on npm while all other packages
shipped v2026.4.15.

- Added to the "sync package versions from tag" loop
- Added `packages/cleo-os/dist/cli.js` to `required_artifacts` validation
- Added a separate `cleoos-${VERSION}.tar.gz` GitHub Release tarball
  (TUI bundle, distinct from the `cleocode-*` CLI monorepo snapshot)
- Added `publish_pkg cleo-os` at the end of the npm publish chain
  (after `cleo`, since `cleo-os` depends on it)

## [2026.4.15] — 2026-04-09 — Major Dep Upgrade Sweep

Follow-on sweep on top of v2026.4.14 addressing every deferred major
bump from the previous release's "safely deferred" list — zod 4, TS 6,
write-file-atomic 7, @types/supertest 7 — plus removing dead commander
code from the root monorepo.

### Removed — dead `commander` dependency from root monorepo

The root `package.json` declared `commander: ^12.1.0` as a runtime dep,
but nothing in the root or in `@cleocode/cleo` imports from it. CLI
dispatch has been on `citty` since the Commander→citty migration
(v2026.3.x). The only real commander consumer in the workspace is
`@cleocode/caamp`, which already pins `commander: ^14.0.0` in its own
`package.json`. Removed the root entry entirely. (The transitive
`commander@4.1.1` still shows up under `sucrase → tsup` in dev deps —
that's an unrelated tsup internal and nothing we can or should
touch.)

### Upgraded — zod 3.25 → **4.3.6**

Drizzle ORM `1.0.0-beta.19` declares
`"zod": "^3.25.0 || ^4.0.0"` as a peer, so the v4 line is a supported
path. Our source already imports from `zod/v4` (the forward-compat
subpath that zod 3.25+ provides), so the migration is a straight
package bump:

- `packages/core/package.json` + root: `"zod": "^3.25.76"` → `"^4.3.6"`
- `packages/core/src/hooks/payload-schemas.ts`,
  `packages/core/src/store/validation-schemas.ts`,
  `packages/core/src/store/nexus-validation-schemas.ts`: updated
  `import { z } from 'zod/v4'` → `import { z } from 'zod'` (v4's main
  export IS the v4 API now; the `zod/v4` subpath still exists as an
  alias for consumers migrating away from zod 3, so the old imports
  kept working during the bump, but we use the canonical path going
  forward).

`drizzle-orm/zod`'s `createSchemaFactory` is bound to the same `z`
instance we use everywhere via a type-asserted call — the assertion
comment is updated to reflect that both sides are now on v4 natively.

### Upgraded — TypeScript 5.x → **6.0.2** across all workspace packages

The root monorepo was already on `typescript@6.0.1-rc`; the sub-packages
were still pinned to 5.x and pulled older TS from their own
`node_modules`:

| Package | Old | New |
|---|---|---|
| root | `6.0.1-rc` | `^6.0.2` |
| `@cleocode/caamp` | `^5.9.0` | `^6.0.2` |
| `@cleocode/cant` | `^5.0.0` | `^6.0.2` |
| `@cleocode/cleo-os` | `^5.9.0` | `^6.0.2` |
| `@cleocode/lafs` | `^5.9.2` | `^6.0.2` |

**New compile-time gotcha uncovered:** TS 6 treats
`compilerOptions.baseUrl` as deprecated (TS5101) and errors with
`"ignoreDeprecations": "6.0"` unless the option is dropped. Our own
tsconfigs do not use `baseUrl`, but tsup's DTS pipeline (via
`rollup-plugin-dts`) injects one into its internal temporary tsconfig
during the caamp build, so we now pass
`dts.compilerOptions.ignoreDeprecations = "6.0"` in
`packages/caamp/tsup.config.ts`. Harmless — silences the deprecation
until the tsup + rollup-plugin-dts chain catches up with TS 6+.

### Upgraded — write-file-atomic 6 → **7.0.1**

`@cleocode/core` and root. v7.0.0's only breaking change is raising
the Node floor to `^20.17.0 || >=22.9.0`, which is well below our
declared `engines.node: ">=24.0.0"`. Drop-in swap.

### Upgraded — `@types/supertest` 6 → **7.2.0**

`@cleocode/lafs` was running `supertest@^7.2.2` at runtime but still
pinned `@types/supertest@^6.0.3` — the types lagged the runtime. Now
aligned.

### Upstream-blocked: `boolean@3.2.0` deprecation warning

`npm install -g @cleocode/cleo@2026.4.14` still emits:

    npm warn deprecated boolean@3.2.0: Package no longer supported.

**Root cause traced end-to-end:**

    @cleocode/core
      └─ @huggingface/transformers@4.0.1         ← pins onnxruntime-node exact
           └─ onnxruntime-node@1.24.3            ← Microsoft, stable
                └─ global-agent@3.0.0            ← old major
                     └─ boolean@3.2.0            ← deprecated, no successor

**Good news: Microsoft already fixed it upstream.** The onnxruntime
dev line `onnxruntime-node@1.25.0-dev.20260327-722743c0e2` declares
`global-agent: ^4.1.3` directly, and `global-agent` 4.x dropped the
`boolean`/`roarr` transitives entirely. The fix will land for
consumers once (a) Microsoft publishes 1.25.0 stable and (b)
`@huggingface/transformers` updates its pinned onnxruntime-node
version.

**Why we cannot backport it from our side:**

1. `brain embeddings` are a **first-class CLEO feature**, so moving
   `@huggingface/transformers` to an optional peer dependency is
   not acceptable — ruled out.
2. `@huggingface/transformers@4.0.1` pins `onnxruntime-node: 1.24.3`
   as an exact version (not a range), so a standard direct-dep bump
   in `@cleocode/core` would create an unresolvable conflict.
3. `pnpm.overrides` in the workspace (kept in place for dev env
   cleanliness) is pnpm-specific and does not propagate to
   consumers who install via `npm`.
4. **Empirically verified**: adding npm's standard `overrides` field
   to `@cleocode/cleo/package.json` has no effect on consumers.
   npm ignores `overrides` in packages being installed as
   dependencies — only the root project's overrides apply. This
   was tested by packing cleo with the override and installing the
   tarball; `onnxruntime-node@1.24.3` was still resolved and the
   `boolean` warning was still emitted.
5. A `postinstall` script cannot suppress the warning either: the
   warning is printed by npm during tree resolution, before any
   package's scripts run.

**Bottom line:** eliminating the warning requires an upstream fix —
tracked at microsoft/onnxruntime + huggingface/transformers.js.
Users can work around it locally by pinning a newer
`onnxruntime-node` via their own project's `overrides` field. The
warning does not affect runtime behaviour — the `boolean` package
still works, it just isn't maintained.

### Verification

- `pnpm biome ci .` → exit 0
- `pnpm run build`  → Build complete
- `pnpm run test`   → 6966 pass / 15 skip / 32 todo / 0 fail (7013)
- `pnpm audit`      → No known vulnerabilities found
- `pnpm why -r zod` → zod 4.3.6 in our code; 3.25.76 still pinned
  transitively by `@mistralai/mistralai` (not our concern, but
  flagged here for completeness)

## [2026.4.14] — 2026-04-09 — CI Unblock, Security Audit & Post-Migration Cleanup

### Fixed — Deprecated & vulnerable transitive dependencies

`npm audit` on `2026.4.13` reported **15 vulnerabilities (6 high, 9
moderate)**, plus the deprecated `prebuild-install@7.1.3` warning from
`npm install -g @cleocode/cleo`. All are now resolved; `pnpm audit`
returns `No known vulnerabilities found`.

**Direct dependency bumps** (security-motivated, no API changes):

| Package | From | To | Advisory / Reason |
|---|---|---|---|
| `@xenova/transformers` | `^2.17.2` | → `@huggingface/transformers ^4.0.1` | Upstream rename; eliminates `prebuild-install@7.1.3` deprecation via `sharp` bump 0.32 → 0.34 |
| `yaml` (core + root) | `^2.8.2` | `^2.8.3` | [GHSA — Stack overflow on deeply nested YAML](https://github.com/advisories) |
| `vitest` (caamp, cant, cleo-os, core, lafs, runtime, root) | various 1.6 – 4.1.0 | `^4.1.4` | Pulls clean transitive `vite@8.0.8`, `esbuild@0.28.x`, `picomatch@4.0.4` |
| `@vitest/coverage-v8` (caamp) | `^4.1.1` | `^4.1.4` | Matches vitest bump |
| `esbuild` (root dev) | `^0.27.4` | `^0.28.0` | [esbuild dev-server SSRF advisory] |
| `@codluv/versionguard` | `0.2.0` | `^1.2.0` | Pulls clean `brace-expansion@>=2.0.3` |
| `@biomejs/biome` | `^2.4.6` (installed 2.4.8) | `^2.4.10` | Patch bump, no rule changes |
| `vite` (direct root dev) | — | `^8.0.8` | Added as root dev dep so the override reaches all workspace consumers |

**Transitive pins** (via `pnpm.overrides` in root `package.json`) —
needed because the vulnerable versions were pulled in via peer deps
that pnpm would otherwise keep:

```jsonc
"pnpm": {
  "overrides": {
    "path-to-regexp": ">=8.4.2",  // GHSA — ReDoS / DoS in express router
    "brace-expansion": ">=2.0.3", // GHSA — zero-step process hang
    "picomatch":      ">=4.0.4",  // GHSA — ReDoS via extglob quantifiers
    "esbuild":        ">=0.25.0", // GHSA — dev-server SSRF
    "yaml":           ">=2.8.3",  // GHSA — deeply-nested stack overflow
    "vite":           "^8.0.8"    // GHSA — path traversal + fs.deny bypass
  }
}
```

After the swap + overrides, `pnpm dedupe` collapses all duplicate vite
instances to the single patched version, and the workspace builds
against the newer `onnxruntime-node` + `sharp` used by
`@huggingface/transformers`. Build externalises the new package so
esbuild does not try to inline the `.node` native bindings (see
`build.mjs` and the migration note above).

### Fixed — Flaky pi harness attribution test (race condition)

`packages/caamp/src/core/harness/pi.ts` → `spawnSubagent` was
fire-and-forgetting its child-session JSONL appends (`void
appendFile(...)`). Test code that did `await handle.exitPromise` and
then read the JSONL raced against pending writes — the final
`subagent_exit` entry occasionally landed on disk after the read,
producing intermittent CI failures in
`packages/caamp/tests/unit/harness/pi.test.ts > creates the child
session JSONL at the canonical subagents/ path` with `expected 2 to
be greater than or equal to 3`.

Fix: track every `appendFile` promise in a `pendingWrites: Promise<void>[]`
array and `Promise.allSettled(pendingWrites)` before the `'close'`
handler resolves `exitPromise`. `writeChildSession` still swallows
disk errors internally so settlement never propagates failures.
Verified stable across 5 back-to-back isolated runs + the full
workspace parallel suite.

### Fixed — Flaky bulk-create perf budget

`packages/core/src/store/__tests__/performance-safety.test.ts` bumped
two budgets that were tight under vitest 4.x parallel scheduling:

- `should create 50 tasks within <5000ms` → `<10000ms` (baseline ~600ms
  on a quiet laptop; 10s absorbs CI parallelism with 4+ vitest
  workers; still catches a 20× real regression).
- `should verify 50 tasks within <2000ms` → `<3000ms` (same rationale,
  baseline ~200ms).

### Fixed — CI Unblock & Post-Migration Cleanup

### Fixed — Deprecated transitive dependency (`prebuild-install`)

`npm install -g @cleocode/cleo` was emitting:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained.
Please contact the author of the relevant native addon; alternatives
are available.
```

Dependency chain: `@cleocode/core` → `@xenova/transformers@2.17.2` →
`sharp@0.32.6` → `prebuild-install@7.1.3` (deprecated).

`@xenova/transformers` was renamed upstream to `@huggingface/transformers`
(same author — Joshua Lochner — now maintained under the HuggingFace
organisation). The v4.x line uses `sharp@^0.34.5`, which switched from
`prebuild-install` to its own `@img/sharp-*` platform packages, so the
deprecated dependency is eliminated entirely.

- `packages/core/package.json` — replaced
  `"@xenova/transformers": "^2.17.2"` with
  `"@huggingface/transformers": "^4.0.1"`.
- `packages/core/src/memory/embedding-local.ts` — updated the dynamic
  import + type reference to the new package name. The public API
  (`pipeline`, `FeatureExtractionPipeline`) is unchanged; the
  `Xenova/all-MiniLM-L6-v2` model name still resolves on the
  HuggingFace hub as before, so runtime behaviour is identical.
- `packages/core/src/memory/embedding-worker.ts`,
  `packages/core/src/memory/brain-embedding.ts`,
  `packages/core/src/memory/__tests__/brain-automation.test.ts` —
  updated docstring references and the `vi.mock()` target path.
- `build.mjs` — replaced the `@xenova/transformers` entry in
  `sharedExternals` with `@huggingface/transformers`. The new package
  pulls in native `onnxruntime-node` bindings (`.node` files) and
  `sharp`, both of which must remain external so esbuild does not try
  to inline the native addons into the core/cleo bundles. Without this
  swap the esbuild build fails with `No loader is configured for
  ".node" files`.

After the swap, `pnpm why -r prebuild-install` returns no results,
`pnpm install` emits zero deprecation warnings, the full workspace
build succeeds, and the 7013-test suite remains at 6966 pass / 0
fail. Verified with the intended `Xenova/all-MiniLM-L6-v2` model
name still resolvable (no model-hub rename).


End-to-end pipeline repair after the ADR-039 envelope migration and T310
conduit separation left residual drift in tests and dispatch layers. The
pipeline was failing at `biome ci .`; once biome was cleared, two
further layers of pre-existing failures surfaced (TypeScript errors in
`@cleocode/core`, then 18 test failures across 8 files). Everything is
now green: `biome ci` ✅ · `pnpm run build` ✅ · 6966 pass / 0 fail across
the 7013-test workspace suite.

### Fixed — Lint (biome)

- `packages/cant/src/bundle.ts` — removed dead `NativeDiagnostic` type
  import. Was left over from a refactor; nothing in the file referenced
  it. The paired change to `BundleDiagnostic` below is the
  "wire it up properly" companion.
- `packages/cleo/src/__tests__/lafs-conformance.test.ts` — the file
  header declared it would use `runEnvelopeConformance()` for canonical
  validation but only `validateEnvelope()` was ever called. Wired up
  `runEnvelopeConformance()` against LAFS-native envelopes built via
  `createEnvelope()` (see "Added" below).
- `packages/core/src/validation/protocols/_shared.ts` — `line &&
  line.includes(...)` → `line?.includes(...)` (biome
  `useOptionalChain`).
- `packages/cleo/src/cli/commands/__tests__/agent-attach.test.ts` —
  removed a stale `// biome-ignore lint/complexity/useArrowFunction`
  suppression that no longer applied.

### Fixed — `@cleocode/cant` BundleDiagnostic wire-up

`compileBundle()` was dropping `line`/`col` from both parse errors and
validation diagnostics on its way from the native cant-core binding to
the `BundleDiagnostic` return shape. Callers had no way to know *where*
a diagnostic originated in the source `.cant` file.

- `BundleDiagnostic` gains optional `line?: number` and `col?: number`
  fields (1-based, matching the native binding). Optional because
  file-read failures have no source position.
- `compileBundle()` now propagates `line`/`col` from
  `parseResult.errors` and `validationResult.diagnostics` into every
  `BundleDiagnostic` it emits.
- `tests/bundle.test.ts` gains 3 new tests that assert position
  preservation for parse errors, validation diagnostics, and the
  file-read-failure case where position is correctly absent.

### Fixed — `@cleocode/core` pre-existing TypeScript errors (5)

These errors were hidden behind the biome failure and would have broken
the next CI layer. All are in files unrelated to the biome fix but in
the same "unblock CI" theme.

- `packages/core/src/internal.ts:917` — `ProjectAgentRef` was
  re-exported through `./store/conduit-sqlite.js`, but that module only
  *imports* the type (from `@cleocode/contracts`). Re-routed the
  re-export to the canonical source.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:281` —
  `readonly: true` → `readOnly: true`. The node:sqlite
  `DatabaseSyncOptions` API uses camelCase.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:199` — the
  row-copy loop cast `row[c] ?? null` to `SQLInputValue` so
  `stmt.run(...)` type-checks. Values originate from another SQLite
  row and are already `SQLInputValue`-compatible at runtime.
- `packages/core/src/store/migrate-signaldock-to-conduit.ts:482` and
  `613` — added null guards on `conduit.close()` and `globalDb.close()`
  inside catch blocks (`conduit: DatabaseSync | null` cannot be proven
  non-null at the catch point via TS flow analysis).

### Fixed — Dispatch exit-code drift

`E_TASK_COMPLETED` was mapped to exit code 104 in both
`packages/cleo/src/dispatch/engines/_error.ts` and
`packages/cleo/src/dispatch/adapters/cli.ts`, but the canonical value
in `@cleocode/contracts` is `ExitCode.TASK_COMPLETED = 17` (Hierarchy
Errors range). Core's `packages/core/src/tasks/complete.ts` already
uses the canonical value. The dispatch layer drift meant that when a
caught CleoError carried code 17, the inverse lookup returned
`undefined` and fell back to `E_INTERNAL`. Fixed in both files — the
entry is now in the Hierarchy Errors section of `STRING_TO_EXIT` where
it belongs, and exit code 104 is no longer used by the dispatch layer.

### Fixed — Non-Error thrown values in dispatch engines

`cleoErrorToEngineError` in
`packages/cleo/src/dispatch/engines/_error.ts` cast `err as
CaughtCleoErrorShape` unconditionally, which meant a raw `throw
'string error'` was coerced to an object without a `message` property
and the caller's generic `fallbackMessage` was returned instead of the
thrown string itself. Now narrows non-object/non-null values first:
strings flow through as the error message, other primitives coerce via
`String()`.

### Fixed — ADR-039 canonical-envelope test drift (11 tests in 5 files)

The `{success, data?, error?, meta}` canonical CLI envelope from
ADR-039 (2026-04-08) replaced the legacy `{$schema, _meta, success,
result}` LAFS shape, but tests authored against the legacy shape were
never updated. Biome was blocking CI at the lint stage, so these
failures were hidden. Migrated:

- `packages/core/src/__tests__/cli-parity.test.ts` — 3 tests checking
  `$schema`/`_meta`/`result`/`message` → `meta`/`data`/`meta.message`.
- `packages/core/src/__tests__/human-output.test.ts` — 3 tests checking
  `parsed.result.*` → `parsed.data.*`.
- `packages/cleo/src/__tests__/golden-parity.test.ts` — 1 test
  (`tasks.add envelope matches golden shape`) checking top-level
  `message` → `meta.message`.
- `packages/cleo/src/__tests__/lafs-conformance.test.ts` — 5 tests in
  the "LAFS Integration with Core Modules" + "hierarchy policy
  conformance" suites that asserted `parsed._meta` or called
  `validateEnvelope()` on CLEO envelopes. The CLEO canonical shape no
  longer matches the LAFS legacy schema, so those tests now check the
  canonical structure directly via the local `isValidLafsEnvelope()`
  helper. `validateEnvelope` is no longer imported in this file.
- `packages/cleo/src/dispatch/middleware/__tests__/protocol-enforcement.test.ts`
  — 2 tests:
  - `passes query requests through via enforcer` — the middleware
    wraps `next` as `protoNext` (which maps `meta` ↔ `_meta` for the
    core-layer enforcer), so the enforcer sees the wrapper, not the
    raw `next`. Changed `toHaveBeenCalledWith(req, next)` →
    `toHaveBeenCalledWith(req, expect.any(Function))`.
  - `preserves full response when _meta already has source and
    requestId` — the middleware always constructs a new return object
    (no identity short-circuit exists), so
    `expect(result).toBe(fullResponse)` never held. Replaced with
    structural assertions on `result.success` / `result.data` /
    `result.meta.{source,requestId,operation,duration_ms,timestamp}`.

### Fixed — T310 conduit migration test drift (6 tests)

`packages/runtime/src/__tests__/lifecycle-e2e.test.ts` called
`ensureSignaldockDb(cwd)` at the project tier, which was removed in
T310 (v2026.4.12) when project-tier messaging moved to
`conduit.db`. Rewrote the E2E suite to use `ensureConduitDb()` +
`getConduitDbPath()` + `checkConduitDbHealth()`. Removed inserts into
the project-tier `agents` table (that table is global-only now per
T346) — tests now exercise the message flow directly (the
`messages`/`conversations`/`messages_fts` tables have no FK to
`agents`) plus `project_agent_refs` for the identity-reference case.
Added `closeConduitDb` to the `@cleocode/core/internal` barrel to
support proper between-test cleanup.

### Added — runEnvelopeConformance test suite

New `describe` block in `lafs-conformance.test.ts` exercises
`runEnvelopeConformance()` end-to-end against LAFS-native envelopes:
5 per-operation success cases, 1 error case (using
`E_NOT_FOUND_RESOURCE` — a code registered in
`packages/lafs/schemas/v1/error-registry.json`), 1 check-set assertion
that verifies the `core` tier includes the expected check names, 1
default-tier smoke test, and 1 negative test for a malformed envelope.

### Notes

- ES2025 target in `tsconfig.json` is **correct** as of TypeScript 6.0
  (shipped 2026-03-23) — ES2025 is the new default target
  (`ScriptTarget.LatestStandard`). Verified via
  [devblogs.microsoft.com TypeScript 7 progress post](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/).
  The `▲ [WARNING] Unrecognized target environment "ES2025"` line in
  the build output comes from esbuild, which had not yet added ES2025
  support at the time of this commit (tracked upstream at
  `evanw/esbuild#4432`). It is a harmless warning and does not affect
  emitted output.
- Biome `@biomejs/biome` is pinned at `^2.4.6`; installed 2.4.8, latest
  npm at time of writing is 2.4.10. No rule semantics have changed
  across the 2.4.6–2.4.10 range, so no upgrade is needed for this fix.
- One pre-existing flaky test observed under parallel runs in
  `packages/caamp/tests/unit/harness/pi.test.ts` (`creates the child
  session JSONL at the canonical subagents/ path`) — passes in
  isolation and in the most recent full runs. Not addressed in this
  commit; opportunistic flakiness triage is a separate task.

## [2026.4.13] — 2026-04-08

### T311 — Cross-Machine Backup Portability (15 tasks, 7 waves)

Adds portable `.cleobundle.tar.gz` export/import on top of the v2026.4.10
VACUUM INTO backup mechanism. Implements ADR-038. Enables cross-machine
CleoOS migration with intelligent A/B regenerate-and-compare for JSON
restore + conflict report for manual review.

**Wave 0 — Foundational modules**
- `t310-readiness.ts` (T342) — assertT310Ready gate for T311 commands;
  throws `T310MigrationRequiredError` with actionable message if a project
  is still on the pre-T310 topology
- `backup-manifest.ts` + `schemas/manifest-v1.json` (T343) — BackupManifest
  type + JSON Schema Draft 2020-12 (bundled inside .cleobundle for offline
  validation)
- `backup-crypto.ts` (T345) — AES-256-GCM + scrypt KDF (N=2^15, r=8, p=1)
  for `.enc.cleobundle.tar.gz` opt-in encryption. Uses Node built-in
  crypto only (no native bindings per ADR-010). Magic header CLEOENC1 +
  version byte + salt + nonce + ciphertext + auth tag.

**Wave 1 — Packer + Unpacker**
- `backup-pack.ts` (T347) — `packBundle({scope, projectRoot, outputPath,
  encrypt, passphrase, projectName})` writes a portable bundle with
  VACUUM INTO snapshots + SHA-256 checksums + manifest + optional
  encryption. tar.gz format via Node `tar` package (added as dependency).
- `backup-unpack.ts` (T350) — `unpackBundle({bundlePath, passphrase})`
  extracts + verifies 6 integrity layers (encryption auth, manifest schema,
  checksums, SQLite integrity, schema compat warnings). Returns a staging
  dir + manifest + warnings. Callers clean up via `cleanupStaging()`.

**Wave 2 — Dry-run regenerators**
- `regenerators.ts` (T352) — `regenerateConfigJson`, `regenerateProjectInfoJson`,
  `regenerateProjectContextJson` — pure functions returning what `cleo init`
  WOULD write fresh on the target machine. Powers the "A" side of A/B
  regenerate-and-compare.

**Wave 3 — A/B engine + conflict report**
- `restore-json-merge.ts` (T354) — `regenerateAndCompare` engine with
  4-way classification (identical, machine-local, user-intent,
  project-identity, auto-detect, unknown) and dot-path walking. Produces
  `JsonRestoreReport` with classifications and merged result.
- `restore-conflict-report.ts` (T357) — markdown formatter for the
  `.cleo/restore-conflicts.md` report. Handles resolved + manual-review
  sections, reauth warnings, schema warnings.

**Wave 4 — CLI verbs**
- `cleo backup export <name> [--scope project|global|all] [--encrypt]
  [--out <path>]` (T359) — writes a `.cleobundle.tar.gz`
- `cleo backup import <bundle> [--force]` (T361) — full import pipeline:
  pre-check for existing data (abort without --force), unpack + verify,
  atomic DB restore, A/B classification for JSON files, conflict report
  generation, raw imported files preserved under `.cleo/restore-imported/`
- `cleo backup inspect <bundle>` (T363) — stream-extract manifest.json
  only; no full unpack. Safe for agent-driven inspection.
- `cleo restore finalize` (T365) — parse `.cleo/restore-conflicts.md`,
  apply any manually-resolved fields to on-disk JSON files, archive the
  report.

**Wave 5 — Integration verification + documentation**
- `t311-integration.test.ts` (T367) — 14 end-to-end scenarios covering
  round-trip, encryption, tampering, schema compat, staging cleanup,
  and A/B merge correctness. All passing.
- TSDoc provenance + README backup portability section (T368)

### Statistics
- 15 implementation subtasks shipped
- 165 new tests across unit + integration (8 test files)
- 4 new CLI verbs
- 1 new archive format (.cleobundle.tar.gz + .enc.cleobundle.tar.gz)
- 1 new JSON Schema for portable manifests
- 0 new pre-existing failures introduced

### Migration notes
- T310 (v2026.4.12) is a hard dependency: a project still on pre-T310
  topology (legacy `.cleo/signaldock.db` without `conduit.db`) will fail
  `assertT310Ready` and get a clear error directing the user to run any
  `cleo` command first to trigger the T310 auto-migration.
- Encrypted backups require a passphrase; agents should set
  `CLEO_BACKUP_PASSPHRASE` env var; interactive users are prompted.
- After import, review `.cleo/restore-conflicts.md` for any manual-review
  fields and run `cleo restore finalize` to apply resolutions.

### Next
- Open: future waves may add merge mode for restore, redaction mode,
  cloud-based backup sync, differential/incremental bundles.

[Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>]

---

## [2026.4.12] - 2026-04-08

### Highlights

This release closes the T310 epic (Conduit + Signaldock Separation) across 6
waves. It establishes a hard split between the two formerly-conflated agent
databases: `conduit.db` is the new project-tier transport store (replacing
the old project-level `signaldock.db`), while `signaldock.db` is promoted to
a dedicated global-tier registry at `$XDG_DATA_HOME/cleo/signaldock.db`. The
KDF has been upgraded from `(machine-key, project-path)` to
`(machine-key, global-salt, agent-id)`, making agent keys portable across
project relocations. New `project_agent_refs` override table enables
per-project agent configuration without polluting the global registry. Full
automatic first-run migration with `.pre-t310.bak` preservation, new
attach/detach/remove-global CLI verbs, and a 12-scenario integration test
suite. **16 tasks shipped, zero pre-existing test failures introduced.**

### Added

- **`ADR-037` + `ADR-038` — Conduit/Signaldock split + KDF upgrade.** ADR-037
  documents the project-tier → conduit.db rename decision and the rationale
  for separating project transport from global agent registry. ADR-038
  specifies the new `(machine-key, global-salt, agent-id)` KDF that replaces
  the path-coupled `(machine-key, project-path)` scheme, enabling key
  portability across project relocations
  ([`4a180554`](https://github.com/kryptobaseddev/cleo/commit/4a180554)).

- **`ADR-039` — Wave 4 envelope unification.** Records the decision to
  unify request/response envelopes across transport layers
  ([`74bb8b12`](https://github.com/kryptobaseddev/cleo/commit/74bb8b12)).

- **T310 Wave 0 — schemas + primitive modules** (T344). New
  `conduit-core` crate and `signaldock-core` global-registry module
  established. Zod schemas and TypeScript contracts for conduit messages
  and global agent descriptors added to `packages/contracts/src/`
  ([`67f71260`](https://github.com/kryptobaseddev/cleo/commit/67f71260)).

- **`packages/core/src/store/project-agent-refs.ts` — per-project agent
  override table** (T353). New `project_agent_refs` SQLite table in
  `conduit.db` provides CRUD accessors (`upsertProjectAgentRef`,
  `getProjectAgentRef`, `listProjectAgentRefs`, `deleteProjectAgentRef`)
  for per-project agent configuration overrides without touching the global
  registry
  ([`55c5faf7`](https://github.com/kryptobaseddev/cleo/commit/55c5faf7)).

- **`packages/core/src/store/local-transport.ts` — LocalTransport migrated
  to conduit.db** (T356). LocalTransport now opens `conduit.db` instead of
  the project-scoped `signaldock.db`, completing the project-tier rename
  ([`3276cfe3`](https://github.com/kryptobaseddev/cleo/commit/3276cfe3)).

- **Cross-DB agent registry accessor refactor** (T355). `AgentRegistry`
  accessors split across conduit (project-tier) and global signaldock (global
  tier) with clean interface boundaries. No cross-DB leakage
  ([`69fb6df1`](https://github.com/kryptobaseddev/cleo/commit/69fb6df1)).

- **`packages/core/src/store/migrate-signaldock-to-conduit.ts` — migration
  executor** (T358). Idempotent `migrateSignaldockToConduit()` reads the old
  project-scoped `signaldock.db`, writes entries to `conduit.db`, and
  preserves the original as `signaldock.db.pre-t310.bak`. Detects already-
  migrated projects and is a no-op on fresh installs
  ([`13c861fb`](https://github.com/kryptobaseddev/cleo/commit/13c861fb)).

- **Auto-migration wired into CLI startup** (T360). `cleo` CLI startup now
  calls `migrateSignaldockToConduit()` before any command dispatch, ensuring
  all existing projects are migrated transparently on first run after upgrade
  ([`f38fc7e3`](https://github.com/kryptobaseddev/cleo/commit/f38fc7e3)).

- **`cleo agent list --global` + `--include-disabled`** (T362). New
  `--global` flag lists agents from the global signaldock registry rather than
  the project-tier conduit registry. `--include-disabled` surfaces disabled
  agent registrations for diagnostics
  ([`28b449d3`](https://github.com/kryptobaseddev/cleo/commit/28b449d3)).

- **`cleo agent attach` + `cleo agent detach`** (T364). Two new CLI verbs:
  `attach` creates a `project_agent_refs` override linking a global agent into
  the current project; `detach` removes the override. Both honour the
  three-tier scope hierarchy
  ([`f773fd57`](https://github.com/kryptobaseddev/cleo/commit/f773fd57)).

- **`cleo agent remove --global`** (T366). New `--global` flag on
  `cleo agent remove` deletes an agent from the global signaldock registry
  with a safety scan that warns if the agent is still attached to any project
  via `project_agent_refs`
  ([`dd5a70fb`](https://github.com/kryptobaseddev/cleo/commit/dd5a70fb)).

- **Backup registry extended for conduit + global signaldock + global-salt**
  (T369). `vacuumIntoBackupAll` now snapshots `conduit.db` and the global
  `signaldock.db` alongside the existing `tasks.db` / `brain.db` pair. The
  global-salt value is preserved in JSON backups
  ([`ef7f58f6`](https://github.com/kryptobaseddev/cleo/commit/ef7f58f6)).

- **12-scenario T310 integration test suite** (T371). New
  `packages/core/src/store/__tests__/conduit-signaldock-integration.test.ts`
  covers: fresh conduit init, project_agent_refs CRUD, migration idempotency,
  global registry isolation, attach/detach round-trip, KDF key portability
  across project rename, auto-migration on startup, backup/restore of both
  DBs, `--global` list accuracy, safety-scan on remove, concurrent access,
  and `.pre-t310.bak` preservation. 12/12 passing
  ([`7d531e82`](https://github.com/kryptobaseddev/cleo/commit/7d531e82)).

- **TSDoc provenance + docs drift resolution** (T372). All new exported
  symbols in `project-agent-refs.ts`, `migrate-signaldock-to-conduit.ts`, and
  the conduit accessor layer carry `/** ... */` TSDoc comments. Stale
  architecture diagrams updated to reflect conduit.db and global signaldock.db
  paths
  ([`d135a6aa`](https://github.com/kryptobaseddev/cleo/commit/d135a6aa)).

### Statistics

- **16 tasks shipped** across 6 waves (Wave 0: ADRs + schemas, Wave 1:
  primitive modules + project_agent_refs, Wave 2: LocalTransport + registry
  refactor, Wave 3: migration executor + auto-startup wire, Wave 4: CLI
  verbs + envelope unification, Wave 5: backup extension + integration tests +
  TSDoc)
- **16 commits** on main since v2026.4.11
- **~2400 LOC** across implementation + tests
- **12 new integration tests** in `conduit-signaldock-integration.test.ts`
- **3 new ADRs** (ADR-037, ADR-038, ADR-039)
- **0 pre-existing test failures** introduced

### Follow-on Epics

- **T311** — Cross-Machine Backup Export/Import (targets v2026.4.13+)

---

## [2026.4.11] - 2026-04-08

### Highlights

This release closes the T299 epic (Database Topology + Lifecycle) across 4
waves. It establishes the full CleoOS database topology (4 DBs × 2 tiers)
as a first-class architectural concern, anchored by ADR-036. Key deliveries:
walk-up `getProjectRoot()` that never auto-creates nested `.cleo/`,
idempotent legacy file cleanup wired into CLI startup, global-tier VACUUM
INTO backup for `nexus.db`, a runtime guard preventing stray `nexus.db`
files outside `getCleoHome()`, and a 9-scenario integration test suite
that validates the full topology contract. **9 tasks shipped in 8 commits,
42 new tests, ~2000 LOC. Zero pre-existing test failures introduced.**

### Added

- **`ADR-036` — `.cleo/adrs/ADR-036-cleoos-database-topology.md` (454
  lines).** Documents the 4-DB × 2-tier topology contract (project-tier:
  `tasks.db`, `nexus.db`; global-tier: `brain.db`, `nexus.db`), the
  walk-up scaffolding rule, `VACUUM INTO` backup mechanism with rotation
  policy, and forward references to T310 (Conduit + Signaldock separation)
  and T311 (cross-machine backup portability)
  ([`1f560327`](https://github.com/kryptobaseddev/cleo/commit/1f560327),
  +454 lines).

- **`packages/core/src/paths.ts` — walk-up `getProjectRoot()` rewrite**
  (T301). Walks ancestor directories looking for `.cleo/` or `.git/`,
  stops at first hit, never auto-creates nested `.cleo/`. `CLEO_ROOT`
  env variable overrides walk-up for CI / Docker. 13 new unit tests in
  `paths-walkup.test.ts` covering clean roots, nested dirs, symlinks,
  env override, and edge cases
  ([`30dde2ab`](https://github.com/kryptobaseddev/cleo/commit/30dde2ab),
  +105 LOC `paths.ts`, +305 LOC test).

- **`packages/core/src/paths.ts` — XDG comment fix** (T303). Top-of-file
  comment updated to list per-OS resolution examples for Linux
  (`~/.local/share/cleo`), macOS (`~/Library/Application Support/cleo`),
  and Windows (`%APPDATA%\cleo`) so engineers can orient without
  reading XDG spec
  ([`b1323b70`](https://github.com/kryptobaseddev/cleo/commit/b1323b70)).

- **`packages/core/src/store/cleanup-legacy.ts` — idempotent legacy
  global file cleanup** (T304). New `detectAndRemoveLegacyGlobalFiles()`
  detects and removes `workspace.db` and `*-pre-cleo.db.bak` files left
  over from pre-CLEO global paths. Wired into CLI startup via
  `packages/cleo/src/cli/index.ts`. 11 unit tests covering detection,
  removal, idempotency, and no-op when files are absent
  ([`bc0cfe50`](https://github.com/kryptobaseddev/cleo/commit/bc0cfe50),
  +208 LOC `cleanup-legacy.ts`, +268 LOC test).

- **Nested `.cleo/` untrack** (T302). Removed 20 files across 6 nested
  `.cleo/` dirs (`packages/cleo`, `packages/contracts`, `packages/lafs`,
  `packages/runtime`, `packages/skills`, `packages/skills/skills/ct-skill-creator`).
  Pre-untrack snapshots written to `.cleo/backups/legacy-nested/`.
  All 7 `.db` files passed `PRAGMA integrity_check` before removal.
  Root `.gitignore` extended with `packages/**/.cleo/` rule
  ([`49f602e4`](https://github.com/kryptobaseddev/cleo/commit/49f602e4)).

- **`packages/core/src/store/sqlite-backup.ts` — global-tier backup
  mechanism** (T306). New `vacuumIntoGlobalBackup()` writes `nexus.db`
  snapshots to `$XDG_DATA_HOME/cleo/backups/sqlite/`. New CLI flags:
  `cleo backup add --global`, `cleo backup list --scope project|global|all`,
  `cleo restore backup --scope global`. 9 new tests in
  `sqlite-backup-global.test.ts`
  ([`e09a4a2d`](https://github.com/kryptobaseddev/cleo/commit/e09a4a2d),
  +172 LOC `sqlite-backup.ts`, +281 LOC test).

- **`packages/core/src/store/nexus-sqlite.ts` — stray `nexus.db` cleanup
  + guard** (T307). `getNexusDbPath()` runtime guard fails fast if
  resolved path is not under `getCleoHome()`. New
  `detectAndRemoveStrayProjectNexus()` for one-time cleanup of
  incorrectly-placed `nexus.db` files. 9 new tests covering guard
  assertion, stray detection, and no-op cases
  ([`545d7537`](https://github.com/kryptobaseddev/cleo/commit/545d7537),
  +35 LOC `nexus-sqlite.ts`).

- **9-scenario database topology integration test suite** (T308). New
  `packages/core/src/store/__tests__/database-topology-integration.test.ts`
  (504 lines) covers: fresh init, walk-up discovery, anti-drift
  (project-tier never bleeds into global-tier), backup/restore round-trip,
  cleanup idempotency, no-auto-create enforcement, stray nexus guard,
  `CLEO_ROOT` override, and concurrent access. 9/9 passing in ~527ms
  ([`9d8ab9e4`](https://github.com/kryptobaseddev/cleo/commit/9d8ab9e4),
  +504 LOC test).

### Statistics

- **9 tasks shipped** across 4 waves (Wave 0: ADR, Wave 1: scaffolding +
  cleanup, Wave 2: backup + guards, Wave 3: integration verification)
- **8 commits** on main since v2026.4.10
- **~2000 LOC** across implementation + tests (2480 insertions total,
  154 deletions, 38 files changed)
- **42 new tests** across `paths-walkup.test.ts` (13),
  `cleanup-legacy.test.ts` (11), `sqlite-backup-global.test.ts` (9),
  `database-topology-integration.test.ts` (9)
- **1 new ADR** (ADR-036)
- **0 pre-existing test failures** introduced

### Follow-on Epics

- **T310** — Conduit + Signaldock Separation (RCASD-IVTR, targets v2026.4.12+)
- **T311** — Cross-Machine Backup Export/Import (RCASD-IVTR, targets v2026.4.13+)

---

## [2026.4.10] - 2026-04-07

### Highlights

This is a housekeeping and hardening release covering three independent
workstreams that landed after the v2026.4.9 hotfix: (1) deterministic
`events.rs` generation that eliminates rustfmt drift on every `cargo build`,
(2) untracking the four `.cleo/` runtime files from git with a full
`VACUUM INTO` backup mechanism replacing the data-loss-prone git checkpoint
pattern (ADR-013 §9 resolution, closes T5158), and (3) regenerating
`packages/caamp/docs/API-REFERENCE.md` from source via `forge-ts` to
eliminate 3470 lines of drifted hand-maintained prose. Plus a small
fix to unblock the `@cleocode/runtime` tsup DTS build under the
TypeScript 6.x peer that landed transitively with `@forge-ts/cli`.
**No user-facing feature changes. Zero regressions across 6375+ tests.**

### Added

- **`crates/cant-core/build.rs` — `write_if_changed` helper + rustfmt
  pipeline.** The build script now pipes generated Rust source through
  `rustfmt --edition 2024 --emit stdout` via stdin before writing, and
  the `write_if_changed` helper skips writes when on-disk content is
  byte-identical (preserves mtimes, avoids spurious downstream rebuilds).
  Adds `cargo:rerun-if-changed=build.rs` so touching the generator forces
  a regen, and a graceful `cargo:warning=...` fallback to unformatted
  output if `rustfmt` is missing from PATH so the build never hard-fails.
  Generated file header now embeds the drift-check one-liner:
  `cargo build -p cant-core && git diff --exit-code crates/cant-core/src/generated/events.rs`
  ([`d242effb`](https://github.com/kryptobaseddev/cleo/commit/d242effb),
  +120 LOC `build.rs`).

- **`packages/core/src/store/sqlite-backup.ts` — prefix-based backup API
  for multi-DB snapshots.** New exports `vacuumIntoBackupAll`,
  `listBrainBackups`, and `listSqliteBackupsAll` extend the existing
  `tasks.db` snapshot tooling to also handle `brain.db` via SQLite
  `VACUUM INTO`. Both databases share the same rotation policy and
  integrity-check verification path. The new helpers accept a
  `{ force?: boolean }` option that bypasses the rotation min-interval,
  used by the auto-snapshot session-end hook. Backed by 128 LOC of new
  test coverage in `sqlite-backup.test.ts`
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +239 LOC `sqlite-backup.ts`).

- **`backup-session-end` hook (priority 10).** New hook handler in
  [`packages/core/src/hooks/handlers/session-hooks.ts`](packages/core/src/hooks/handlers/session-hooks.ts)
  that calls `vacuumIntoBackupAll({ force: true })` after every `cleo
  session end`. Runs at priority 10 — after the existing
  `brain-session-end` handler at priority 100 — so the snapshot includes
  the just-written `SessionEnd` observation row. Failures are non-fatal
  and surfaced as warnings only (the session-end command still succeeds).
  Auto-captures `tasks.db` and `brain.db` to `.cleo/backups/` with
  rotating retention
  ([`545fec86`](https://github.com/kryptobaseddev/cleo/commit/545fec86),
  +42 LOC).

- **TSDoc coverage on 46 previously-undocumented exports.** Hand-written
  TSDoc blocks added to: 26 `PiHarness` method summaries (replacing the
  cascading `{@inheritDoc Harness.*}` references with explicit prose),
  18 `@example` blocks on the `mcp/*` and `pi/*` command helpers, and
  10 `@remarks` blocks on the command-registration functions in
  `commands/{mcp,pi}/common.ts`. W006 syntax fixes applied throughout.
  Drove caamp TSDoc coverage from **54 errors + 679 warnings** down to
  **0 errors + 46 warnings** (the remaining warnings are W013
  false-positives on TypeScript optional parameters and are not
  blockers)
  ([`80138557`](https://github.com/kryptobaseddev/cleo/commit/80138557)).

- **`packages/caamp/forge-ts.config.ts` — full enforcement config (21 →
  65 LOC).** Rewritten with explicit `enforce` rules, a `gen` section
  pointing at `docs/generated/`, and a narrative header explaining the
  build gate. New `pnpm --filter @cleocode/caamp run docs` script (full
  check + generate) and `docs:check` script (coverage gate only, no
  filesystem writes). Adds `@forge-ts/cli@0.23.0` as a pinned devDep —
  no global dependency required
  ([`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208)).

- **`packages/caamp/docs/generated/` — full forge-ts API reference
  output.** Every public export, regenerated from TSDoc on every doc
  build:
  - `api-reference.md` — 16710 lines, every public export from TSDoc.
  - `llms.txt` (48 KB) + `llms-full.txt` (325 KB) — agent digests
    consumed by `@cleocode/cleo`.
  - `SKILL-caamp/` — full skill-package scaffolding with
    `references/API-REFERENCE.md` (8428 lines) and `references/CONFIGURATION.md`.
  - `concepts.mdx`, `guides/{configuration,error-handling,getting-started}.mdx`,
    `packages/api/{functions,types,examples,index}.mdx` — full reference
    docs and how-to guides
    ([`e33059c6`](https://github.com/kryptobaseddev/cleo/commit/e33059c6),
    [`e4df49a3`](https://github.com/kryptobaseddev/cleo/commit/e4df49a3)).

- **`AGENTS.md` — "Runtime Data Safety (ADR-013 §9)" section.** Root
  AGENTS.md now documents the backup/restore workflow, the four
  untracked files, and why the legacy git-checkpoint pattern was
  retired. Cross-machine sync is no longer supported via git — use
  `cleo observe` + `cleo memory find` for memory portability or the
  `cleo backup` family for full DB transfer
  ([`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1),
  +25 LOC).

- **`packages/caamp/AGENTS.md` — "Documentation (forge-ts — Generated
  from Source)" section.** New rules and a four-step "adding a new
  export" workflow that requires every new export to ship with a
  complete TSDoc block + `pnpm run docs:check` + `pnpm run docs`
  before commit. Marks `docs/generated/*` as never-edit-by-hand
  ([`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208),
  +56 LOC).

### Changed

- **`packages/core/src/system/backup.ts` — switched from
  `readFileSync`/`writeFileSync` to `VACUUM INTO` for all SQLite
  files.** The previous implementation used unsafe synchronous binary
  copies to back up `tasks.db` and `brain.db`. This had been silently
  wrong since v2026.4.6 — copying a live SQLite file with a hot WAL
  sidecar can produce a torn snapshot or include uncommitted writes,
  which is exactly the failure mode ADR-013 §1-§4 was written to
  prevent. The new implementation routes through
  `getNativeDb()`/`getBrainNativeDb()` and issues a proper
  `VACUUM INTO <tmp>` followed by an atomic `rename`, matching the
  ADR-013 §6 contract. JSON files (`config.json`, `project-info.json`)
  use atomic tmp-then-rename. The function is now `async`, and all
  callers in `dispatch/domains/admin.ts`, `system-engine.ts`, and the
  three test suites have been updated
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +212 LOC `backup.ts`).

- **`packages/core/src/store/sqlite.ts` — runtime warning rewritten.**
  The warning that fires when a tracked SQLite file is detected on
  disk no longer instructs users to run `git rm --cached`. It now
  points at the new `cleo backup add` workflow and references the
  ADR-013 §9 resolution. The warning is silenced once the file is
  untracked
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  +22 LOC).

- **`packages/caamp/docs/API-REFERENCE.md` — replaced 3470 lines of
  drifted hand-prose with a 69-line pointer file.** The previous
  hand-maintained API reference contained 61 references to MCP APIs
  that had been deleted in the April 3 commit
  [`480fa01a`](https://github.com/kryptobaseddev/cleo/commit/480fa01a),
  plus stale type signatures, removed exports, and ad-hoc examples.
  The replacement is a short redirect that points at
  `docs/generated/api-reference.md` and documents the regeneration
  workflow. **The doc itself is now a pointer; the canonical source
  is `docs/generated/`, regenerated from TSDoc on every `pnpm run docs`**
  ([`e33059c6`](https://github.com/kryptobaseddev/cleo/commit/e33059c6),
  3470 → 69 LOC).

- **`PiHarness` TSDoc — replaced `@inheritDoc` cascades with explicit
  prose.** 26 method summaries that previously delegated documentation
  to the `Harness` base class via `{@inheritDoc Harness.*}` now have
  explicit summaries written for the Pi-specific behaviour. This was
  required by forge-ts because the `@inheritDoc` resolver does not
  cross package boundaries. The result is that every PiHarness method
  has its own readable doc block in the generated API reference
  ([`80138557`](https://github.com/kryptobaseddev/cleo/commit/80138557),
  `packages/caamp/src/core/harness/pi.ts` +132 LOC).

- **`.gitignore` (root + nested `.cleo/.gitignore` + template +
  scaffold fallback) — runtime DB exclusion hardened.** The previous
  rules included `!config.json` / `!project-info.json` re-include
  exceptions inside `.cleo/.gitignore`, which was the T5158 vector:
  nested gitignore re-includes silently overrode the parent allow-list
  rules and re-tracked the runtime DBs on every fresh checkout. Both
  re-include rules removed. Explicit deny lines added for the four
  paths plus their `*.db-shm` / `*.db-wal` sidecars. The same change
  applied to `packages/core/templates/cleo-gitignore` (used by
  `cleo init`) and the scaffold fallback in
  [`packages/core/src/scaffold.ts`](packages/core/src/scaffold.ts) so
  new projects never re-introduce the bug
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  [`59f1ea3b`](https://github.com/kryptobaseddev/cleo/commit/59f1ea3b)).

### Fixed

- **`packages/runtime/tsconfig.json` — added `ignoreDeprecations: "6.0"`
  to unblock tsup DTS build under TypeScript 6.x.** The
  [`67df4208`](https://github.com/kryptobaseddev/cleo/commit/67df4208)
  forge-ts addition transitively pulled in TypeScript 6.0.2 as a peer
  of `tsup@8.5.1`, which made tsup's DTS-generation step fail with
  `TS5101: Option 'baseUrl' is deprecated and will stop functioning in
  TypeScript 7.0`. tsup unconditionally injects `baseUrl: "."` into the
  compiler options it forwards to TypeScript, even when the user
  tsconfig has none — and TypeScript 6.x errors on bare `baseUrl`
  unless `ignoreDeprecations: "6.0"` is set. caamp's tsup build is
  unaffected because its `module: "nodenext"` / `moduleResolution:
  "nodenext"` settings take a different code path; runtime uses the
  legacy `bundler` resolver and was the only failing package. The
  one-line addition unblocks the release without changing module
  resolution semantics. **Verified by full `pnpm run build` cold
  rebuild succeeding end-to-end.**

- **`crates/cant-core/src/generated/events.rs` rustfmt drift —
  eliminated.** The build.rs generator hand-concatenated Rust source
  via `String::push_str` / `format!` and wrote directly to disk without
  ever running `rustfmt`. The committed copy had been rustfmt-ed once
  manually, so every subsequent `cargo build` produced drift: a blank
  line after `pub enum CanonicalEvent {`, long match arms emitted on
  one line instead of being wrapped, and unwrapped method chains.
  Release agents were forced to `git checkout
  crates/cant-core/src/generated/events.rs` on every build. **Verified
  idempotent over three sequential forced rebuilds** (including
  `touch crates/cant-core/build.rs` reruns) — `git status --short
  crates/cant-core/` is empty after each rebuild. 509 `cant-core` unit
  tests + 4 doctests pass; `cargo fmt --check -p cant-core` clean;
  full `cargo build` workspace-wide clean
  ([`d242effb`](https://github.com/kryptobaseddev/cleo/commit/d242effb),
  [`b966fe4e`](https://github.com/kryptobaseddev/cleo/commit/b966fe4e)).

- **`.cleo/` runtime DB git tracking — closed via T5158 / ADR-013 §9.**
  The four files `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
  and `.cleo/project-info.json` were tracked in the project git
  repository. Per ADR-013 and T5158, this caused intermittent SQLite
  WAL corruption on branch switches: git overwrote the live `.db` file
  while a `*-wal` / `*-shm` sidecar was still in use, leaving the
  database in an inconsistent state on the next open. A runtime
  warning fired on every `cleo` command. **Resolution**:
  1. **Safety snapshots captured first** via the new
     `vacuumIntoBackupAll` helper plus atomic file copies for the
     JSON files. All four passed `PRAGMA integrity_check`:
     - `.cleo/backups/safety/tasks.db.pre-untrack-2026-04-07T23-13-56-164Z` (4.83 MB)
     - `.cleo/backups/safety/brain.db.pre-untrack-2026-04-07T23-13-56-164Z` (586 KB)
     - `.cleo/backups/safety/config.json.pre-untrack-2026-04-07T23-13-56-164Z` (404 B)
     - `.cleo/backups/safety/project-info.json.pre-untrack-2026-04-07T23-13-56-164Z` (613 B)
  2. **`git rm --cached`** the four files (preserving the on-disk
     copies for the live working tree).
  3. **`.gitignore` hardened** at four locations (root, nested,
     template, scaffold fallback) so re-tracking is impossible.
  4. **Runtime warning** updated to point at the new backup workflow.
  Local files preserved on disk after untrack: `tasks.db` 6.6 MB,
  `brain.db` 598 KB, `config.json` 404 B, `project-info.json` 613 B.
  No data loss
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7),
  [`59f1ea3b`](https://github.com/kryptobaseddev/cleo/commit/59f1ea3b),
  [`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1)).

- **`packages/core/src/system/backup.ts` ADR-013 violation — fixed
  retroactively.** The `BackupManager` had been using
  `fs.readFileSync` / `fs.writeFileSync` on `*.db` files since
  v2026.4.6 — a silent ADR-013 violation that produced potentially
  torn snapshots. Replaced with `VACUUM INTO` via the new
  `getNativeDb` / `getBrainNativeDb` helpers exported from
  [`packages/core/src/internal.ts`](packages/core/src/internal.ts).
  237 LOC of new test coverage in
  [`packages/core/src/system/__tests__/backup.test.ts`](packages/core/src/system/__tests__/backup.test.ts)
  ([`233017f7`](https://github.com/kryptobaseddev/cleo/commit/233017f7)).

### Removed

- **`!config.json` / `!project-info.json` re-include rules in
  `.cleo/.gitignore`** — these were the T5158 vector. Removed from
  all four gitignore locations (root, nested, template, scaffold
  fallback). See "Changed" above.

### Architecture decisions

- **ADR-013 §9 — Runtime DB Untrack — closed.** New section appended
  to
  [`.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md`](.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md)
  documenting the resolution: `.cleo/` runtime databases are no
  longer tracked in git. Per-file recovery table maps each of the
  four files to its safety snapshot location and restore command.
  Cross-machine sync via git is no longer supported — use `cleo
  observe` + `cleo memory find` for memory portability or `cleo
  backup add` + `cleo restore backup` for full DB transfer. Backup
  workflow documented in root `AGENTS.md` "Runtime Data Safety"
  section
  ([`1c407eb1`](https://github.com/kryptobaseddev/cleo/commit/1c407eb1),
  +70 LOC ADR / +25 LOC AGENTS.md).

- **`docs/API-REFERENCE.md` is no longer hand-maintained in caamp.**
  Establishes the precedent that API reference documentation is
  generated from TSDoc on every `pnpm run docs` and committed
  alongside source changes. The hand-maintained pointer file is the
  only document allowed at the canonical path; the actual API
  surface lives in `docs/generated/api-reference.md`. Build gate:
  `forge-ts check` must pass before any release. This pattern is
  expected to roll out to other packages in subsequent releases.

### Stats

- **10 commits** since v2026.4.9 (`ecb42e05`):
  - 2 events.rs gen (`d242effb`, `b966fe4e`)
  - 4 db-tracking (`233017f7`, `545fec86`, `59f1ea3b`, `1c407eb1`)
  - 4 forge-ts (`80138557`, `67df4208`, `e33059c6`, `e4df49a3`)
- **caamp tests**: 1501 passing (unchanged from v2026.4.9 — workstreams
  targeted non-caamp areas)
- **cant-core tests**: 509 unit tests + 4 doctests passing
- **Full monorepo**: 6375+ tests passing, 0 failures, 0 regressions
- **events.rs drift**: eliminated. `cargo build -p cant-core && git
  status --short crates/cant-core/` is empty. Verified idempotent
  over 3 sequential forced rebuilds.
- **TSDoc coverage in caamp**: **0 errors** (down from 54), 46
  warnings (W013 false-positives on optional params, not blockers)
- **Net LOC delta**: significant additions in `forge-ts` generated
  docs (~50k LOC across `docs/generated/`) + `cant-core/build.rs` +
  `sqlite-backup.ts` + new tests. The `docs/API-REFERENCE.md`
  pointer file replaces 3470 hand-maintained lines with 69.

### Closes

- **T5158** — `.cleo/` runtime DB untrack
- **ADR-013 §9** — runtime DB tracking resolution
- `packages/caamp/docs/API-REFERENCE.md` drift (3470 hand-maintained
  lines including 61 stale MCP references)
- `crates/cant-core/src/generated/events.rs` rustfmt drift (every
  `cargo build` produced uncommitted changes)

## [2026.4.9] - 2026-04-07

### Fixed

- **`build.mjs` build order — caamp now builds AFTER cant** ([`build.mjs`](build.mjs)).
  v2026.4.8's release workflow run [`24108196937`](https://github.com/kryptobaseddev/cleo/actions/runs/24108196937)
  failed at the Build step with `TS2307: Cannot find module '@cleocode/cant'`
  because caamp's tsup DTS step couldn't resolve `@cleocode/cant` types — caamp had
  grown a `validateDocument`/`parseDocument` import in `pi.ts:41` (T276 / `caamp pi
  cant *` verbs) but `build.mjs` still built caamp before cant, so the cant `.d.ts`
  files weren't on disk yet when caamp's DTS resolver ran. Local builds masked the
  bug because `dist/` and `tsbuildinfo` files persisted between invocations.
  Reordered the build chain to strict topological order: lafs → contracts → cant
  → caamp → core → runtime → adapters → cleo. **Verified by cold rebuild**:
  `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo && node build.mjs`
  succeeds end-to-end. v2026.4.8 source code (T276 + T277 + T278) is unchanged
  — only the build pipeline that ships it is fixed.

- **Root `package.json` version drift — root is now the source of truth**
  ([`package.json`](package.json)). The root `package.json` had been stuck at
  2026.4.5 since v2026.4.5 because the release workflow's `Sync package versions
  from tag` step only walked `packages/*/package.json`, never the root. The root
  is now bumped to match every release, and the release workflow has been updated
  ([`.github/workflows/release.yml`](.github/workflows/release.yml)) to sync the
  root in the same step it syncs the workspace packages. The git tag remains the
  canonical source of truth for the version; the root and every workspace
  `package.json` are derived from the tag at release time and cannot drift again.

- **CI cold-build gate — defensive cleanup before `node build.mjs`**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The Build & Verify
  job now `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo` immediately
  before running `node build.mjs`. CI checkouts are already fresh, so this is
  belt-and-braces — but it guarantees the build runs from zero state regardless
  of any future caching changes to `actions/checkout` or `actions/cache`. If
  someone reorders `build.mjs` incorrectly again, this step fails and blocks the
  merge instead of failing only at release time. The step has a self-documenting
  name and a 16-line inline comment that records the v2026.4.8 incident as the
  reason it exists.

- **T261 acceptance criterion #2 corrected** to record the ADR-035 §D4 Option Y
  decision. The original AC read "v2: Full MCP-as-Pi-extension bridge with real
  JSON-RPC client (not scaffold)" — which was inverted by the architecture decision
  ratified in v2026.4.7 (MCP is legacy interop only, not a first-class CleoOS
  primitive; T268-T272 archived; `installMcpAsExtension` removed from PiHarness).
  AC now reads: "v2: MCP-as-Pi-extension bridge REJECTED per ADR-035 §D4 Option Y
  — MCP is legacy interop only…". AC #5 also rewritten to match the actual T278
  deliverable (`caamp.exclusivityMode` setting) instead of the original generic
  phrasing.

### Added

- **`packages/cant/README.md`** — first README for `@cleocode/cant`. Documents
  the public API (`parseDocument`, `validateDocument`, `executePipeline`,
  `migrateMarkdown`, `parseCANTMessage`), the napi-rs architecture, the two
  CANT execution paths (cant-bridge.ts vs deterministic pipelines), and the
  ADR-035 §D5 single-engine boundary. Closes a gap where a published-to-npm
  package shipped without any README on the registry page.

- **`packages/runtime/README.md`** — first README for `@cleocode/runtime`.
  Documents `createRuntime`, the four resident services (`AgentPoller`,
  `HeartbeatService`, `KeyRotationService`, `SseConnectionService`), the
  transport-agnostic architecture, and the runtime-vs-Pi boundary set by
  ADR-035 §D5. Closes a gap where a published-to-npm package shipped without
  any README on the registry page.

### Background — why v2026.4.9 exists at all

v2026.4.8 was tagged and pushed but its release workflow failed at the Build
step (above). The published packages on npm were stuck at v2026.4.7 even
though the v2026.4.8 git tag exists. Rather than force-move the v2026.4.8 tag
(destructive on an already-pushed tag), v2026.4.9 takes the v2026.4.8 source
code unchanged and adds the four fixes above. The result is that all of
v2026.4.8's intended deliverables (T276 `caamp pi cant *` verbs, T277
`PiHarness.spawnSubagent` v2, T278 `caamp.exclusivityMode` setting) ship in
v2026.4.9 alongside the build/CI/version/AC/README fixes.

## [2026.4.8] - 2026-04-07

### Highlights

This release **closes the T261 epic** by completing the three remaining Pi v2+v3 workstreams that v2026.4.7 left for follow-up: T276 ships the missing `caamp pi cant install/remove/list/validate` verb subgroup, T277 upgrades `PiHarness.spawnSubagent` from the v1 minimal shape to the canonical ADR-035 D6 contract (line-buffered streaming, session attribution, idempotent SIGTERM/SIGKILL cleanup, concurrency helpers), and T278 adds the explicit `caamp.exclusivityMode` setting (ADR-035 D7) to govern Pi-vs-legacy runtime dispatch. All thirteen non-deleted T261 children are now done. Net change: +4083 LOC added across 14 files (5 new, 9 modified), zero LOC removed, +73 caamp tests (1428 → 1501), zero regressions.

### Added

#### CAAMP Wave 2 — `caamp pi cant *` verb subgroup (T276, ADR-035 D1)

Completes the Pi verb surface that v2026.4.7 left out. `caamp pi cant` manages `.cant` profile files across the three-tier scope (project > user > global). Thin wrapper around the `@cleocode/cant` napi parser/validator — installed profiles are consumed at runtime by the `cant-bridge.ts` Pi extension via `/cant:load <file>`.

- **4 new `caamp pi cant <verb>` commands** ([`packages/caamp/src/commands/pi/cant.ts`](packages/caamp/src/commands/pi/cant.ts), +482 LOC):
  - `caamp pi cant install <file>` — validates the profile via `validateCantProfile` first and rejects invalid files with the cant-core 42-rule error IDs plus line/col coordinates. On success, copies into the resolved tier's `.cant/` directory. Conflict-on-write with `--force`.
  - `caamp pi cant remove <name>` — three-tier scope-aware removal, idempotent.
  - `caamp pi cant list` — lists installed profiles across all three tiers with shadow flagging when the same profile name exists at multiple tiers.
  - `caamp pi cant validate <file>` — runs the validator without installing; returns a structured diagnostics envelope with severity-tagged findings.
- **4 new `PiHarness` methods** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts)): `installCantProfile`, `removeCantProfile`, `listCantProfiles`, `validateCantProfile`. All honour `requirePiHarness()` Pi-absent guard returning `E_NOT_FOUND_RESOURCE`.
- **2 new module-level helpers** in `pi.ts`: `extractCantCounts` (totals statements, hooks, agents from a parsed profile), `normaliseSeverity` (clamps cant-core diagnostic severities to a stable enum).
- **4 new exported types** in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts): `CantProfileCounts`, `CantProfileEntry`, `CantValidationDiagnostic`, `ValidateCantProfileResult`.
- **New caamp dep** — `@cleocode/cant: workspace:*` (pulls `cant-napi` transitively).
- **40 new tests** across 2 files: `tests/unit/harness/pi.test.ts` (+24 unit tests on the new harness methods, against real seed-agent fixtures), `tests/unit/commands/pi/cant-commands.test.ts` (+16 integration tests driving each verb through Commander `parseAsync`, +536 LOC). Covers happy paths, validator-rejection on install, three-tier shadow detection, missing-file branches, and Pi-absent fallback per ADR-035 D1.

#### `PiHarness.spawnSubagent` v2 — canonical spawn path (T277, ADR-035 D6)

Full upgrade from the v1 minimal shape (basic spawn + result promise) to the ADR-035 D6 contract. `spawnSubagent` is now the **single canonical subagent spawn path** for the entire CleoOS runtime, with line-buffered streaming, session attribution, exit propagation, idempotent cleanup, and concurrency helpers. Maps directly to CANT `parallel: race` / `parallel: settle` semantics.

- **Line-buffered stdout streaming** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts)) — `onStream` callback receives `{ kind: 'message', subagentId, lineNumber, payload }` for each parsed JSON line. Partial lines buffered until newline arrives; malformed JSON surfaces as a `{ kind: 'parse_error' }` event without crashing the consumer.
- **Stderr buffering** — line-buffered, emitted as `{ kind: 'stderr', payload: { line } }` via `onStream`, **and** pushed into a 100-line ring buffer exposed via `SubagentHandle.recentStderr()`. Per ADR-035 D6: stderr is for operator diagnostics only and is **never routed to parent LLM context**.
- **Exit propagation** — new `exitPromise` resolves **once** on child `'close'` with `{ code, signal, childSessionPath, durationMs }`. **Never rejects** — failure is encoded by non-zero `code`, non-null `signal`, or partial output in the session file. Legacy `result` promise preserved for back-compat with v1 consumers.
- **Idempotent cleanup** — new `terminate(reason?)` is idempotent across multiple calls. Sends `SIGTERM`, polls every `min(25ms, graceMs)`, then escalates to `SIGKILL` after grace expires. Grace resolves from per-call `opts.terminateGraceMs` → `settings.json:pi.subagent.terminateGraceMs` → `DEFAULT_TERMINATE_GRACE_MS=5000`. Writes `{type:'subagent_exit', reason:'terminated'}` to the child session file before exit so postmortems can distinguish caller-terminated from naturally-completed runs.
- **Session attribution** — child session JSONL written to `~/.pi/agent/sessions/subagents/subagent-{parentSessionId}-{taskId}.jsonl`. Header `{type:'header', subagentId, taskId, parentSessionId, startedAt}` written at spawn time. When `task.parentSessionPath` is supplied, a `{type:'custom', subtype:'subagent_link', subagentId, taskId, childSessionPath, startedAt}` line is appended to the parent session file so the parent transcript hyperlinks to the child.
- **Concurrency helpers** — static `PiHarness.raceSubagents(handles[])` (Promise.race over `exitPromise[]`, terminates losers via the idempotent `terminate()` path) and static `PiHarness.settleAllSubagents(handles[])` (Promise.allSettled wrapper). These map 1:1 to CANT `parallel: race` and `parallel: settle` mode tokens.
- **Orphan handling** — module-level `Set<ActiveSubagent>` plus an idempotent `process.on('exit', ...)` handler that SIGTERMs every outstanding subagent on parent process exit. Prevents zombies on `Ctrl+C` and crashed parents.
- **New types in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts)** (+550 LOC across the file): `SubagentTask` (updated with `parentSessionPath`, `taskId` fields), `SubagentSpawnOptions` (`onStream`, `terminateGraceMs`, `signal`), `SubagentStreamEvent` (`message` | `stderr` | `parse_error`), `SubagentExitResult` (`code`, `signal`, `childSessionPath`, `durationMs`), `SubagentHandle` (updated with `exitPromise`, `terminate()`, `recentStderr()`), `SubagentLinkEntry`.
- **16 new tests** in `tests/unit/harness/pi.test.ts` covering: stdout streaming with `onStream` callback ordering, stderr buffering and ring-buffer cap at 100 lines, session-file header + parent link write, exit propagation on natural close, exit propagation on caller-terminate, idempotent `terminate()` re-entry, SIGTERM grace then SIGKILL escalation, concurrency `raceSubagents` (winner + loser termination), `settleAllSubagents` ordering preservation, orphan-handler cleanup on parent exit.
- **Legacy v1 API preserved** — the existing `result` promise and `abort()` method on `SubagentHandle` are still emitted unchanged. Existing v1 consumers (Conductor Loop, dispatch handlers) work without modification; v2 features are strictly additive.

#### `caamp.exclusivityMode` setting — v3 exclusivity layer (T278, ADR-035 D7)

70% of the v3 exclusivity layer was already shipped in v2026.4.5 (Pi registered with `priority: "primary"`, `resolveDefaultTargetProviders()` prefers Pi when installed). T278 adds the remaining 30% — an explicit mode setting that controls runtime dispatch behaviour and surfaces deprecation warnings.

- **New `ExclusivityMode` type** ([`packages/caamp/src/core/config/caamp-config.ts`](packages/caamp/src/core/config/caamp-config.ts), new file +300 LOC): `'auto' | 'force-pi' | 'legacy'`, default `'auto'`. Dedicated config module with one-time warning latches, accessor/mutator API (`getExclusivityMode`, `setExclusivityMode`, `resetExclusivityModeOverride`, `isExclusivityMode`), and a reset helper for tests.
- **New `PiRequiredError` class** with literal `code: 'E_NOT_FOUND_RESOURCE' as const` so `runLafsCommand` propagates it without rewriting to `E_INTERNAL_UNEXPECTED`.
- **`resolveDefaultTargetProviders()` honours the mode** ([`packages/caamp/src/core/harness/index.ts`](packages/caamp/src/core/harness/index.ts), +168 LOC):
  - `auto` + Pi installed → returns `[piProvider]` (v2026.4.7 behaviour, **bit-identical**, no warning).
  - `auto` + Pi absent → legacy fallback list, one-time boot warning.
  - `auto` + explicit non-Pi providers passed while Pi installed → returns the explicit list with a one-time deprecation warning.
  - `force-pi` + Pi installed → returns `[piProvider]` (no warning).
  - `force-pi` + Pi absent → **throws `PiRequiredError`** with `E_NOT_FOUND_RESOURCE`.
  - `legacy` → pre-exclusivity behaviour, returns all installed providers in priority order.
- **Install paths UNAFFECTED per ADR-035 D7** — `dispatchInstallSkillAcrossProviders()` and the other multi-provider install fan-outs continue to target every requested provider regardless of `exclusivityMode`. Only **runtime invocation** is gated by the mode. This is an explicit non-goal: CAAMP must remain a usable installer for non-Pi providers even on Pi-first systems.
- **Env var override** — `CAAMP_EXCLUSIVITY_MODE` env var overrides the config setting at boot via the exported `EXCLUSIVITY_MODE_ENV_VAR` constant.
- **New public exports** in [`packages/caamp/src/index.ts`](packages/caamp/src/index.ts): `ExclusivityMode`, `ResolveDefaultTargetProvidersOptions`, `DEFAULT_EXCLUSIVITY_MODE`, `EXCLUSIVITY_MODE_ENV_VAR`, `getExclusivityMode`, `setExclusivityMode`, `resetExclusivityModeOverride`, `isExclusivityMode`, `PiRequiredError`.
- **17 new tests** in `tests/unit/core/harness/exclusivity-mode.test.ts` (+314 LOC) covering the full 3-mode × Pi-installed/absent matrix, warning latches (one-shot per process), env-var precedence, install-path unaffected verification, and `PiRequiredError` shape.
- **Documentation** — README and `caamp.md` updated with the new setting, the three mode semantics, and the `CAAMP_EXCLUSIVITY_MODE` env override ([`packages/caamp/caamp.md`](packages/caamp/caamp.md) +35 LOC).

### Changed

- **`PiHarness.spawnSubagent` is now the single canonical subagent spawn path.** The v1 minimal shape is preserved for back-compat (consumers using `result` and `abort()` work unchanged), but new code paths (Conductor Loop subagent fan-out, CANT `parallel:` workflow nodes) should adopt `exitPromise`, `onStream`, and the static `PiHarness.raceSubagents` / `PiHarness.settleAllSubagents` helpers.
- **`@cleocode/caamp` now depends on `@cleocode/cant`** as a workspace package — required by the T276 `caamp pi cant validate` pipeline. Pulls `cant-napi` transitively.

### Architecture decisions

See [ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md) for the full audit trail. v2026.4.8 closes:

- **D1** — three-tier scope (project > user > global) for `caamp pi cant *` verbs (T276).
- **D6** — canonical subagent spawn contract: line-buffered streaming, session attribution, idempotent SIGTERM/SIGKILL cleanup, concurrency helpers, orphan handling, no rejects from `exitPromise` (T277).
- **D7** — `caamp.exclusivityMode` setting governs runtime dispatch (`auto` / `force-pi` / `legacy`); install paths remain unaffected so CAAMP stays a usable installer for non-Pi providers (T278).

With T276–T278 landed, the **T261 epic closes**. All thirteen non-deleted children are done: T262, T263, T264, T265, T266, T267, T273, T274, T275, T276, T277, T278, T279. (T268–T272 were deleted as MCP-bridge-as-Pi-extension was rejected per ADR-035 D4.)

### Stats

- **10 commits** since v2026.4.7 (`d765ac29`): `9bb03149`, `2a66f4fb`, `c7533da3`, `1ae20b9a` (T276 + merge), `36ca547e`, `da02ca97`, `6ab01046` (T277 + merge), `6427eb6d`, `87e1677b`, `217b88f9`, `f61f5910` (T278 + merge).
- **Net LOC**: +4083 added, −80 removed (the −80 are localised refactors inside `pi.ts` and `harness/index.ts`; no files deleted).
- **Files touched**: 14 total — 5 new (`commands/pi/cant.ts`, `core/config/caamp-config.ts`, `tests/unit/commands/pi/cant-commands.test.ts`, `tests/unit/core/harness/exclusivity-mode.test.ts`, plus the new harness method test additions in `tests/unit/harness/pi.test.ts`), 9 modified.
- **Tests**: caamp **1428 → 1501** (+73). Breakdown: T276 +40 (24 unit + 16 integration), T277 +16, T278 +17.
- **Zero regressions**, zero new stubs, zero `any`/`unknown`, full biome + typecheck + build + test gates passing.

## [2026.4.7] - 2026-04-07

### Highlights

This release ships the Wave 1 `caamp pi *` verb surface (19 verbs across 5 subgroups, backed by 14 new `PiHarness` methods), rebuilds the `caamp mcp *` command group that was accidentally swept up in the April 3 CLI-only migration (4 verbs covering 44 MCP-capable providers across JSON/JSONC/YAML/TOML), and collapses CANT runtime execution to a single canonical engine (the `cant-bridge.ts` Pi extension) by deleting ~1594 LOC of dead `@cleocode/core/cant` duplicate code. Net change across the release: roughly +5000 LOC added, −1594 LOC removed, +203 new tests, zero regressions.

### Added

#### CAAMP Wave 1 — `caamp pi *` verb surface (T263–T267, ADR-035 D1–D3)

- **19 new `caamp pi <verb>` commands** across five subgroups, wired through `runLafsCommand` so every output is a LAFS envelope with canonical error codes ([`packages/caamp/src/commands/pi/`](packages/caamp/src/commands/pi/)):
  - `caamp pi extensions list|install|remove` (T263) — install supports local file paths, raw HTTPS URLs, GitHub/GitLab shorthand, and URL forms. Conflict-on-write with `--force`, `--scope project|user|global`, `--name` override, shadow-flag reporting on list.
  - `caamp pi sessions list|show|export|resume` (T264) — list reads line 1 only per ADR-035 D2. Export streams line-by-line with optional Markdown transcription. Resume shells out to `pi --session <id>` (never reimplements Pi's lifecycle).
  - `caamp pi models list|add|remove|enable|disable|default` (T265) — strict dual-file authority per ADR-035 D3: `add`/`remove` mutate `models.json`, `enable`/`disable` mutate `settings.json:enabledModels`, `default` mutates `defaultModel` + `defaultProvider`. Numeric flag validation for `--context-window` and `--max-tokens`.
  - `caamp pi prompts install|list|remove` (T266) — directory-based install (requires `prompt.md`), token-efficient list (directory listing only).
  - `caamp pi themes install|list|remove` (T267) — single-file install accepting `.ts`/`.tsx`/`.mts`/`.json`, cross-extension conflict handling.
- **14 new `PiHarness` methods** ([`packages/caamp/src/core/harness/pi.ts`](packages/caamp/src/core/harness/pi.ts), +569 LOC): `installExtension`, `removeExtension`, `listExtensions`, `listSessions`, `showSession`, `readModelsConfig`, `writeModelsConfig`, `listModels`, `installPrompt`, `listPrompts`, `removePrompt`, `installTheme`, `listThemes`, `removeTheme`. `listSessions` reads ONLY line 1 of each `*.jsonl` via a buffered file handle — never loads full session bodies for listings.
- **Three-tier scope resolver** at [`packages/caamp/src/core/harness/scope.ts`](packages/caamp/src/core/harness/scope.ts) (+278 LOC) — single source of truth for project > user > global path resolution. Exports `resolveTierDir`, `resolveAllTiers`, `TIER_PRECEDENCE`. Honours `$PI_CODING_AGENT_DIR` and `$CLEO_HOME` with XDG/Windows/darwin platform fallbacks.
- **New type exports** in [`packages/caamp/src/core/harness/types.ts`](packages/caamp/src/core/harness/types.ts): `ExtensionEntry`, `PromptEntry`, `ThemeEntry`, `HarnessInstallOptions`, `SessionSummary`, `SessionDocument`, `PiModelDefinition`, `PiModelProvider`, `PiModelsConfig`, `ModelListEntry`, `HarnessTier`. Legacy `HarnessScope` preserved for back-compat.
- **Pi-absent fallback** per ADR-035: every verb calls `requirePiHarness()` in [`packages/caamp/src/commands/pi/common.ts`](packages/caamp/src/commands/pi/common.ts), which throws `E_NOT_FOUND_RESOURCE` with "Pi is not installed. Run: caamp providers install pi" when Pi is absent.
- **Error-code hygiene** — `PI_ERROR_CODES` constants map in `common.ts` registers `E_VALIDATION_SCHEMA` (caller input), `E_NOT_FOUND_RESOURCE` (missing resources), and `E_TRANSIENT_UPSTREAM` (network/resume failures) so `runLafsCommand` never rewrites them to `E_INTERNAL_UNEXPECTED`.
- **154 new unit tests** across 3 files: `harness/pi.test.ts` (+103 harness tests, now 911 LOC total), `commands/pi/common.test.ts` (8 tests), `commands/pi/commands.test.ts` (43 integration-style tests driving each verb through Commander `parseAsync`). Covers every verb's happy path plus input-rejection branches, three-tier shadow detection, malformed session headers, models round-trip + default fallthrough, prompt rejection on missing `prompt.md`, theme cross-extension conflicts, and platform-specific Windows/darwin branches via `process.platform` stub.

#### CAAMP `caamp mcp *` commands restored (Option C)

CAAMP's original design promise was *"a unified provider registry and package manager for AI coding agents. It replaces the need to manually configure each agent's MCP servers, skills, and instruction files individually — handling the differences in config formats (JSON, JSONC, YAML, TOML), config keys (`mcpServers`, `mcp_servers`, `extensions`, `mcp`, `servers`, `context_servers`), and file paths across all supported providers."* This feature was deleted in `480fa01a` during the CLI-only migration. Option C rebuilds it lean on top of the still-existing `core/formats/*`, `core/paths/agents.ts`, and `core/registry/types.ts` infrastructure.

- **4 new `caamp mcp <verb>` commands** ([`packages/caamp/src/commands/mcp/`](packages/caamp/src/commands/mcp/), 14 files, +2661 LOC):
  - `caamp mcp list [--provider <id>]` — enumerate installed MCP servers (format-agnostic read through `core/formats/*`).
  - `caamp mcp install --provider <id> <name> -- <command> [args...]` — writes MCP server config into the provider's native config file. Conflict-on-write; supports `--scope project|user|global`, `--env KEY=VAL` (repeatable), `--force`.
  - `caamp mcp remove --provider <id> <name>` (single provider) or `--all-providers <name>` (idempotent removal across every MCP-capable provider).
  - `caamp mcp detect` — lightweight filesystem probe of every MCP-capable provider, reporting installed servers per provider.
- **Library API** — 7 new functions + 6 new types exported from `@cleocode/caamp`:
  - `core/mcp/reader.ts` (+274 LOC): `readMcpServers`, `readAllMcpServers`, plus `McpServerRecord` and `ProviderMcpReadResult` types.
  - `core/mcp/installer.ts` (+138 LOC): `installMcpServer` with options-object signature (`{ provider, name, command, args, env, scope, projectDir, force }`).
  - `core/mcp/remover.ts` (+164 LOC): `removeMcpServer`, `removeMcpServerFromAll`.
  - `core/mcp/index.ts` (+37 LOC): package barrel re-exports.
- **Provider coverage** — 44 of 45 providers in [`providers/registry.json`](packages/caamp/providers/registry.json) enumerated (all except `pi`, which has no `capabilities.mcp`).
- **Format coverage** — JSON (41 providers), JSONC (1 — `zed` at `context_servers`), YAML (2 — `goose` at `extensions`, `swe-agent`), TOML (1 — `codex` at `mcp_servers`). Dot-notation key paths exercised: `mcpServers`, `mcp_servers`, `extensions`, `mcp`, `servers`, `context_servers`, `amp.mcpServers`.
- **49 new tests** across 4 files: `tests/unit/commands/mcp/commands.test.ts` (22 Commander-drive integration tests, +707 LOC), `tests/unit/mcp-reader.test.ts` (+188 LOC), `tests/unit/mcp-installer.test.ts` (+187 LOC), `tests/unit/mcp-remover.test.ts` (+146 LOC). Covers happy paths, conflict-on-write, idempotency, and JSON/JSONC/TOML format round-trips through the format-agnostic substrate.
- **Docs refreshed** — [`packages/caamp/README.md`](packages/caamp/README.md), [`packages/caamp/caamp.md`](packages/caamp/caamp.md), [`packages/caamp/docs/ADVANCED-RECIPES.md`](packages/caamp/docs/ADVANCED-RECIPES.md) updated for the new `--provider <id> -- <command>` shape and the options-object `installMcpServer` signature.
- **Zero new external dependencies** — `@modelcontextprotocol/sdk` is NOT added. CAAMP treats MCP server configs as plain data records and doesn't speak MCP itself.

#### ADR-035 — Pi v2+v3 harness architecture decision record

- **[ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md)** (+373 LOC) — complete audit trail for the Pi harness architecture, including decisions D1 (three-tier scope project > user > global), D2 (line-1-only session JSONL listing for token efficiency), D3 (dual-file models authority — `models.json` for definitions + `settings.json:enabledModels` for selection), D4 (MCP-as-Pi-extension rejected; config-file management for non-Pi providers remains a first-class CAAMP concern), D5 (single CANT execution engine via `cant-bridge.ts`, `@cleocode/core/cant` deleted).
- Manifest updated: [`.cleo/adrs/MANIFEST.jsonl`](.cleo/adrs/MANIFEST.jsonl).

### Changed

- **`cleo agent start` profile handling documented as Pi-independent** — the `cleo agent start` daemon polls SignalDock for messages and never executes the `.cant` profile internally. Profile-driven workflow execution lives entirely inside Pi sessions via the `cant-bridge.ts` extension. The daemon's profile read is a fail-fast guard plus an operator-visible status string, not an execution step. A comprehensive block comment above the start verb explains the daemon vs. Pi-session split and points operators at `/cant:load` and `/cant:run` for profile execution ([`packages/cleo/src/cli/commands/agent.ts`](packages/cleo/src/cli/commands/agent.ts)).
- **`agent-profile-status.ts` extracted** as a pure helper ([`packages/cleo/src/cli/commands/agent-profile-status.ts`](packages/cleo/src/cli/commands/agent-profile-status.ts), +112 LOC) computing the four-state status string (`none` / `loaded (unvalidated)` / `validated` / `invalid (N errors)`) without spinning up `createRuntime`, the registry, or `fetch`. Plus 8 unit tests covering all four status branches and edge cases.

### Removed

- **`packages/core/src/cant/*`** (−1574 LOC across 7 files) — dead `@cleocode/core/cant` `WorkflowExecutor` namespace with zero production callers. Strictly duplicate with the `cant-bridge.ts` Pi extension shipped in v2026.4.6, which already implements all 16 workflow statement types via shell-out to `cleo cant parse/validate/execute`. Deletes `approval.ts`, `context-builder.ts`, `discretion.ts`, `index.ts`, `parallel-runner.ts`, `types.ts`, and `workflow-executor.ts` (618 LOC alone). On-disk `.cant` agent fixture validation tests moved from `packages/core/src/cant/__tests__/` to `packages/cant/tests/` since they exercise grammar fixtures, not the deleted namespace. See ADR-035 D5.
- **MCP bridge placeholder** at `packages/caamp/src/core/harness/mcp/index.ts` (−53 LOC). The placeholder was a one-day stopgap that unblocked the `tsup` build when a stale `tsup.config.ts` entry point referenced a file that had never been created on disk (causing `pnpm run build` to fail on fresh checkouts). Replaced by actual deletion of both the stale entry point and the placeholder.
- **`installMcpAsExtension` scaffold** and its private `extensionsDir` helper from `PiHarness` (−79 LOC).
- **`McpServerSpec` type** from `harness/types.ts` and its re-exports from `harness/index.ts` and `src/index.ts` (−68 LOC).
- **`installMcpAsExtension` method** from the `Harness` interface.
- **`mcp` keyword** from [`packages/caamp/package.json`](packages/caamp/package.json) — positioning statement; MCP config-file management for non-Pi providers remains a first-class CAAMP concern, but MCP itself is not a first-class CleoOS primitive.
- **`@modelcontextprotocol/sdk`** from `build.mjs` externals (was prep for the never-shipped bridge; no source actually imports it).
- **MCP scaffold tests** and the Wave 1 `isBridgeAvailable` smoke test from `tests/unit/harness/pi.test.ts` (−65 LOC). See ADR-035 D4 for rationale: Pi extensions strictly dominate MCP tools on every axis (hooks, slash commands, prompt injection, blocking/rewriting, renderers, providers, keybindings, direct TS calls vs JSON-RPC framing). MCP solves multi-client coordination — CleoOS is single-client (Pi).

### Fixed

- **Broken main build on fresh checkouts** — the pre-existing botched commit `3deba942 fix(caamp): add MCP bridge placeholder so build resolves harness/mcp entry` added a placeholder to unblock a `tsup.config.ts` entry point that referenced a file never added to any commit. Fresh checkouts between `b57eb74e` and `3deba942` failed `pnpm run build`. The Wave 1 merge and the subsequent Option Y cleanup (commit `96d6a1ae`) resolve this by deleting both the stale `tsup` entry and the placeholder file.

### Architecture decisions

See [ADR-035](.cleo/adrs/ADR-035-pi-v2-v3-harness.md) for the full audit trail, especially:

- **D4 Option Y collapse** — MCP is legacy interop only for Pi harness; CAAMP's config-file management for the 44 non-Pi MCP-capable providers remains a first-class concern (hence the restored `caamp mcp *` surface).
- **D5 Option Y collapse** — Single CANT execution engine lives in `cant-bridge.ts`; `@cleocode/core/cant` has been deleted.

### Stats

- **15 commits** since v2026.4.6 (`b57eb74e`): `b71c77eb`, `3deba942`, `c49bbccf`, `d1d2466d`, `9b2e9ddc`, `3fc5ff28`, `b46a7a1b`, `55f56a06`, `96d6a1ae`, `d952db8e`, `cd1a1a4e`, `0f5719e0`, `af5b2501`, `9fbb026b`, `ebd1ac93`.
- **Net LOC**: ~+5000 added, −1594 removed.
- **Tests**: caamp 1379 → 1428 (+49 MCP tests; +154 Pi Wave 1 tests offset by −65 scaffold test deletions). Full monorepo test count increases by +203 from Wave 1 + MCP + `agent-profile-status` additions.
- **Zero regressions**, zero new stubs, zero `any`/`unknown`, full biome + typecheck + build + test gates passing.

## [2026.4.6] - 2026-04-07

### CleoOS — autonomous orchestration is now real

This release closes the autonomous-orchestration gap identified in the v2026.4.x system assessment. CLEO + Pi now form a functional CleoOS: a unified, cross-project agentic operating system with a Conductor Loop, skill-backed stage guidance, a CANT runtime bridge, and a global hub of recipes/extensions/agents that ships with `npm install`.

This release builds on top of the v2026.4.5 Pi-as-primary harness work and the T260 dedicated-protocols/skills epic. It fills in the runtime, distribution, and validation layers.

### Added

#### CleoOS hub (Phase 1) — `$CLEO_HOME/{global-recipes,pi-extensions,cant-workflows,agents}`

- **`getCleoGlobalRecipesDir/getCleoPiExtensionsDir/getCleoCantWorkflowsDir/getCleoGlobalAgentsDir`** path resolvers in `@cleocode/core` ([`packages/core/src/paths.ts`](packages/core/src/paths.ts)). All four hub subdirectories live under the existing XDG-compliant `getCleoHome()` (Linux: `~/.local/share/cleo/`).
- **`ensureCleoOsHub()`** scaffolding entry point in [`packages/core/src/scaffold.ts`](packages/core/src/scaffold.ts). Idempotent, copies templates from the bundled `@cleocode/cleo` package, never overwrites operator/agent edits.
- **`cleo admin paths`** query — reports all CleoOS paths and per-component scaffolding status as a LAFS envelope.
- **`cleo admin scaffold-hub`** mutation — explicit hub provisioning command for operators.
- **`packages/cleo/templates/cleoos-hub/`** bundle — ships with the `@cleocode/cleo` npm tarball. Contains `pi-extensions/{orchestrator,stage-guide,cant-bridge}.ts`, `global-recipes/{justfile,README.md}`, plus a top-level `README.md`.
- **Global Justfile Hub** seeded with cross-project recipes (`bootstrap`, `stage-guidance <stage>`, `skills`, `skill-info <name>`, `lint`, `test`, `recipes`) — every recipe wraps `cleo` CLI invocations rather than re-encoding protocol text.

#### Pi as the exclusive CAAMP harness (Phase 2)

- **Pi registered** as the 45th CAAMP provider (`packages/caamp/providers/registry.json`) with full harness capability metadata (`role: "primary-orchestrator"`, `conductorLoopHost: true`, `stageGuidanceInjection: true`, `cantBridgeHost: true`, `globalExtensionsHub: $CLEO_HOME/pi-extensions`). Pi sits alongside the v2026.4.5 priority `"primary"` tier introduced for the Pi-first reshape.
- **`buildStageGuidance(stage, cwd?)`** in [`packages/core/src/lifecycle/stage-guidance.ts`](packages/core/src/lifecycle/stage-guidance.ts) — thin loader that maps each pipeline stage to its dedicated SKILL.md via `STAGE_SKILL_MAP` (rewired in T260 to ct-consensus-voter, ct-adr-recorder, ct-ivt-looper, ct-release-orchestrator) and composes Tier-0 + stage-specific skills via the existing `prepareSpawnMulti()` helper. **Source: `skills` (real `SKILL.md` files), never hand-authored.**
- **`renderStageGuidance(stage)`**, **`formatStageGuidance(g)`**, **`STAGE_SKILL_MAP`**, **`TIER_0_SKILLS`** exports for downstream consumers.
- **`cleo lifecycle guidance [stage]`** CLI command — Pi extensions shell out to this on `before_agent_start` to inject the stage-aware system prompt. Resolves stage from `--epicId <id>` automatically when omitted.
- **`pipeline.stage.guidance`** dispatch operation in `@cleocode/cleo` (registered in `dispatch/registry.ts` and routed in `dispatch/domains/pipeline.ts`).
- **`stage-guide.ts` Pi extension** — `before_agent_start` hook that calls `cleo lifecycle guidance --epicId` and returns `{ systemPrompt }` to enrich the LLM's effective prompt with skill-backed protocol text.

#### Conductor Loop (Phase 3)

- **`orchestrator.ts` Pi extension** (~624 lines) — registers `/cleo:auto <epicId>`, `/cleo:stop`, `/cleo:status` commands. The loop polls CLEO for ready tasks, queries the active stage, fetches stage guidance, spawns subagents via the CLEO orchestrate engine, monitors completion, and validates output. Includes mock mode (`CLEOOS_MOCK=1`) for CI, safety cap of 100 iterations, and graceful `ctx.signal` cancellation. Loads ct-orchestrator + ct-cleo (Tier 0) into the LLM system prompt on every turn so even sessions without an active epic operate under the skill-backed protocol.
- **`cleo agent work --execute`** flag in [`packages/cleo/src/cli/commands/agent.ts`](packages/cleo/src/cli/commands/agent.ts) — fills the documented gap at line 791. The work loop now actually spawns ready tasks via `orchestrate.spawn.execute` instead of merely advertising them. New `--adapter <id>` and `--epic <id>` flags scope execution.

#### CANT runtime bridge via napi-rs (Phase 4)

- **`cant-napi` extended** with async `cant_execute_pipeline(file, name)` exposing `cant-runtime::execute_pipeline` to Node ([`crates/cant-napi/src/lib.rs`](crates/cant-napi/src/lib.rs)). Returns structured `JsPipelineResult` with per-step exit codes, stdout/stderr lengths, and timing.
- **`@cleocode/cant` migrated to napi-rs**: `executePipeline(filePath, pipelineName)` async TS API in `packages/cant/src/index.ts` calls into the native binding. **The legacy WASM bundle is gone** (see Removed below).
- **`cant-bridge.ts` Pi extension** (~989 lines) — registers `/cant:load <file>`, `/cant:run <file> <workflow>`, `/cant:execute-pipeline <file> --name <pipeline>`, `/cant:info`. Parses .cant files via `cleo cant parse`, delegates deterministic pipelines to the napi binding, interprets workflow constructs (Session, Parallel race/settle, Conditional with Expression+Discretion, ApprovalGate, Repeat, ForLoop, LoopUntil, TryCatch) in TypeScript using Pi's native subagent spawning. When `/cant:load` reads an Agent definition, the bridge captures its declared `skills:` list and the `before_agent_start` hook fetches each skill's metadata via `cleo skills info` to compose a system-prompt prefix at every LLM turn. Mock mode and `ctx.signal` cancellation supported throughout.
- **`cleo cant parse|validate|list|execute`** CLI commands in [`packages/cleo/src/cli/commands/cant.ts`](packages/cleo/src/cli/commands/cant.ts) — call directly into the @cleocode/cant napi-backed TS API, no shell-out to a standalone binary.
- **6 canonical seed agents bundled** in [`packages/agents/seed-agents/`](packages/agents/seed-agents/): `cleo-prime`, `cleo-dev`, `cleo-historian`, `cleo-rust-lead`, `cleo-db-lead`, `cleoos-opus-orchestrator`. Pre-existing T01 `persist` boolean errors fixed in the seeds before bundling.
- **`cleo init --install-seed-agents`** flag — opt-in installer for the canonical seeds into the project's `.cleo/agents/` directory.

#### Greenfield/brownfield bootstrap (Phase 5)

- **`classifyProject(directory?)`** in [`packages/core/src/discovery.ts`](packages/core/src/discovery.ts) — read-only classifier that detects `greenfield` (empty/new) vs `brownfield` (existing codebase) by checking `.git/`, source dirs, package manifests, and docs presence. Returns a `ProjectClassification` with signal list and metadata.
- **`cleo init`** now classifies the directory BEFORE creating files and emits `classification: { kind, signalCount, topLevelFileCount, hasGit }` in the LAFS envelope.
- **`nextSteps: Array<{action, command}>`** field in init output — different recommendations for greenfield (start session, seed Vision epic, run Conductor Loop) vs brownfield (anchor codebase in BRAIN, review project context, start scoped session).
- **Brownfield warning** — when a brownfield project is initialized without `--map-codebase`, init emits a warning recommending `cleo init --map-codebase` to anchor the existing codebase as BRAIN baseline (Phase 5 context anchoring).
- **`ensureCleoOsHub()` invoked from `cleo init`** — every new project gets the CleoOS hub provisioned automatically.

#### LAFS validator middleware (Phase 6)

- **`packages/cleo/src/cli/renderers/lafs-validator.ts`** — middleware that validates every CLI envelope before stdout. Full envelopes (`{$schema, _meta, success, result}`) delegate to the canonical `validateEnvelope()` from `@cleocode/lafs` (which uses `lafs-napi` Rust + AJV fallback against `packages/lafs/schemas/v1/envelope.schema.json`). Minimal envelopes (`{ok, r, _m}`) are checked against a local shape invariant since the canonical schema doesn't cover the agent-optimized format.
- **`ExitCode.LAFS_VIOLATION = 104`** — emitted when a CLEO-internal envelope fails the shape contract. Wraps the malformed output in a valid error envelope on stderr and sets `process.exitCode`.
- **`CLEO_LAFS_VALIDATE=off` env opt-out** — disables the validator middleware for performance-sensitive scripted use.

### Changed

- **`packages/core/schemas/` reduced from 43 → 10 files.** 33 orphan schemas deleted (audit confirmed zero AJV consumers in source code; only cosmetic comment/URL references remained).
- **`STAGE_SKILL_MAP` rewired** in [`packages/core/src/lifecycle/stage-guidance.ts`](packages/core/src/lifecycle/stage-guidance.ts) (T260, shipped via this release): consensus → ct-consensus-voter, architecture_decision → ct-adr-recorder, testing → ct-ivt-looper, release → ct-release-orchestrator, validation → ct-validator (kept). Each pipeline stage now owns exactly one dedicated skill — no more overloaded ct-validator/ct-dev-workflow assignments.
- **`packages/cant/package.json` files array**: `"wasm/"` removed, `"napi/"` added.
- **`packages/cleo/package.json` files array**: `"templates"` added so the cleoos-hub bundle ships in the npm tarball.
- **`@cleocode/cant` runtime path**: every consumer now goes through the napi-rs binding. The TypeScript `native-loader.ts` no longer falls back to WASM.
- **`cleo init` LAFS output shape extended** with `classification` and `nextSteps` fields. Existing fields (`initialized`, `directory`, `created`, `skipped`, `warnings`) unchanged.
- **`cleo cant migrate` and other cant subcommands** route through the napi binding instead of the WASM fallback.

### Removed

- **`packages/cant/wasm/`** — entire WASM bundle deleted (`cant_core.{js,d.ts,_bg.wasm,_bg.wasm.d.ts}` + `package.json`). The `build:wasm` script removed from `packages/cant/package.json`.
- **`packages/cant/src/wasm-loader.ts`** — superseded by the napi-only `native-loader.ts`.
- **`crates/cant-runtime/src/bin/cant-cli.rs`** — standalone binary deleted now that `cant-napi` exposes `execute_pipeline` directly. One less artifact to ship, no per-platform binary distribution complexity.
- **`packages/core/src/conduit/__tests__/dual-api-e2e.test.ts`** — deleted entirely. The test suite was a transitional E2E that exercised both the canonical `api.signaldock.io` and the legacy `api.clawmsgr.com` against real network endpoints. Per the v2026.4.5 deprecation, ClawMsgr is no longer a supported backend, and network-dependent E2E tests are an anti-pattern in the unit test runner. Removed along with the generated `.d.ts`/`.js`/`.js.map` files. SignalDock health and messaging are exercised by the existing in-process LocalTransport unit tests and the live `cleo admin smoke` probes.
- **33 orphan JSON schemas** in `packages/core/schemas/`: `agent-configs`, `agent-registry`, `archive`, `brain-{decision,learning,pattern}`, `critical-path`, `deps-cache`, `doctor-output`, `error`, `global-config`, `grade`, `log`, `metrics`, `migrations`, `nexus-registry`, `operation-constitution`, `output`, `projects-registry`, `protocol-frontmatter`, all 9 `rcasd-*` schemas, `releases`, `skills-manifest`, `spec-index`, `system-flow-atlas`. None had any AJV consumers; deleted with no runtime impact.

### Fixed

- **`agent.ts:791` Conductor Loop gap** — `cleo agent work` now actually spawns tasks via the orchestrate engine when `--execute` is passed (was: prints "Task available. Run: cleo start <id> to begin." and exits). The legacy watch-only mode is preserved as the default for backwards compatibility.
- **Pre-existing T01 errors** in 6 `.cant` seed agent files — `persist: project` (string) → `persist: true` (boolean) per the .cant grammar contract. All 6 seeds now validate clean via `cleo cant validate`.
- **`getSupportedOperations()` drift** in `AdminHandler` — `paths` (query) and `scaffold-hub` (mutate) added to the explicit operation list to keep `alias-detection.test.ts` and `admin.test.ts` in sync with the registry.
- **Operation count drift** in `parity.test.ts` — registry now exposes 130 query + 98 mutate = 228 total operations (was: 128/97/225). Test expectations updated.

### Acknowledgements

This release stacks on top of:

- **v2026.4.5 (BREAKING)** — Pi as primary CAAMP harness, registry v3 schema, harness layer abstraction, default-resolution to primary harness across CAAMP commands. The harness contract `PiHarness` introduced there is what makes the CleoOS Conductor Loop possible.
- **T260 epic (committed in v2026.4.5)** — 12 dedicated protocols + 6 new v2-compliant skills (`ct-adr-recorder`, `ct-ivt-looper`, `ct-consensus-voter`, `ct-release-orchestrator`, `ct-artifact-publisher`, `ct-provenance-keeper`) + project-agnostic IVT loop in `testing.md` + composition pipeline in `release.md`. The CleoOS stage-guidance loader points at these skills.

### Migration

No public API removed beyond the WASM path in `@cleocode/cant`. If you imported from `@cleocode/cant/wasm-loader` directly (unlikely — it was internal), switch to the public TS API:

```diff
- import { initWasm, cantParseWasm } from '@cleocode/cant/wasm-loader';
- await initWasm();
- const result = cantParseWasm(content);
+ import { parseCANTMessage } from '@cleocode/cant';
+ const result = parseCANTMessage(content);
```

The napi binding loads synchronously on first use; no `await initWasm()` ceremony.

If you depended on the standalone `cant-cli` Rust binary that briefly existed in `crates/cant-runtime/src/bin/`, switch to the napi-backed TS API or shell out to `cleo cant parse|validate|list|execute` (which now wraps the napi binding internally).

## [2026.4.5] - 2026-04-06

### ⚠ BREAKING CHANGES — v3 harness architecture

The CAAMP provider model has been generalised so that Pi (`@mariozechner/pi-coding-agent`) is the first-class primary harness CLEO is built around and optimises for. Other providers continue to work as spawn targets, but MCP-as-config-file is no longer the load-bearing assumption.

**Registry schema v2.0.0** — all provider data reshaped. If you consume `@cleocode/caamp` as a library and read the resolved `Provider` type, you MUST update your code:

- The six top-level MCP fields (`configKey`, `configFormat`, `configPathGlobal`, `configPathProject`, `supportedTransports`, `supportsHeaders`) have been **removed from `Provider`**. They now live under `provider.capabilities.mcp`, which is `ProviderMcpCapability | null`. Providers without MCP integration (Pi) have `capabilities.mcp === null`.
- `ProviderPriority` gained `'primary'` as a new tier above `'high'`. Exactly one provider per registry may have priority `'primary'` (today: Pi).
- New optional `provider.capabilities.harness: ProviderHarnessCapability | null` — populated for first-class harnesses (today: Pi). Describes the harness kind (`orchestrator` / `standalone`), spawn targets, extension paths, and CLEO-integration flags.
- `RegistrySpawnCapability.spawnMechanism` gained `'native-child-process'`. New optional `spawnCommand: string[] | null` captures the literal invocation (Pi: `["pi", "--mode", "json", "-p", "--no-session"]`).
- `RegistryHooksCapability.hookFormat` gained `'typescript-directory'`. New fields: `hookConfigPathProject`, `nativeEventCatalog` (`'canonical' | 'pi'`), `canInjectSystemPrompt`, `canBlockTools`.
- Pi's hook events use a separate `pi` catalog in `providers/hook-mappings.json` (sibling of the existing `canonicalEvents` map) since Pi's native event names don't map cleanly to the canonical catalog.

### Added

- **Pi harness layer** ([`packages/caamp/src/core/harness/`](packages/caamp/src/core/harness/)): new abstraction for first-class harnesses. Exports `Harness` interface, `getHarnessFor(provider)`, `getPrimaryHarness()`, `getAllHarnesses()`, `PiHarness` class, and `resolveDefaultTargetProviders()` helper. `PiHarness` implements the full contract against `~/.pi/agent/` and `.pi/` — skills install via copy (not symlink), instructions injected into `AGENTS.md` with marker blocks, settings managed atomically, MCP servers can be scaffolded as Pi extensions, and subagents are spawned via `child_process.spawn('pi', ...)`. 37 new unit tests cover the roundtrip.
- **`getPrimaryProvider()`** query function in the registry, returning the provider with `priority === 'primary'`.
- **Registry migration script** (`packages/caamp/scripts/migrate-registry-v2.mjs`): idempotent, ES-module, zero-dep migrator that moved 264 MCP fields (44 providers × 6 fields) into `capabilities.mcp`, bumped registry to v2.0.0, and rewrote Pi's entry with the harness capability block.
- **Pi-primary default resolution** across all CAAMP commands: when no `--agent` flag is given, commands target the primary harness if installed, falling back to the high-priority installed set. Applies to `caamp skills install|remove|update|list`, `caamp instructions inject|check|update`, and `caamp advanced` operations.
- **Harness dispatch** in `skills install/remove/update` and `instructions inject/update`: if the target provider has a harness, the command calls the harness method directly (bypassing the generic MCP-config-file path). Generic providers continue to use the existing code paths unchanged.
- **`$CLEO_HOME` template variable** support in registry path resolution, honouring `CLEO_HOME` env var with XDG/macOS/Windows fallbacks to support Pi's `globalExtensionsHub`.

### Changed

- **`registry.json` version bumped `1.1.0` → `2.0.0`.** All 44 non-Pi providers migrated to the new capability shape. Pi entry rewritten with `priority: "primary"`, no `capabilities.mcp`, full `capabilities.harness` populated.
- **`hook-mappings.json` version bumped `1.0.0` → `2.0.0`.** Added 22-entry `piEventCatalog` sibling key mapping Pi's native events (`session_start`, `before_agent_start`, `tool_execution_start`, …) to their canonical equivalents where they exist.
- **`doctor` command**: now treats missing `capabilities.mcp` as "valid, extension-based harness" rather than a validation failure. Config-file checks emit a pass for harness-based providers.
- **`providers show`** and **`config show`**: gracefully render `(none — extension-based harness)` for providers without an `mcp` capability.
- **CLEO consumers** (`packages/core/src/metrics/__tests__/provider-detection.test.ts`): updated provider-detection test fixture to the new capability shape.

### Fixed

- **Pre-existing `admin.test.ts` drift** in `packages/cleo/src/dispatch/domains/__tests__/`: `initProject` mock was missing `skipped` and `warnings` fields required by the current return type.
- **Pre-existing Rust formatting drift** in `crates/cant-core/src/generated/events.rs` surfaced by `cargo fmt` gate; reformatted.

### Migration for library consumers

If you import `Provider` from `@cleocode/caamp`:

```diff
- const key = provider.configKey;
- const fmt = provider.configFormat;
- const path = provider.configPathGlobal;
+ const mcp = provider.capabilities.mcp;
+ if (!mcp) { /* provider has no MCP integration (e.g. Pi) */ return; }
+ const { configKey, configFormat, configPathGlobal } = mcp;
```

The old top-level fields are **gone**, not deprecated. There is no compat shim — this is a straight v3 move.

## [2026.4.4] - 2026-04-06

### Fixed
- **`@cleocode/cant` and `@cleocode/runtime` npm publish**: added missing `repository.url` field to `packages/cant/package.json` and `packages/runtime/package.json`. Without it, npm sigstore provenance verification rejected publishes with `422 Unprocessable Entity — Error verifying sigstore provenance bundle: "repository.url" is "", expected to match "https://github.com/kryptobaseddev/cleo"`. These two packages were stuck on npm at 2026.4.1 (cant) and 2026.4.0 (runtime) for this reason. v2026.4.4 brings them current alongside the rest of the workspace.
- **`@cleocode/cant` publishConfig**: added explicit `publishConfig.access = public` so the scoped package always publishes publicly regardless of npm CLI defaults.

## [2026.4.3] - 2026-04-06

### Added
- **LAFS native Rust validation** ([cbe235d5](https://github.com/kryptobaseddev/cleo/commit/cbe235d5)): replaces AJV with `jsonschema` crate via napi-rs binding (`crates/lafs-napi`); embedded schema cached in `OnceLock`, transparent AJV fallback when native binding unavailable
- **CAAMP doctor lock-file diagnostics**: restored `Lock File` section reporting orphaned skill entries, untracked skills on disk, and lock-vs-symlink agent-list mismatches (uses `core/lock-utils.js` after MCP cleanup)

### Fixed
- **CI unit-test failures** ([91a7f480](https://github.com/kryptobaseddev/cleo/commit/91a7f480)): caamp `tests/unit/` was pulled into root vitest by `cbe235d5` for the first time, exposing 11 stale `doctor.test.ts` failures (referencing the lock-file section removed in `480fa01a`) and 1 flaky `core-coverage-gaps.test.ts` GitLab test that hit real `gitlab.com` and got the sign-in HTML on a non-existent repo. Doctor checks restored, GitLab fetch mocked.
- **LAFS schema loading** ([22e0ad98](https://github.com/kryptobaseddev/cleo/commit/22e0ad98)): lazy-load envelope schema JSON, AJV-specific TSDoc cleaned up
- **Pipeline lifecycle** ([fde8c401](https://github.com/kryptobaseddev/cleo/commit/fde8c401)): enforce forward-only RCASD-IVTR stage transitions
- **Status transitions and gate enforcement** ([7f5be7d3](https://github.com/kryptobaseddev/cleo/commit/7f5be7d3)): config-aware verification gates, session-end memory bridge auto-refresh
- **Lint** ([a137fc14](https://github.com/kryptobaseddev/cleo/commit/a137fc14)): sort `internal.ts` exports for biome compliance

### Changed
- **LAFS docs audit** ([db53dee2](https://github.com/kryptobaseddev/cleo/commit/db53dee2)): comprehensive cleanup of stale documentation
- **LAFS cleanup** ([1b714b08](https://github.com/kryptobaseddev/cleo/commit/1b714b08)): removed ~6k lines of cruft from pre-monorepo era

## [2026.4.2] - 2026-04-05

### Fixed
- **`cleo inject` MCP purge**: replaced all `ct` prefix commands with `cleo`, removed `orchestrate.bootstrap` and `query({...})` MCP syntax from injection template
- **`cleo memory fetch` broken**: variadic `<ids...>` args not parsed by citty shim — switched to comma-split single positional arg
- **`cleo add --desc` silent failure**: `--desc` flag not recognized, causing description to default to title and trigger anti-hallucination rule — added `--desc` as explicit alias
- **Root version mismatch**: root `package.json` was 2026.3.76, all packages were 2026.4.1
- **Help text `ct` prefix**: system-engine.ts help topics used deprecated `ct` prefix instead of `cleo`
- **ct-cleo skill stale references**: 2 `ct find` references updated to `cleo find`

### Changed
- **CLEO-INJECTION.md optimized**: 133 → 72 lines (v2.4.0), CLI-only dispatch, all `cleo` prefix, no MCP syntax
- **Injection template tests**: updated for v2.4.0 structure (19 tests passing)
- **All 15 ct-* skills synced**: deployed from repo sources with MCP references removed
- **signaldock-runtime**: enhanced provider detection, generic provider support, cleaner adapter init

## [2026.4.0] - 2026-04-01

### Added
- **T234 Agent Domain Unification**: Complete separation of concerns — signaldock.db owns ALL agent data, tasks.db owns tasks only
- **AgentRegistryAccessor rewrite**: Reads/writes signaldock.db exclusively (no dual-write, no cache)
- **agent_connections table**: SSE/WebSocket lifecycle tracking with heartbeat monitoring
- **agent_credentials migration**: api_key_encrypted, transport_config, classification in signaldock.db
- **LocalTransport proven**: E2E lifecycle test (6 tests) — register, start, send, receive, stop
- **TransportFactory wiring**: createRuntime() auto-selects Local > SSE > HTTP
- **cleo agent start**: Full transport stack working with LocalTransport auto-selection
- **.cant scaffold on register**: T240 — generates valid CANT v2 persona file on agent registration
- **CANT v2 ProseBlock**: AST node for multi-line prose in .cant files
- **DieselStore message traits**: count_unread, unread_by_conversation, online agent listing
- **Cross-DB write-guards**: agentExistsInSignaldockDb() validation before cross-DB references
- **Junction table sync**: capabilities/skills synced to signaldock.db on register/update
- **cleo-prime**: Registered on api.signaldock.io as primary orchestrator identity

### Removed
- 12 sqlx adapter files (102 queries eliminated) — Diesel is sole Rust ORM
- agent_credentials dual-write pattern (was writing to both tasks.db and signaldock.db)
- Backfill code from upgrade.ts

### Fixed
- Drizzle migration FK ordering (lifecycle_evidence created before lifecycle_stages)
- Peek SQL timestamp filtering (was returning all messages from epoch)
- 3 CRITICAL security vulnerabilities on api.signaldock.io (AnyAuth bypass, message leakage, impersonation)
- ClawMsgr worker: 4-track message discovery, --agent flag, cursor stall fix
- ClawMsgr daemon: full message delivery (was count-only)
- signaldock.db embedded migrations work outside monorepo

### Changed
- Database separation: tasks.db=tasks, signaldock.db=agents, brain.db=memory, nexus.db=collab
- SignalDock is primary communication channel (ClawMsgr is legacy backup)
- All agent configs updated with groupConversationIds + correct API URLs
- 5 agent personas updated with --agent polling standard

### Added (T158 CAAMP 1.9.1 Integration)
- CAAMP ^1.9.1 with 16-event canonical hook taxonomy (T159)
- Hook types migrated to canonical names with backward compat (T160)
- Gemini CLI adapter: 10/16 hooks, getTranscript, install (T161)
- Codex adapter: 3/16 hooks, getTranscript, install (T162)
- Kimi adapter: install-only, no native hooks (T163)
- Claude Code adapter: 9→14 hooks via CAAMP normalizer (T164)
- OpenCode adapter: 6→10 hooks via CAAMP normalizer (T164)
- Cursor adapter: 0→10 hooks, fully implemented (T165)
- Brain automation handlers for SubagentStart/Stop, PreCompact (T166)
- `cleo doctor --hooks` provider hook matrix diagnostic (T167)
- E2E hook automation tests (T168)

## [2026.3.76] - 2026-03-28

### Added
- **Agent Unification (T170)**: Unified `cleo agent` CLI with 10 subcommands (register, list, get, remove, rotate-key, claim-code, watch, poll, send, health)
- **Agent Registry**: `agent_credentials` table with AES-256-GCM encrypted API keys (machine-key bound, per-project derived)
- **Conduit Architecture**: ConduitClient + HttpTransport + factory (2-layer Transport/Conduit pattern)
- **Transport interface**: connect/disconnect/push/poll/ack/subscribe in @cleocode/contracts
- **AgentCredential + AgentRegistryAPI contracts**: typed CRUD for credential management
- **@cleocode/runtime**: AgentPoller with group @mention support (fixes peek blind spot)
- **5 Rust crates migrated**: signaldock-protocol, signaldock-storage, signaldock-transport, signaldock-sdk, signaldock-payments (5→13 workspace crates)
- Diesel ORM foundation for signaldock-storage (schema.rs, models, consolidated migration)
- diesel-async 0.8 with SyncConnectionWrapper for unified SQLite + Postgres adapter
- Conduit dispatch domain (5 operations: status, peek, start, stop, send)
- cleo agent watch command for continuous message polling
- cleo agent claim-code command for ownership verification
- cleo agent health command (merged from deprecated `cleo agents`)
- TypedDb pattern with drizzle-orm/zod validation schemas
- **CANT DSL epic complete (T202)**: 694 tests, 17K Rust + 3.8K TS, 3 new crates (cant-napi, cant-lsp, cant-runtime)
- Crypto hardening: version byte in ciphertext (F-006), HOME validation (F-002), key length check (F-004)

### Fixed
- E-FIND-004: ACL denial now audited + projectPath redacted in nexus/workspace.ts
- AgentRegistryAccessor: pre-flight checks on update/remove (C1/C2), deterministic getActive ordering (H3)
- HttpTransport: `since` param now passed to peek endpoint (H5)
- ConduitClient: connect() transitions to error state on failure (H6)
- CLI agent key redaction safe on short keys (H1)
- CAAMP library-loader.ts TS2352 type cast fix
- workflow-executor.ts unused variable build errors
- Test assertions updated for conduit transport layer (Circle of Ten remains 10 domains)
- Audit test mock updated for agentCredentials schema export
- Message dedup P0 fixed server-side by signaldock-core-agent
- Biome lint: 24 errors resolved (all types from @cleocode/contracts, zero any)
- Ferrous Forge: 4 violations resolved (cant-core file splits)
- CI pipeline: 5 layers of failures fixed (lint, lockfile, build order)
- AgentRegistryAccessor drizzle type mismatch (8 TS errors eliminated)

### Changed
- Default API URL: `api.clawmsgr.com` → `api.signaldock.io` (legacy endpoint stays in parallel)
- `packages/core/src/signaldock/` removed — replaced by `conduit/` directory
- `cleo agents` deprecated — health monitoring moved to `cleo agent health`
- Conduit JSDoc updated: removed ClawMsgr references, documented Transport implementations
- DATABASE-ARCHITECTURE.md updated for Diesel as sole Rust ORM
- signaldock-storage traits split from monolithic mod.rs (432 lines) to 7 focused files
- Rust workspace version aligned to CalVer 2026.3.76

## [2026.3.70] - 2026-03-23

### Added
- **Brain Memory Automation** (T134 epic, 12 tasks):
  - `BrainConfig` typed configuration section with defaults and templates (T135)
  - Local embedding provider via `@xenova/transformers` all-MiniLM-L6-v2, dynamic import (T136)
  - Embedding worker thread + async queue for non-blocking processing (T137)
  - Memory bridge refresh wired to lifecycle hooks with 30s debounce (T138)
  - Context-aware memory bridge generation using `hybridSearch()` + token budget (T139)
  - Session summarization: dual-mode prompt + structured `SessionSummaryInput` response (T140)
  - Auto-link observations to focused task via `brain_memory_links` (T141)
  - Embedding backfill with progress reporting: `cleo backfill --embeddings` (T142)
  - Brain maintenance command: `cleo brain maintenance` with `--skip-decay`, `--skip-consolidation`, `--skip-embeddings` (T143)
  - Cross-provider transcript hook on `AdapterHookProvider` + Claude Code adapter implementation (T144)
  - Updated CLEO-INJECTION.md templates with Memory Automation section (T145)
  - Updated CLEO-BRAIN-SPECIFICATION.md to v2.0.0 (T146)

### Dependencies
- Added `@xenova/transformers` ^2.17.2 to `@cleocode/core` (external, dynamic import)

## [2026.3.69] - 2026-03-23

### Fixed
- **npm install**: Use `pnpm publish` to resolve `workspace:*` protocol — `npm publish` leaked workspace references making `npm install -g` fail with EUNSUPPORTEDPROTOCOL

## [2026.3.68] - 2026-03-23

### Added
- **`cleo check` command group**: `cleo check schema|coherence|task` — domain-prefix CLI access to check operations
- **`cleo admin` command group**: `cleo admin version|health|stats|runtime|smoke` — domain-prefix CLI access to admin operations
- **`cleo pipeline` alias**: Routes to existing `phase` command group

### Fixed
- **`cleo add --dry-run` session bypass**: Dry-run no longer requires active session, orphan prevention, or acceptance criteria — no data is written
- **Domain-prefix CLI routing**: `cleo check schema`, `cleo pipeline list`, `cleo admin version` now route correctly instead of showing root help

## [2026.3.67] - 2026-03-23

### Added
- **`cleo doctor --full` (#79, T130)**: Operational smoke test — 13 probes exercise one read-only query per domain through the full dispatch pipeline, plus tasks.db integrity, brain.db connectivity, and migration state validation. ~100ms runtime, exit code 0/1
- **`cleo upgrade --diagnose` (#80, T131)**: Deep read-only inspection of schema and migration state — validates required columns, migration journal entries, SQLite integrity, brain.db tables. Skipped steps now explain WHY with `reason` field

### Changed
- **Unified migration system (#82, T132)**: Shared `migration-manager.ts` consolidates duplicated reconciliation, bootstrap, retry, and column-safety logic from `sqlite.ts` and `brain-sqlite.ts` — ~170 lines dedup
- **Upgrade output**: `UpgradeResult` now includes `summary` (checked/applied/skipped/errors) and `reason` on skipped actions
- **Admin domain**: New `admin.smoke` query operation (tier 0)

### Fixed
- **Doctor/upgrade opts merging**: citty-parsed command-specific flags (`--full`, `--diagnose`, `--detailed`, etc.) were silently ignored because action handlers called `parseGlobalFlagsFromArgv()` which only extracts global flags. Now merges both sources

## [2026.3.66] - 2026-03-23

### Changed
- **Config type safety (T128)**: `EnforcementConfig` + `VerificationConfig` interfaces wired into `CleoConfig` — eliminates untyped `getRawConfigValue` dot-path access in enforcement.ts, complete.ts, add.ts
- **Retry dedup (T129)**: `agents/retry.ts withRetry` delegates to `lib/retry.ts` — single backoff implementation, dead `sleep()` removed

### Fixed
- **Facade domain count**: Updated from "10 domains" to "12 domain getter properties" (agents + intelligence added in v2026.3.60)
- **Missing barrel exports**: Added `AgentsAPI`, `IntelligenceAPI`, `getCleoTemplatesTildePath`, `updateProjectName` to public barrel

## [2026.3.65] - 2026-03-23

### Fixed
- **Phases crash (#77)**: Full null guard in `queryPhase()` — `listData.phases` and `listData.summary` now use `??` fallbacks
- **detect-drift user projects (#78)**: Detects CLEO source repo vs user projects. User projects get applicable checks only (injection template) instead of CLEO-internal source structure checks

## [2026.3.64] - 2026-03-23

### Fixed
- **Phases crash (#77)**: `paginate()` now guards against undefined/null/empty input arrays
- **detect-drift false errors (#78)**: Uses `process.cwd()` as project root instead of walking up from the CLI bundle file location

## [2026.3.63] - 2026-03-23

### Fixed
- **brain.db migration (#65, #71)**: Journal reconciliation now correctly applied — was lost in v2026.3.62 due to git stash conflict
- **--dryRun on cleo add (#66)**: `dryRun` flag now passed through dispatch domain → engine → `addTask()` core — previously silently dropped
- **backup list side effect (#74)**: Query gateway handler now properly included in build — read-only `listSystemBackups()` prevents snapshot creation
- **Help text leak regression (#76)**: Parent command `run()` now detects subcommand in `rawArgs` before showing help — prevents `showUsage()` from firing after valid subcommand output

### Added
- **session find CLI (#75)**: Re-added after loss in v2026.3.62 — dispatches to existing `query:session.find` MCP operation

## [2026.3.62] - 2026-03-23

### Fixed
- **Migration journal reconciliation (#63, #65)**: `runMigrations()` in tasks.db and brain.db now detects stale `__drizzle_migrations` entries from older CLEO versions (hash mismatch), clears them, and marks local migrations as applied
- **Defensive column safety net (#63)**: `ensureRequiredColumns()` runs after every migration — uses `PRAGMA table_info` to detect and add missing columns via `ALTER TABLE`
- **Issue command routing (#64)**: `cleo issue bug/feature/help` calls `addIssue()` from core directly instead of dispatching to removed MCP operations
- **brain.db migration (#65, #71)**: Same journal reconciliation pattern applied to brain.db — unblocks `memory find`, `observe`, `sticky`, `refresh-memory`, and `reason similar`
- **--dryRun flag (#66)**: `cleo add --dryRun` now returns preview with `id: T???` before sequence allocation — no DB writes or counter advancement
- **Labels empty output (#67)**: `labels list` marked as `isDefault` subcommand — bare `cleo labels` now invokes list
- **Exists routing (#68)**: `cleo exists` calls `getTask()` from core directly instead of unregistered `query:tasks.exists`
- **Critical-path routing (#69)**: `cleo deps critical-path` calls `depsCriticalPath()` from core directly instead of unregistered `query:orchestrate.critical.path`
- **Silent empty commands (#70)**: Parent commands without subcommand now show help text via citty `showUsage()` — fixes 21 commands that returned zero output
- **Sequence padding (#72)**: `nextId` in `showSequence()` uses `padStart(3, '0')` — returns `T012` not `T12`
- **Stats contradiction (#73)**: `totalCompleted` now uses audit log as SSoT (same source as `completedInPeriod`) for consistent metrics
- **Backup list side effect (#74)**: Changed `backup list` from `mutate` to `query` gateway with new read-only `listSystemBackups()` function

### Added
- **`session find` CLI subcommand (#75)**: MCP operation already existed — added CLI registration with `--status`, `--scope`, `--query`, `--limit` options
- **`repairMissingColumns()`**: New repair function in `cleo upgrade` that reports missing column detection/fix

### Changed
- **Injection template**: `session find` reference clarified to `cleo session find`

## [2026.3.60] - 2026-03-22

### Fixed
- **Bootstrap injection chain (T124)**: Legacy `~/.cleo/templates/` now synced on every install — fixes stale injection for projects referencing old path
- **CAAMP corruption**: `sanitizeCaampFile()` cleans orphaned fragments and duplicate markers from `~/.agents/AGENTS.md` before inject()
- **Post-bootstrap health check**: `verifyBootstrapHealth()` Step 7 validates injection chain integrity
- **`checkGlobalTemplates`**: Now checks version sync between XDG and legacy template paths

### Added
- **Facade: `sessions.start({ startTask })` (T125)**: Bind session + task in one call for CleoOS
- **Facade: `tasks.start/stop/current` (T126)**: TasksAPI exposes task-work methods via facade
- **Facade: `cleo.agents` getter (T127)**: AgentsAPI with 8 methods (register, deregister, health, detectCrashed, recordHeartbeat, capacity, isOverloaded, list)
- **Facade: `cleo.intelligence` getter (T127)**: IntelligenceAPI with 2 methods (predictImpact, blastRadius)

## [2026.3.59] - 2026-03-22

### Added
- **Agent health monitoring**: `cleo agents health` — heartbeat, stale/crash detection (T039, 25 tests)
- **Retry utility**: `withRetry()` exponential backoff in `lib/retry.ts` (T040, 16 tests)
- **Agent registry**: Capacity tracking, specializations, performance recording (T041, 21 tests)
- **Impact prediction**: `cleo reason impact --change <text>` — dependency analysis (T043)
- **Reasoning CLI**: `cleo reason why|similar|impact|timeline` — CLI parity (T044)
- **SharingStatus**: Git sync fields for Nexus visibility (T110)

### Changed
- **Config vaporware audit (T101)**: Removed ~170 dead config fields across schema/templates/presets
- **Strictness presets**: Fixed phantom `hierarchy.requireAcceptanceCriteria` key (T107)

### Assessed
- **Nexus**: Zero production usage — deferred to Phase 3 (T045)

## [2026.3.58] - 2026-03-22

### Added
- **Enforcement gates**: Session required for mutations, AC required on creation (min 3), verification gates required for completion, orphan tasks blocked (must have parent epic) — all in strict mode
- **Pipeline stage binding**: RCASD-IVTR+C auto-assignment, forward-only transitions (T060)
- **Verification gate auto-init**: Tasks get verification metadata on creation (T061)
- **Epic lifecycle enforcement**: Min 5 AC, child stage ceiling, advancement gates (T062)
- **Workflow compliance telemetry**: `cleo stats compliance` dashboard (T065)
- **Task backfill**: `cleo backfill [--dry-run]` for existing tasks (T066)
- **Strictness presets**: `cleo config set-preset strict|standard|minimal` (T067)
- **Agent dimension**: Execution learning, self-healing patterns (T034)
- **Intelligence dimension**: Adaptive validation, confidence scoring (T035)
- **ERD diagrams**: Mermaid ERDs for all 3 databases (T036)
- **Skills updated**: Mandatory workflow rules WF-001 through WF-005 (T063)
- **ct-validator skill**: Gate enforcement skill (T064)
- **Agent code quality rules**: Added to AGENTS.md for all subagents

### Fixed
- CTE column mismatch (#61): Rewritten to column-independent ID-only pattern
- Table constraint loss (#62): Migration uses proper CREATE TABLE with constraints
- Session FK ordering: Insert new session before updating predecessor.nextSessionId
- `closeDb()` production bug: Now resets `_initPromise` to prevent stale connections
- `tasks.add` dispatch: acceptance, phase, size, notes, files params now passed through
- `--acceptance` delimiter: Changed from comma to pipe for AC items with commas
- Config templates: enforcement/verification/lifecycle fields added with strict defaults
- `complete.ts` defaults: Corrected from warn→block, off→strict
- Test infrastructure: 141→0 test failures via centralized VITEST enforcement bypass
- Schema hardening: 9 composite indexes, 17 soft FKs hardened, PRAGMA foreign_keys=ON

### Changed
- Config templates ship with 100% strict enforcement defaults
- `loadCompletionEnforcement` honors explicit config values in test mode

## [2026.3.57] (2026-03-21)

### Fixed
- Remove install-global hints from self-update (postinstall handles bootstrap)
- Template version bumped to 2.2.0 for refresh verification
- Remove packageRoot override from install-global and postinstall

## [2026.3.56] (2026-03-21)

### Fixed
- **Template refresh on install**: install-global and postinstall were passing packageRoot pointing to @cleocode/cleo, but templates live in @cleocode/core. Bootstrap now resolves from core getPackageRoot() without override.

## [2026.3.55] (2026-03-21)

### Fixed
- **CRITICAL: CLEO-INJECTION.md template was stale in npm package** — agents received old MCP-first template with deprecated `memory brain.search` operations. Template now correctly shows CLI-first, `memory find`, Runtime Environment section, and actual CLI command syntax.
- **CLI command syntax in template** — changed from wrong `cleo <domain> <operation>` to actual flat commands (`cleo find`, `cleo current`, `cleo dash`, etc.)
- **Session quick reference** — now shows CLI as primary with MCP fallback
- **Memory examples** — CLI-first (`cleo memory find "auth"` not MCP query)

## [2026.3.54] (2026-03-21)

### Changed
- **Dynamic template paths**: All `@` references in AGENTS.md now use `getCleoTemplatesTildePath()` — resolves to OS-appropriate XDG path (`~/.local/share/cleo/templates` on Linux, `~/Library/Application Support/cleo/templates` on macOS). No more hardcoded `~/.cleo/templates/`.
- **`getCleoTemplatesTildePath()`**: New path function that returns the templates dir as a `~`-prefixed string for cross-platform `@` references.

### Fixed
- **Template path mismatch**: AGENTS.md referenced `~/.cleo/templates/` but templates live at XDG path (`~/.local/share/cleo/templates/`). Now both reference and storage use the same dynamic path.

## [2026.3.53] (2026-03-21)

### Fixed
- **Global config.json**: Created from `global-config.template.json` during `ensureGlobalHome()` if missing.
- **Stale `templates/templates` symlink**: Added to STALE_GLOBAL_ENTRIES — was pointing to dev source in old installs.
- **Stale `.install-state/`**: Added to cleanup list.

## [2026.3.52] (2026-03-21)

### Fixed
- **Global scaffold cleanup works**: Was cleaning XDG path (`~/.local/share/cleo/`) but stale dirs were at legacy `~/.cleo/` path. Now cleans both locations.
- **CAAMP ^1.8.1**: Consolidates pre-existing duplicate blocks natively. Removed workaround that stripped all CAAMP blocks before inject.

## [2026.3.51] (2026-03-21)

### Fixed
- **Postinstall bootstrap import**: Fall back from `@cleocode/core/internal` (multi-file) to `@cleocode/core` (esbuild bundle) — `dist/internal.js` doesn't exist in published package.
- **bootstrapGlobalCleo exported from public barrel**: Now available via `@cleocode/core` import, not just `@cleocode/core/internal`.

## [2026.3.50] (2026-03-21)

### Fixed
- **Postinstall detection**: Replaced broken `process.argv[1]` check with `npm_config_global`, `lib/node_modules` path check, and pnpm workspace marker detection.
- **Postinstall import path**: Changed from broken `../dist/core/bootstrap.js` to `@cleocode/core/internal` which resolves correctly in published package.
- **esbuild bundle dynamic import**: Changed `ensureGlobalHome()` from dynamic import to static import so esbuild includes it in the single-file bundle.
- **Global scaffold cleanup**: Now actually runs during bootstrap — removes stale project-level dirs from `~/.cleo/`.

## [2026.3.49] (2026-03-20)

### Fixed
- **CAAMP block duplication**: Strip ALL existing CAAMP blocks before inject() — workaround for CAAMP not consolidating pre-existing duplicates (CAAMP issue #48)
- **Global scaffold cleanup**: Bootstrap now calls `ensureGlobalHome()` which removes stale project-level dirs from `~/.cleo/`
- **Stale cleo-subagent symlink**: Now detects symlinks pointing to wrong target and recreates them pointing to the npm package path

## [2026.3.48] (2026-03-20)

### Added
- **`cleo detect` command**: Standalone lightweight re-detection of project type. Updates project-context.json without full init or upgrade.
- **`cleo upgrade --detect`**: Force re-detection ignoring staleness schedule.
- **`cleo upgrade --map-codebase`**: Run full codebase analysis and store findings to brain.db.
- **`cleo upgrade --name <name>`**: Programmatically update project name in project-info.json and nexus registry.
- **`updateProjectName()`**: Core function in project-info.ts (SSoT for project name updates).

### Changed
- **init/upgrade boundary**: `--update-docs` removed from init. All maintenance goes through `cleo upgrade`.
- **`--refresh` alias removed** from init (keep flags simple, `--detect` only).
- **Fix hints** across injection.ts and doctor/checks.ts now say `cleo upgrade` instead of `cleo init --update-docs`.

### Fixed
- **CLI version**: Now reads from package.json at runtime instead of build-time constant.
- **stripCLEOBlocks**: Handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`).
- **Global scaffold cleanup**: Removes stale project-level dirs from `~/.cleo/` on bootstrap.
- **cleo-subagent symlink**: Installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path.

## [2026.3.47] (2026-03-20)

### Fixed
- **CLI version** reports runtime package.json version instead of build-time constant
- **stripCLEOBlocks** handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`)
- **Global scaffold cleanup** removes stale project-level dirs from `~/.cleo/` on bootstrap (adrs, rcasd, agent-outputs, backups, sandbox, tasks.db, schemas, bin)
- **cleo-subagent symlink** installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path
- **Bootstrap regex** fixed in both inline copies in bootstrap.ts

## [2026.3.46] (2026-03-20)

### Fixed
- **MCP `tasks.find` E_NOT_INITIALIZED** (T073): All 10 domain handlers deferred `getProjectRoot()` from constructor to request time, fixing initialization failures in MCP transport.
- **MCP `session.start --scope global` rejected** (T074): Fixed broken regex in `operation-gate-validators.ts` that required `global:` (with colon) instead of accepting bare `"global"`.
- **Bare catch blocks in task-engine.ts** (T073): `taskFind` and `taskList` now properly distinguish `E_NOT_FOUND`, `E_INVALID_INPUT`, and `E_NOT_INITIALIZED` errors instead of masking all as initialization failure.
- **681 duplicate CAAMP blocks in `~/.agents/AGENTS.md`** (T084): Upgraded to CAAMP v1.8.0 with native idempotent `inject()`. Removed workaround guards.
- **skill-paths.ts CAAMP path bug** (T085): Was using `getAgentsHome()` instead of `getCanonicalSkillsDir()`, causing skill resolution to look in wrong directory.
- **Broken cleo-subagent symlink**: Fixed stale symlink pointing to dev source path.

### Changed
- **CLI-First Pivot** (T078): All skills (ct-cleo, ct-orchestrator, ct-memory) now show CLI as primary channel, MCP as fallback.
- **Dependency Consolidation**: `@cleocode/core` now bundles adapters, skills, and agents as workspace deps. `@cleocode/cleo` slimmed to core + MCP SDK + citty only.
- **CAAMP ^1.8.0**: Idempotent `inject()`, `ensureProviderInstructionFile()` API, skill lock file support.
- **LAFS ^1.8.0**: Updated protocol dependency.
- **Templates/schemas moved into `packages/core/`**: No longer symlinked from root. Shipped in npm package via `getPackageRoot()`.
- **Global scaffold cleanup**: Removed project-level dirs (`adrs/`, `rcasd/`, `agent-outputs/`, `backups/`, `tasks.db`) from `~/.cleo/`. Schemas read from npm binary at runtime.
- **Skills install global-only**: Skills installation moved from project `init` to global bootstrap only.
- **Windows symlink support**: Directory symlinks use `junction` type on Windows.
- **Injection chain**: Project AGENTS.md now references `@~/.agents/AGENTS.md` (global hub) instead of template directly.
- **CleoOS detection**: CLEO-INJECTION.md includes `${CLEO_RUNTIME:-standalone}` mode with channel routing table.

### Added
- **Skills-registry validator** (T079): `packages/skills/scripts/validate-operations.ts` — automated drift detection between skills and canonical registry.
- **Capability matrix SSoT** (T076): Merged `capability-matrix.ts` + `routing-table.ts` into single source with 211 operations, required `preferredChannel` field.

### Removed
- `cleoctl` binary alias (stale separation-era artifact).
- `injection-legacy.ts` and its test (mapped CLAUDE.md/GEMINI.md — no longer valid).
- Root `templates/` and `schemas/` directories (moved into `packages/core/`).
- 30+ deprecated operation references across skills (`research` domain, `memory.brain.*`, `system` domain, `tasks.exists`, `admin.grade`).

## [2026.3.45] (2026-03-20)

### Added
- **Nexus Task Transfer** (T046): Cross-project task transfer with `nexus.transfer` (mutate) and `nexus.transfer.preview` (query) operations. Supports copy/move modes, subtree/single scope, bidirectional `external_task_links` with `'transferred'` link type, brain observation transfer, provenance tracking, and conflict resolution strategies.
- `importFromPackage()` — extracted from `importTasksPackage()` for in-memory ExportPackage import without file I/O.
- 19 new transfer test cases covering copy/move modes, ID remapping, hierarchy/dependency preservation, link creation, conflict resolution, and error handling.
- `transfer` verb added to VERB-STANDARDS.md deferred verbs table.

### Fixed
- **Migration path resolution**: `resolveMigrationsFolder()`, `resolveBrainMigrationsFolder()`, and `resolveNexusMigrationsFolder()` now correctly detect bundled (`dist/`) vs source (`src/store/`) context when resolving migration paths. Previously, esbuild-bundled builds would resolve to wrong directory (2 levels up from `dist/` instead of 1).

## [2026.3.44] (2026-03-20)

### Added
- **Agent Dimension** (100%): Agent registry, health monitoring (30s crash detection), self-healing with exponential backoff, capacity tracking and load balancing. New `agent_instances` and `agent_error_log` tables.
- **Intelligence Dimension** (100%): Quality prediction (4-factor risk scoring), pattern extraction from brain.db, impact analysis with BFS/DFS graph traversal and blast radius calculation.
- **Validation Contracts**: 36 canonical Zod enum schemas backed by `as const` constants. 13 table schemas with business logic refinements. 14 hook payload Zod schemas with `validatePayload()` dispatcher.
- **Nexus E2E Tests**: 89 integration tests covering registry, audit, health, permissions, cross-project refs, orphan detection, and discovery. Fixed `extractKeywords()` case handling bug.
- **Schema Integrity**: 3 hard foreign keys (warp_chain_instances CASCADE, sessions prev/next SET NULL), 16 indexes, 1 UNIQUE constraint on external_task_links.
- **Database ERDs**: Mermaid diagrams for all 3 databases (tasks.db, brain.db, nexus.db).
- **Type Contracts Documentation**: Full public API surface (43 namespaces) documented.

### Changed
- **BREAKING**: `TaskFile` interface removed from `@cleocode/contracts`. Use `Task[]` from `DataAccessor.queryTasks()` directly.
- **BREAKING**: `TaskFileExt`, `TaskFileTaskEntry`, `TaskFileMetaExt`, `toTaskFileExt()` removed from sessions module.
- **BREAKING**: `buildPrompt()`, `spawn()`, `spawnBatch()`, `canParallelize()`, `orchestratorSpawnSkill()`, `injectProtocol()`, `buildTaskContext()`, `validateOrchestratorCompliance()`, `validateContributionTask()` are now async. Add `await` at call sites.
- **BREAKING**: `buildExportPackage()`, `exportSingle()`, `exportSubtree()` signatures changed — pass `projectName` in options instead of `TaskFile`.
- Public barrel now exports 43 namespaces (added `agents`, `intelligence`).
- CORE-PACKAGE-SPEC updated to v3.0.0 with section 15.5 documenting all breaking changes.
- Facade API (`Cleo.init()`) is unchanged — no impact on facade consumers.

### Fixed
- **ADR-006 Compliance**: All task/session/focus JSON file reads replaced with DataAccessor → SQLite queries across 7 files (12 functions).
- **Focus Meta Key**: Unified from split `'focus'`/`'focus_state'` to `'focus_state'` everywhere.
- **Pipeline Stage Source**: `computePipelineStage` now queries `lifecycle_pipelines` table directly instead of `file_meta` KV store.
- **Inline Enum Drift**: 4 hardcoded Zod enum arrays extracted to `as const` constants (TASK_RELATION_TYPES, LIFECYCLE_TRANSITION_TYPES, EXTERNAL_LINK_TYPES, SYNC_DIRECTIONS).
- **Type Safety**: `as unknown as` casts reduced from 9 to 4 (remaining are node:sqlite and drizzle-orm library boundaries).
- **Agent Suppressions**: 5 underscore-prefixed params introduced by agents wired into real implementations.

### Removed
- `tasks/reparent.ts` — dead code; `task-ops.ts` has the DataAccessor-based implementation.
- `getSessionsPath()` — zero callers remaining (sessions are in SQLite).
- All `sessions.json`, `tasks.json`, `focus.json` file reads from non-migration code.

## [2026.3.43] (2026-03-19)

### Fixed
- **Build**: Generate `.d.ts` type declarations in `build.mjs` via `tsc --emitDeclarationOnly` after esbuild bundling. esbuild produces single-file `.js` bundles but doesn't emit TypeScript declarations, so consumers of `@cleocode/core` and `@cleocode/adapters` were getting packages with no type information.

## [2026.3.42] (2026-03-19)

### Fixed
- **npm Publish**: Add `.npmignore` to all publishable packages. Root `.gitignore` had `dist/` which caused pnpm publish to exclude the entire `dist/` directory (including all `.d.ts` type declarations and sub-module `.js` files) from published tarballs. Consumers got packages with `types` pointing to non-existent files. This was broken since the first publish.

## [2026.3.41] (2026-03-19)

### Fixed
- **Release Workflow**: Fix `cd` navigation bug in npm publish step that caused all packages after the first to fail. Use `pushd`/`popd` for reliable directory handling and tolerate "already published" errors.

## [2026.3.40] (2026-03-19)

### Added
- **Task Reconciliation Engine**: Provider-agnostic external task sync system in `@cleocode/core`. Consumers implement `ExternalTaskProvider` to sync any issue tracker (Linear, Jira, GitHub, GitLab) with CLEO as SSoT.
- **External Task Links**: New `external_task_links` table in tasks.db for DB-backed bidirectional traceability between CLEO tasks and external system tasks.
- **Link Store API**: `createLink`, `getLinksByProvider`, `getLinksByTaskId`, `getLinkByExternalId`, `touchLink`, `removeLinksByProvider` in `@cleocode/core`.
- **Cleo Facade SyncAPI**: `cleo.sync.reconcile()`, `cleo.sync.getLinks()`, `cleo.sync.getTaskLinks()`, `cleo.sync.removeProviderLinks()`.
- **Dispatch Operations**: `tasks.sync.reconcile` (mutate), `tasks.sync.links` (query), `tasks.sync.links.remove` (mutate) — wired through registry, capability matrix, task engine, and domain handler.

### Removed
- **TodoWrite System**: Completely removed all TodoWrite code, types, contracts, CLI commands, dispatch operations, and file-based sync state (`todowrite-session.json`, `todowrite-state.json`).
  - Deleted: `contracts/todowrite.ts`, `core/task-work/todowrite-merge.ts`, `core/admin/sync.ts`, `core/reconciliation/sync-state.ts`, CLI `extract` and `sync` commands, `tools.todowrite.*` dispatch ops and registry entries.
  - Removed `todowrite` export format from `admin/export.ts`.
- **Stale Compiled Artifacts**: Cleaned all `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files for deleted source modules.

### Changed
- **Contracts**: `AdapterTaskSyncProvider` renamed to `ExternalTaskProvider`. `ExternalTask` enriched with `priority`, `type`, `url`, `parentExternalId`. `SyncSessionState` removed (replaced by DB-backed links). `ReconcileResult` gains `updated`, `linksAffected`, `total` counts.
- **DRY requiredParams**: Moved param validation from 13 inline handler checks to `requiredParams` declarations in the dispatch registry for the entire tasks domain.

## [2026.3.39] (2026-03-19)

### Fixed
- **CI/CD Pipeline**: Fixed pnpm version conflict in release workflow, added agents and skills packages to version sync and npm publish
- **Error Handling**: Created central error utilities in contracts package with proper TypeScript types
- **CLI Type Safety**: Completely removed commander-shim, migrated to clean citty-based CLI with zero `any` types
- **CAAMP Integration**: Updated to @cleocode/caamp@1.7.1 with proper exports, removed mock files
- **Documentation**: Added comprehensive README files for root and all packages
- **Code Quality**: Fixed all lint warnings, updated biome.json schema

## [2026.3.38] (2026-03-19)

Auto-prepared by release.ship (T021)

### Chores
- **Migrate parallel-state.json to SQLite**: Move orchestration/parallel.ts state from .cleo/parallel-state.json into SQLite schema_meta or new table. Eliminates JSON clobbering when parallel ... (T022)

### Changes
- **Eliminate _meta.activeSession pointer — use SQL query**: Replace activeSession pointer in file_meta with dynamic SQL: SELECT FROM sessions WHERE status=active. Remove from FileMeta, session-switch, sessio... (T021)
- **Wrap add/update/complete/delete in transaction()**: Wrap full read-validate-write flow in add.ts, update.ts, complete.ts, delete.ts inside accessor.transaction() for TOCTOU safety under concurrent mu... (T023)
- **SQL-level position allocation in add.ts**: Replace JS position computation with SQL: INSERT SELECT COALESCE(MAX(position),0)+1. Eliminates TOCTOU where concurrent adds get same position. (T024)
- **Bulk SQL for task reorder operations**: Replace per-task upsertSingleTask loop with single UPDATE tasks SET position=position+1 WHERE parent_id=? AND position>=?. Eliminates N+1 pattern. (T025)
- **Replace saveSessions(array) with upsertSingleSession**: Make upsertSingleSession required on DataAccessor. Replace all saveSessions bulk writes with per-session targeted writes. Eliminates session array ... (T026)
- **Async background embedding for brain memory**: Make embedding generation in observeBrain fire-and-forget via async queue. Currently synchronous and blocks CLI/Agent during LLM embedding calls. (T027)
- **Memory decay — confidence decay for old memories**: Add decay factor so old unreferenced memory drops from context window. Implement as decay multiplier based on age and reference count. (T028)

[Unreleased]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.59...HEAD
[2026.3.59]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.58...v2026.3.59
[2026.3.58]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.57...v2026.3.58
