# legacy-pattern Surpass Master Implementation Plan

**Team**: legacy-pattern-surpass
**Date**: 2026-03-04
**Status**: APPROVED
**Workstreams**: 4 (A: Hooks, B: BRAIN Phase 3-5, C: Warp/Protocol Chains, D: MEOW Workflows)

---

## Executive Summary

This plan decomposes the legacy-pattern Surpass initiative into 4 workstreams with 38 atomic implementation tasks. Each task targets 1-3 files, includes exact file paths, validation criteria, and enough detail for an implementation agent to execute without ambiguity.

**Key blockers identified**:
- BRAIN Phase 3 embedding pipeline (T5158) is the single biggest unknown — options documented, decision needed
- Warp Phase 4 (storage) requires a Drizzle migration
- MEOW depends on Warp types being defined first

---

## Workstream A: Hooks Completion

**Goal**: Wire the 4 missing CAAMP hook events (onFileChange, onError, onPromptSubmit, onResponseComplete), fix task-hooks error guards, add missing tests.

**Total tasks**: 9

### WS-A1: Fix task-hooks.ts missing brain schema error guards

- **Files**: `src/core/hooks/handlers/task-hooks.ts`
- **Scope**: small
- **Dependencies**: None
- **What to do**: Add `isMissingBrainSchemaError()` guard to both `handleToolStart` and `handleToolComplete` handlers, matching the pattern already used in `src/core/hooks/handlers/session-hooks.ts`. Import `isMissingBrainSchemaError` from the same source session-hooks uses. Wrap the `observeBrain()` call in a try/catch that swallows brain schema errors and rethrows others.
- **Validation**: `npx tsc --noEmit`, existing session-hooks tests still pass, manual review confirms guard pattern matches session-hooks.ts

### WS-A2: Add task-hooks test coverage

- **Files**: `src/core/hooks/handlers/__tests__/task-hooks.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-A1
- **What to do**: Create test file mirroring `session-hooks.test.ts` pattern. Tests: (1) handleToolStart calls observeBrain with task ID and title, (2) handleToolStart swallows brain schema missing error, (3) handleToolStart rethrows non-schema errors, (4) handleToolComplete calls observeBrain with task ID and status, (5) handleToolComplete swallows brain schema missing error, (6) handleToolComplete rethrows non-schema errors. Mock `observeBrain` via vi.mock.
- **Validation**: `npx vitest run src/core/hooks/handlers/__tests__/task-hooks.test.ts` — all 6 tests pass

### WS-A3: Add 4 missing hook payload types to types.ts

- **Files**: `src/core/hooks/types.ts`
- **Scope**: small
- **Dependencies**: None
- **What to do**: Add 4 new interfaces extending `HookPayload`: `OnFileChangePayload` (filePath: string, changeType: 'write' | 'create' | 'delete', sizeBytes?: number), `OnErrorPayload` (errorCode: number | string, message: string, domain?: string, operation?: string, gateway?: string, stack?: string), `OnPromptSubmitPayload` (gateway: string, domain: string, operation: string, source?: string), `OnResponseCompletePayload` (gateway: string, domain: string, operation: string, success: boolean, durationMs?: number, errorCode?: string). Also update `CLEO_TO_CAAMP_HOOK_MAP` with 4 new entries: `'file.write': 'onFileChange'`, `'error.caught': 'onError'`, `'prompt.submit': 'onPromptSubmit'`, `'response.complete': 'onResponseComplete'`.
- **Validation**: `npx tsc --noEmit`

### WS-A4: Implement onError hook dispatch and handler

- **Files**: `src/dispatch/dispatcher.ts`, `src/core/hooks/handlers/error-hooks.ts` (new), `src/core/hooks/handlers/index.ts`
- **Scope**: medium
- **Dependencies**: WS-A3
- **What to do**: (1) In `dispatcher.ts`, wrap the `terminal()` call (~line 87-93) in a try/catch. On catch, dispatch `hooks.dispatch('onError', getProjectRoot(), payload)` with errorCode, message, domain, operation, gateway. Re-throw the error after dispatch. Import `hooks` from `../core/hooks/index.js`. (2) Create `error-hooks.ts` handler: register for `onError` event with priority 100, ID `brain-error`. Guard against infinite loop by checking `payload.metadata?.fromHook`. Include `isMissingBrainSchemaError` guard. Call `observeBrain()` with type `discovery`, title `Error: ${domain}.${operation} - ${errorCode}`, text with error message + context. (3) Add import of `error-hooks.ts` in `handlers/index.ts`.
- **Validation**: `npx tsc --noEmit`, new tests pass (WS-A5)

### WS-A5: Add error-hooks tests

- **Files**: `src/core/hooks/handlers/__tests__/error-hooks.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-A4
- **What to do**: Tests: (1) handler calls observeBrain with error details, (2) handler swallows brain schema missing error, (3) handler skips observation when fromHook flag is set (infinite loop guard), (4) handler includes domain/operation in observation text. Mock `observeBrain`.
- **Validation**: `npx vitest run src/core/hooks/handlers/__tests__/error-hooks.test.ts` — all tests pass

### WS-A6: Implement onFileChange hook dispatch and handler

- **Files**: `src/store/json.ts`, `src/core/hooks/handlers/file-hooks.ts` (new), `src/core/hooks/handlers/index.ts`
- **Scope**: medium
- **Dependencies**: WS-A3
- **What to do**: (1) In `json.ts`, after the atomic write succeeds in `saveJson()` (~line 108), add `hooks.dispatch('onFileChange', projectRoot, { timestamp, filePath, changeType: 'write', sizeBytes })`. Import hooks. (2) Create `file-hooks.ts` handler: register for `onFileChange` with priority 100, ID `brain-file-change`. Implement 5-second deduplication: maintain a Map<string, number> of filePath -> lastDispatchTimestamp, skip if same file changed within 5000ms. Convert absolute path to relative from projectRoot. Call `observeBrain()` with type `change`, title `File changed: <relative-path>`. Include `isMissingBrainSchemaError` guard. (3) Add import to `handlers/index.ts`.
- **Validation**: `npx tsc --noEmit`, new tests pass (WS-A7)

### WS-A7: Add file-hooks tests

- **Files**: `src/core/hooks/handlers/__tests__/file-hooks.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-A6
- **What to do**: Tests: (1) handler calls observeBrain with file path and change type, (2) handler deduplicates rapid writes to same file (second call within 5s is skipped), (3) handler allows writes to different files within 5s, (4) handler converts absolute path to relative, (5) handler swallows brain schema missing error. Mock `observeBrain` and Date.now.
- **Validation**: `npx vitest run src/core/hooks/handlers/__tests__/file-hooks.test.ts` — all tests pass

### WS-A8: Implement onPromptSubmit + onResponseComplete dispatch and handler

- **Files**: `src/dispatch/adapters/mcp.ts`, `src/core/hooks/handlers/mcp-hooks.ts` (new), `src/core/hooks/handlers/index.ts`
- **Scope**: medium
- **Dependencies**: WS-A3
- **What to do**: (1) In `mcp.ts` `handleMcpToolCall()`, add `hooks.dispatch('onPromptSubmit', ...)` BEFORE the dispatcher call with gateway, domain, operation (no sensitive params). Add `hooks.dispatch('onResponseComplete', ...)` AFTER the dispatcher returns with gateway, domain, operation, success, durationMs. (2) Create `mcp-hooks.ts`: register two handlers (`brain-prompt-submit` and `brain-response-complete`), both priority 100. Default behavior: metrics/logging only, NO brain capture (too noisy). Check `process.env.CLEO_BRAIN_CAPTURE_MCP === 'true'` to optionally enable brain observation. Include `isMissingBrainSchemaError` guard when brain capture is enabled. (3) Add import to `handlers/index.ts`.
- **Validation**: `npx tsc --noEmit`, new tests pass (WS-A9)

### WS-A9: Add mcp-hooks tests

- **Files**: `src/core/hooks/handlers/__tests__/mcp-hooks.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-A8
- **What to do**: Tests: (1) onPromptSubmit handler does NOT call observeBrain by default, (2) onPromptSubmit handler calls observeBrain when CLEO_BRAIN_CAPTURE_MCP=true, (3) onResponseComplete handler does NOT call observeBrain by default, (4) onResponseComplete handler calls observeBrain when env enabled, (5) handlers swallow brain schema missing error when brain capture is on. Mock `observeBrain` and process.env.
- **Validation**: `npx vitest run src/core/hooks/handlers/__tests__/mcp-hooks.test.ts` — all tests pass

---

## Workstream B: BRAIN Phase 3-5

**Goal**: Complete BRAIN database infrastructure — embeddings, vector search, PageIndex graph, reasoning ops, memory lifecycle, claude-mem retirement.

**Total tasks**: 15

**CRITICAL BLOCKER**: Embedding generation pipeline (WS-B2) blocks all vector-dependent tasks. Tasks that can proceed WITHOUT embeddings are marked accordingly.

### WS-B1: PageIndex accessor CRUD methods (NO embedding dependency)

- **Files**: `src/store/brain-accessor.ts`
- **Scope**: small
- **Dependencies**: None
- **What to do**: Add CRUD methods to `BrainDataAccessor` for PageIndex tables: `addPageNode(node: { id, type, label, metadata? })`, `addPageEdge(edge: { sourceId, targetId, edgeType, weight?, metadata? })`, `getPageNode(id)`, `getPageEdges(nodeId, direction?: 'in' | 'out' | 'both')`, `getNeighbors(nodeId, edgeType?)`, `removePageNode(id)`, `removePageEdge(sourceId, targetId, edgeType)`. Use existing Drizzle schema `brainPageNodes` and `brainPageEdges` from `brain-schema.ts`. Follow existing accessor patterns (eq, and, or from drizzle-orm).
- **Validation**: `npx tsc --noEmit`, new tests pass (WS-B2b)

### WS-B2a: PageIndex accessor tests (NO embedding dependency)

- **Files**: `src/store/__tests__/brain-accessor-pageindex.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-B1
- **What to do**: Tests covering: (1) addPageNode creates node, (2) addPageEdge creates edge, (3) getPageNode returns node by ID, (4) getPageEdges returns edges in/out/both, (5) getNeighbors returns connected nodes, (6) removePageNode removes node and cascading edges, (7) removePageEdge removes specific edge, (8) duplicate node ID throws. Use in-memory SQLite brain.db setup matching existing brain test patterns.
- **Validation**: `npx vitest run src/store/__tests__/brain-accessor-pageindex.test.ts` — all tests pass

### WS-B2b: PageIndex MCP domain wiring (NO embedding dependency)

- **Files**: `src/dispatch/domains/memory.ts`, `src/dispatch/engines/memory-engine.ts` (or equivalent engine file)
- **Scope**: small
- **Dependencies**: WS-B1
- **What to do**: Wire PageIndex operations into memory domain: `memory.graph.add.node` (mutate), `memory.graph.add.edge` (mutate), `memory.graph.show` (query — get node + edges), `memory.graph.neighbors` (query), `memory.graph.remove.node` (mutate), `memory.graph.remove.edge` (mutate). Add to registry. Handler functions call BrainDataAccessor methods. Follow existing memory domain handler patterns.
- **Validation**: `npx tsc --noEmit`, dispatch test via MCP gateway

### WS-B3: Embedding model selection and embedText() function

- **Files**: `src/core/memory/brain-embedding.ts` (new)
- **Scope**: large (technical unknown)
- **Dependencies**: None
- **What to do**: Choose between (a) `@huggingface/transformers` with `all-MiniLM-L6-v2` for local 384-dim embeddings, or (b) ONNX Runtime with `onnxruntime-node`. Implement `embedText(text: string): Promise<Float32Array>` that generates a 384-dimension embedding. Handle model loading lazily (first call downloads/loads model). Export `isEmbeddingAvailable(): boolean` for conditional code paths. Add the chosen package to package.json dependencies. Include a `BRAIN_EMBEDDING_MODEL` env var to override model name.
- **EMBEDDING BLOCKER**: This task must make the architectural decision. If local inference proves too heavy (binary size > 100MB, inference > 500ms), document the decision and implement an API-based fallback interface.
- **Validation**: `npx tsc --noEmit`, unit test that embeds a string and verifies 384-dim Float32Array output

### WS-B4: Embedding population pipeline

- **Files**: `src/core/memory/brain-embedding.ts` (extend), `src/core/memory/brain-retrieval.ts`
- **Scope**: medium
- **Dependencies**: WS-B3
- **What to do**: Hook into `observeBrain()` in `brain-retrieval.ts` — after saving an observation, call `embedText(text)` and insert the resulting vector into `brain_embeddings` table via `INSERT INTO brain_embeddings(id, embedding) VALUES (?, ?)`. Make embedding optional: if `isEmbeddingAvailable()` returns false, skip silently. Add `populateEmbeddings()` function for backfill of existing entries. Add batch processing with configurable chunk size (default 50).
- **Validation**: `npx tsc --noEmit`, integration test: observe -> verify embedding row exists in brain_embeddings

### WS-B5: Vector similarity search

- **Files**: `src/core/memory/brain-similarity.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-B3, WS-B4
- **What to do**: Implement `searchSimilar(query: string, limit?: number): Promise<SimilarityResult[]>` that: (1) embeds the query text, (2) runs KNN query: `SELECT id, distance FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`, (3) joins with observation/decision/pattern/learning tables to return full entries with similarity scores. Export `SimilarityResult` type with `{ id, distance, type, title, text }`. Include graceful fallback: if embedding unavailable, return empty array.
- **Validation**: `npx tsc --noEmit`, integration test: insert 3 observations with embeddings, query similar, verify ranked results

### WS-B6: Hybrid search merge

- **Files**: `src/core/memory/brain-search.ts` (extend)
- **Scope**: medium
- **Dependencies**: WS-B5, WS-B1
- **What to do**: Extend existing `searchBrainCompact()` to support hybrid mode. Add `hybridSearch(query: string, options?: { ftsWeight?: number, vecWeight?: number, graphWeight?: number, limit?: number }): Promise<HybridResult[]>`. Implementation: (1) run FTS5 search, (2) run vector similarity if available, (3) run graph neighbor expansion if relevant node found, (4) normalize scores to 0-1 range using percentile ranking, (5) combine with configurable weights (default: fts=0.4, vec=0.4, graph=0.2), (6) deduplicate and return top-N. Graceful fallback: if vec unavailable, redistribute weight to FTS5.
- **Validation**: `npx tsc --noEmit`, test with FTS-only fallback, test with all three sources

### WS-B7: reason.why causal trace (NO embedding dependency)

- **Files**: `src/core/memory/brain-reasoning.ts` (new)
- **Scope**: medium
- **Dependencies**: None (uses existing task deps + brain_memory_links)
- **What to do**: Implement `reasonWhy(taskId: string): Promise<CausalTrace>` that: (1) loads task and its dependencies from tasks.db, (2) traverses dependency chain recursively, (3) for each task in chain, looks up brain_decisions and brain_memory_links for context, (4) builds a trace object: `{ taskId, blockers: Array<{ taskId, status, reason?, decisions: Decision[] }>, rootCauses: string[] }`. Depth limit: 10 levels. Cycle detection via visited set.
- **Validation**: `npx tsc --noEmit`, test with mock task chain

### WS-B8: reason.similar (depends on embeddings)

- **Files**: `src/core/memory/brain-reasoning.ts` (extend)
- **Scope**: small
- **Dependencies**: WS-B5
- **What to do**: Add `reasonSimilar(entryId: string, limit?: number): Promise<SimilarEntry[]>` that: (1) loads the entry's text from brain.db, (2) calls `searchSimilar()` from brain-similarity.ts, (3) filters out the source entry itself, (4) returns results. FTS5 fallback: if no embeddings, use FTS5 keyword overlap + label Jaccard similarity.
- **Validation**: `npx tsc --noEmit`, test with mock entries

### WS-B9: Memory-session bridge (NO embedding dependency)

- **Files**: `src/core/sessions/session-debrief.ts` (extend or create)
- **Scope**: small
- **Dependencies**: None
- **What to do**: Hook into session end flow. After session ends, auto-save a summary observation to brain.db via `observeBrain()` containing: session scope, tasks completed, key decisions made (query brain_decisions created during session time range). Populate session handoff data with relevant brain entries (recent observations from session timeframe). Integrate with existing `endSession()` flow — call after session state is saved but before returning.
- **Validation**: `npx tsc --noEmit`, test: start session -> end session -> verify brain observation created

### WS-B10: MCP wiring for reasoning ops (NO embedding dependency for reason.why)

- **Files**: `src/dispatch/domains/memory.ts`, registry
- **Scope**: small
- **Dependencies**: WS-B7, WS-B8
- **What to do**: Wire reasoning operations into memory domain: `memory.reason.why` (query), `memory.reason.similar` (query), `memory.reason.impact` (query — stub returning not-implemented for now), `memory.reason.timeline` (query — stub). Add to registry with proper operation definitions. Handler functions call brain-reasoning.ts methods.
- **Validation**: `npx tsc --noEmit`, dispatch test for reason.why

### WS-B11: Temporal decay

- **Files**: `src/core/memory/brain-lifecycle.ts` (new)
- **Scope**: small
- **Dependencies**: None
- **What to do**: Implement `applyTemporalDecay(options?: { decayRate?: number, olderThanDays?: number }): Promise<{ updated: number }>` that runs SQL UPDATE on brain_learnings to reduce confidence based on age. Formula: `new_confidence = confidence * (decayRate ^ daysSinceUpdate)`. Default decayRate: 0.995, default olderThanDays: 30. Also update brain_observations relevance scores. Wire as `memory.lifecycle.decay` mutate operation.
- **Validation**: `npx tsc --noEmit`, test: insert old learning, run decay, verify reduced confidence

### WS-B12: Memory consolidation

- **Files**: `src/core/memory/brain-lifecycle.ts` (extend)
- **Scope**: medium
- **Dependencies**: WS-B11
- **What to do**: Implement `consolidateMemories(options?: { olderThanDays?: number, minClusterSize?: number }): Promise<ConsolidationResult>`. Steps: (1) find observations older than threshold (default 90 days), (2) group by topic using FTS5 similarity, (3) merge groups into summary observations, (4) archive originals (set archived flag), (5) return stats: { grouped, merged, archived }. Wire as `memory.lifecycle.consolidate` mutate operation.
- **Validation**: `npx tsc --noEmit`, test: insert 5 old similar observations, consolidate, verify 1 summary + 5 archived

### WS-B13: claude-mem migration CLI wiring

- **Files**: `src/cli/commands/migrate.ts` (extend)
- **Scope**: small
- **Dependencies**: None
- **What to do**: Wire existing `migrateClaudeMem()` from `src/core/memory/claude-mem-migration.ts` to CLI. Add `cleo migrate claude-mem` subcommand. Options: `--dry-run` (preview without writing), `--batch-size N` (default from existing code). Display progress: imported count, skipped count, errors. Also wire as `memory.migrate.claude-mem` mutate operation in dispatch.
- **Validation**: `npx tsc --noEmit`, test: CLI command --dry-run executes without error

### WS-B14: Spec and docs updates

- **Files**: `docs/specs/CLEO-BRAIN-SPECIFICATION.md`, `docs/concepts/cognitive-architecture.md` (if exists)
- **Scope**: small
- **Dependencies**: WS-B6, WS-B10 (document what's implemented)
- **What to do**: Update CLEO-BRAIN-SPECIFICATION.md with: (1) Phase 3 status (vector search, PageIndex, hybrid), (2) Phase 4 status (reasoning ops, session bridge), (3) New operation list with domain.operation format, (4) Embedding model choice and rationale, (5) PageIndex node/edge types. Update operation counts in AGENTS.md if registry totals changed.
- **Validation**: No broken markdown links, spec version bumped

### WS-B15: E2E brain lifecycle tests

- **Files**: `tests/e2e/brain-lifecycle.test.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-B6, WS-B10, WS-B12
- **What to do**: End-to-end test covering: (1) observe -> search via FTS5 -> verify found, (2) observe -> embed -> search via vector similarity -> verify found, (3) add graph node + edges -> query neighbors -> verify graph traversal, (4) reason.why on task chain -> verify trace, (5) consolidate old observations -> verify summary created, (6) temporal decay -> verify reduced confidence. Use real brain.db (in-memory SQLite).
- **Validation**: `npx vitest run tests/e2e/brain-lifecycle.test.ts` — all tests pass

---

## Workstream C: Warp/Protocol Chains

**Goal**: Define WarpChain type system, build the default RCASD chain from existing constants, implement chain validation, storage, instantiation, execution tracking, and MCP operations.

**Total tasks**: 9

### WS-C1: Define WarpChain type system

- **Files**: `src/types/warp-chain.ts` (new)
- **Scope**: small
- **Dependencies**: None
- **What to do**: Define all TypeScript interfaces: `WarpStage` (id, name, category, skippable), `WarpLink` (union: linear | fork | branch), `ChainShape` (stages, links, entryPoint, exitPoints), `GateContract` (id, name, type, stageId, position, check, severity, canForce), `GateCheck` (union: stage_complete | artifact_exists | protocol_valid | verification_gate | custom), `WarpChain` (id, name, version, description, shape, gates, tessera?, validation?), `WarpChainInstance` (chainId, epicId, variables, stageToTask, createdAt, createdBy), `WarpChainExecution` (instanceId, currentStage, gateResults, status, startedAt, completedAt?), `ChainValidation` (wellFormed, gateSatisfiable, artifactComplete, errors, warnings). Import Stage type from lifecycle/stages.ts, GateName from validation/verification.ts, ProtocolType from orchestration/protocol-validators.ts. Export all types.
- **Validation**: `npx tsc --noEmit` — all types compile cleanly

### WS-C2: Build default RCASD-IVTR+C WarpChain

- **Files**: `src/core/lifecycle/default-chain.ts` (new)
- **Scope**: small
- **Dependencies**: WS-C1
- **What to do**: Implement `buildDefaultChain(): WarpChain` that constructs the canonical 9-stage RCASD-IVTR+C chain from existing constants: `PIPELINE_STAGES` (stages.ts), `STAGE_PREREQUISITES` (stages.ts), `STAGE_DEFINITIONS` (stages.ts), `VERIFICATION_GATE_ORDER` (verification.ts). Map: each prerequisite -> entry GateContract with check type `stage_complete`. Each verification gate -> exit GateContract at implementation stage with check type `verification_gate`. Each protocol type -> stage-specific GateContract with check type `protocol_valid`. All links are linear (9 stages in sequence). Export `DEFAULT_CHAIN_ID = 'rcasd-ivtrc'`.
- **Validation**: `npx tsc --noEmit`, test (WS-C3)

### WS-C3: Default chain tests

- **Files**: `src/core/lifecycle/__tests__/default-chain.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-C2
- **What to do**: Tests: (1) default chain has 9 stages, (2) default chain has 8 linear links, (3) entry point is 'research', exit point is 'release', (4) every STAGE_PREREQUISITE is represented as an entry gate, (5) every VERIFICATION_GATE_ORDER gate is represented, (6) default chain validates as well-formed (use WS-C4 validator or manual check). Import `buildDefaultChain` and verify structure.
- **Validation**: `npx vitest run src/core/lifecycle/__tests__/default-chain.test.ts` — all tests pass

### WS-C4: Chain validation engine

- **Files**: `src/core/validation/chain-validation.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-C1
- **What to do**: Implement: (1) `validateChainShape(shape: ChainShape): string[]` — check: all link source/target IDs exist in stages, entryPoint exists, all exitPoints exist, no cycles (topological sort check), all stages reachable from entryPoint. (2) `validateGateSatisfiability(chain: WarpChain): string[]` — every gate references an existing stage, every `stage_complete` check references existing stages, every `verification_gate` check references valid gate names. (3) `validateChain(chain: WarpChain): ChainValidation` — orchestrates both checks, returns ChainValidation with wellFormed, gateSatisfiable, artifactComplete flags plus errors/warnings arrays.
- **Validation**: `npx tsc --noEmit`, tests (WS-C5)

### WS-C5: Chain validation tests

- **Files**: `src/core/validation/__tests__/chain-validation.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-C4
- **What to do**: Tests: (1) valid linear chain passes all checks, (2) chain with cycle detected (A->B->C->A), (3) chain with unreachable stage detected, (4) chain with nonexistent link target detected, (5) gate referencing nonexistent stage detected, (6) default RCASD chain passes validation, (7) fork chain with join validates correctly, (8) empty chain fails validation. Build test chains inline.
- **Validation**: `npx vitest run src/core/validation/__tests__/chain-validation.test.ts` — all tests pass

### WS-C6: Chain storage (Drizzle schema + CRUD)

- **Files**: `src/store/chain-schema.ts` (new), `src/core/lifecycle/chain-store.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-C1, WS-C4
- **What to do**: (1) Create Drizzle schema for `warp_chains` table: id (text PK), name (text), version (text), description (text), definition (text — JSON serialized WarpChain), validated (integer — 0/1), createdAt (text), updatedAt (text). Create `warp_chain_instances` table: id (text PK), chainId (text FK), epicId (text), variables (text — JSON), stageToTask (text — JSON), status (text), currentStage (text), gateResults (text — JSON), createdAt (text), updatedAt (text). (2) Run `npx drizzle-kit generate` for migration. (3) Implement CRUD in chain-store.ts: `addChain(chain: WarpChain)` — validate first, then store. `showChain(id)`, `listChains()`, `findChains(criteria)`. (4) Implement instance CRUD: `createInstance(chainId, epicId, variables, stageToTask)`, `showInstance(id)`, `advanceInstance(id, nextStage, gateResults)`.
- **Validation**: `npx tsc --noEmit`, `npx drizzle-kit generate` produces valid migration, integration tests

### WS-C7: Chain storage tests

- **Files**: `src/core/lifecycle/__tests__/chain-store.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-C6
- **What to do**: Tests: (1) addChain stores and retrieves valid chain, (2) addChain rejects invalid chain (validation fails), (3) showChain returns null for nonexistent, (4) listChains returns all stored chains, (5) createInstance binds chain to epic, (6) advanceInstance updates currentStage and gateResults, (7) showInstance returns full state. Use in-memory SQLite.
- **Validation**: `npx vitest run src/core/lifecycle/__tests__/chain-store.test.ts` — all tests pass

### WS-C8: MCP operations wiring for WarpChain

- **Files**: `src/dispatch/domains/pipeline.ts`, `src/dispatch/domains/check.ts`, `src/dispatch/domains/orchestrate.ts` (if needed), registry
- **Scope**: medium
- **Dependencies**: WS-C6
- **What to do**: Wire 11 new operations into dispatch: Pipeline domain (8): `pipeline.chain.show` (query), `pipeline.chain.list` (query), `pipeline.chain.find` (query), `pipeline.chain.add` (mutate), `pipeline.chain.instantiate` (mutate), `pipeline.chain.advance` (mutate), `pipeline.chain.gate.pass` (mutate), `pipeline.chain.gate.fail` (mutate). Check domain (2): `check.chain.validate` (query), `check.chain.gate` (query). Orchestrate domain (1): `orchestrate.chain.plan` (query). Add all 11 to registry with proper OperationDef entries. Handler functions delegate to chain-store.ts and chain-validation.ts.
- **Validation**: `npx tsc --noEmit`, dispatch test: query pipeline.chain.show returns chain

### WS-C9: Chain composition operators

- **Files**: `src/core/lifecycle/chain-composition.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-C1, WS-C4
- **What to do**: Implement: (1) `sequenceChains(a: WarpChain, b: WarpChain): WarpChain` — connect A's exit to B's entry, merge stages (prefix IDs to avoid collision), merge gates, validate result. (2) `parallelChains(chains: WarpChain[], joinStage: WarpStage): WarpChain` — create fork from common entry to all chain entries, join all exits at joinStage, merge stages and gates. (3) Both functions call `validateChain()` on the result and throw if invalid. Export composition functions.
- **Validation**: `npx tsc --noEmit`, test: sequence two 3-stage chains -> 6-stage chain validates. Parallel two chains -> fork/join validates.

---

## Workstream D: MEOW Declarative Workflows

**Goal**: Define declarative workflow format, implement Tessera integration, build composition engine, wire into orchestrate domain.

**Total tasks**: 5

### WS-D1: Tessera type definitions and template format

- **Files**: `src/types/tessera.ts` (new)
- **Scope**: small
- **Dependencies**: WS-C1 (needs WarpChain types)
- **What to do**: Define: `TesseraTemplate` (extends WarpChain with template-specific fields: `variables: Record<string, TesseraVariable>`, `archetypes: string[]`, `defaultValues: Record<string, unknown>`, `description: string`, `category: 'lifecycle' | 'hotfix' | 'research' | 'security-audit' | 'custom'`). `TesseraVariable` (name, type: 'string' | 'number' | 'boolean' | 'taskId' | 'epicId', description, required, default?). `TesseraInstantiationInput` (templateId, epicId, variables: Record<string, unknown>). Export all types.
- **Validation**: `npx tsc --noEmit`

### WS-D2: Tessera instantiation engine

- **Files**: `src/core/lifecycle/tessera-engine.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-D1, WS-C4 (needs chain validation), WS-C6 (needs chain storage)
- **What to do**: Implement `instantiateTessera(template: TesseraTemplate, input: TesseraInstantiationInput): WarpChainInstance`. Steps: (1) validate all required variables provided, (2) resolve variables with defaults, (3) construct concrete WarpChain by applying variable substitution, (4) validate the resulting chain, (5) create WarpChainInstance via chain-store.ts, (6) return instance. Also implement `listTesseraTemplates()` and `showTessera(id)` for browsing. Register the default RCASD Tessera.
- **Validation**: `npx tsc --noEmit`, test: instantiate default template for an epic -> valid instance created

### WS-D3: Tessera tests

- **Files**: `src/core/lifecycle/__tests__/tessera-engine.test.ts` (new)
- **Scope**: small
- **Dependencies**: WS-D2
- **What to do**: Tests: (1) instantiate default RCASD template -> valid instance, (2) missing required variable -> error, (3) default values applied when variable not provided, (4) invalid variable type -> error, (5) listTesseraTemplates returns default template, (6) showTessera returns template by ID.
- **Validation**: `npx vitest run src/core/lifecycle/__tests__/tessera-engine.test.ts` — all tests pass

### WS-D4: Orchestrate domain integration for Tessera

- **Files**: `src/dispatch/domains/orchestrate.ts`, registry
- **Scope**: small
- **Dependencies**: WS-D2, WS-C8
- **What to do**: Wire Tessera operations: `orchestrate.tessera.show` (query), `orchestrate.tessera.list` (query), `orchestrate.tessera.instantiate` (mutate — creates chain instance from template). Add 3 new operations to registry. Handler functions delegate to tessera-engine.ts. The `orchestrate.chain.plan` from WS-C8 already handles wave generation from chain instances.
- **Validation**: `npx tsc --noEmit`, dispatch test: query orchestrate.tessera.list returns templates

### WS-D5: Workflow composition E2E test

- **Files**: `tests/e2e/warp-workflow.test.ts` (new)
- **Scope**: medium
- **Dependencies**: WS-C8, WS-C9, WS-D4
- **What to do**: End-to-end test covering full lifecycle: (1) List tessera templates -> find default RCASD, (2) Instantiate template for a test epic -> get chain instance, (3) Validate chain instance, (4) Advance through first 3 stages with gate checks, (5) Generate wave plan from chain instance, (6) Compose two custom chains -> validate composed result, (7) Clean up test data. Use real dispatch pipeline (in-memory DBs).
- **Validation**: `npx vitest run tests/e2e/warp-workflow.test.ts` — all tests pass

---

## Cross-Workstream Dependencies

```
WS-A (Hooks) ──────────────────────────────────────────────────────────────────
  A1 (fix guards) ──> A2 (tests)
  A3 (payload types) ──> A4 (onError) ──> A5 (tests)
                     ──> A6 (onFileChange) ──> A7 (tests)
                     ──> A8 (onPrompt/Response) ──> A9 (tests)

WS-B (BRAIN) ──────────────────────────────────────────────────────────────────
  B1 (PageIndex CRUD) ──> B2a (tests), B2b (domain wiring)
  B3 (embedding model) ──> B4 (population) ──> B5 (vec search) ──> B6 (hybrid)
  B7 (reason.why) ──> B10 (MCP wiring)
  B8 (reason.similar) requires B5 ──> B10
  B9 (session bridge) — independent
  B11 (decay) ──> B12 (consolidation)
  B13 (claude-mem CLI) — independent
  B14 (docs) requires B6, B10
  B15 (E2E) requires B6, B10, B12

WS-C (Warp) ──────────────────────────────────────────────────────────────────
  C1 (types) ──> C2 (default chain) ──> C3 (tests)
             ──> C4 (validation) ──> C5 (tests)
             ──> C6 (storage) ──> C7 (tests) ──> C8 (MCP wiring)
             ──> C9 (composition)

WS-D (MEOW) ──────────────────────────────────────────────────────────────────
  D1 (tessera types) requires C1 ──> D2 (engine) requires C4, C6 ──> D3 (tests)
                                                                  ──> D4 (orchestrate wiring)
  D5 (E2E) requires C8, C9, D4

Cross-workstream:
  Hooks A4 (onError) is independent of Warp — no cross-dependency
  Hooks A8 (onPrompt/Response) is independent of Warp
  BRAIN B1 (PageIndex) is independent of Warp
  BRAIN B3 (embeddings) is independent of Warp
  Warp C1 (types) is independent of everything
  MEOW D1 depends on Warp C1 (WarpChain types)
  MEOW D2 depends on Warp C4 (validation) and C6 (storage)
  BRAIN B6 (hybrid search) could later index WarpChain definitions, but NOT a blocker
```

---

## Implementation Waves

### Wave 1: Foundations (all independent, fully parallel)
| Task | Workstream | Rationale |
|------|-----------|-----------|
| WS-A1 | Hooks | Quick win, zero deps |
| WS-A3 | Hooks | Payload types needed by A4/A6/A8 |
| WS-B1 | BRAIN | PageIndex CRUD, zero deps |
| WS-B3 | BRAIN | Embedding model selection (start early, long pole) |
| WS-B7 | BRAIN | reason.why, no embedding dep |
| WS-B9 | BRAIN | Session bridge, no deps |
| WS-B11 | BRAIN | Temporal decay, no deps |
| WS-B13 | BRAIN | claude-mem CLI, no deps |
| WS-C1 | Warp | Type definitions, zero deps |

### Wave 2: First dependents (depends on Wave 1)
| Task | Workstream | Depends On |
|------|-----------|------------|
| WS-A2 | Hooks | A1 |
| WS-A4 | Hooks | A3 |
| WS-A6 | Hooks | A3 |
| WS-A8 | Hooks | A3 |
| WS-B2a | BRAIN | B1 |
| WS-B2b | BRAIN | B1 |
| WS-B4 | BRAIN | B3 |
| WS-B12 | BRAIN | B11 |
| WS-C2 | Warp | C1 |
| WS-C4 | Warp | C1 |
| WS-D1 | MEOW | C1 |

### Wave 3: Second dependents
| Task | Workstream | Depends On |
|------|-----------|------------|
| WS-A5 | Hooks | A4 |
| WS-A7 | Hooks | A6 |
| WS-A9 | Hooks | A8 |
| WS-B5 | BRAIN | B4 |
| WS-B10 | BRAIN | B7, B8 (partial: wire reason.why even if similar not ready) |
| WS-C3 | Warp | C2 |
| WS-C5 | Warp | C4 |
| WS-C6 | Warp | C1, C4 |
| WS-C9 | Warp | C1, C4 |

### Wave 4: Integration
| Task | Workstream | Depends On |
|------|-----------|------------|
| WS-B6 | BRAIN | B5, B1 |
| WS-B8 | BRAIN | B5 |
| WS-C7 | Warp | C6 |
| WS-C8 | Warp | C6 |
| WS-D2 | MEOW | D1, C4, C6 |

### Wave 5: Final integration and tests
| Task | Workstream | Depends On |
|------|-----------|------------|
| WS-B14 | BRAIN | B6, B10 |
| WS-B15 | BRAIN | B6, B10, B12 |
| WS-D3 | MEOW | D2 |
| WS-D4 | MEOW | D2, C8 |

### Wave 6: E2E and polish
| Task | Workstream | Depends On |
|------|-----------|------------|
| WS-D5 | MEOW | C8, C9, D4 |

---

## Summary

| Workstream | Tasks | Small | Medium | Large |
|------------|-------|-------|--------|-------|
| A: Hooks | 9 | 6 | 3 | 0 |
| B: BRAIN | 15 | 8 | 5 | 1 (embeddings) |
| C: Warp | 9 | 4 | 4 | 0 (storage is medium) |
| D: MEOW | 5 | 2 | 2 | 0 (E2E is medium) |
| **Total** | **38** | **20** | **14** | **1** |

**Critical path**: WS-B3 (embedding model) -> WS-B4 -> WS-B5 -> WS-B6 (hybrid search)
**Longest chain**: 6 waves to full completion
**Immediate parallelism**: 9 tasks can start simultaneously in Wave 1
