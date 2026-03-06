# T5373 Validation Protocol (Child Tasks T5374-T5412)

## 1) Phase Breakdown

### Phase 0 - Intake and Claim Freeze
- Capture claim set: task IDs, claimed commit(s), claimed test outputs, and claimed files changed.
- Freeze verification target: verify against exact `HEAD` or supplied commit SHA (no moving target).
- Run baseline integrity checks before task-specific checks.

### Phase 1 - Static Evidence Validation
- Verify required files/symbols exist per claimed task.
- Verify operation registrations, type exports, and handler wiring are present where required.
- Verify dependency order constraints (task marked complete only if prerequisite claims are also evidenced).

### Phase 2 - Targeted Test Validation
- Execute task-scoped tests first (unit/integration/e2e per claim).
- If a claim references broad pass status, run minimally required suite for that workstream.
- Record exact command, exit code, and salient output lines for each executed check.

### Phase 3 - Runtime/Behavior Validation
- Run CLI/MCP behavioral probes for wiring claims (memory/chain/tessera ops, migrate command, hook dispatch surfaces).
- Validate stubs explicitly return expected non-implemented behavior where required.

### Phase 4 - Decision and Audit Recording
- Classify each task claim as `verified`, `partially verified`, or `unverified`.
- Attach evidence bundle: file checks + command results + discrepancy log.
- Escalate blocking inconsistencies per rules in Section 5.

## 2) Exact Evidence Checks Per Workstream

### Workstream A (Hooks) - T5374-T5382
- `T5374`: `src/core/hooks/handlers/task-hooks.ts` includes `isMissingBrainSchemaError` guard in both `handleToolStart` and `handleToolComplete` with swallow-only-for-schema behavior.
- `T5375`: `src/core/hooks/handlers/__tests__/task-hooks.test.ts` exists and defines 6 scenarios matching task claim.
- `T5376`: `src/core/hooks/types.ts` contains `OnFileChangePayload`, `OnErrorPayload`, `OnPromptSubmitPayload`, `OnResponseCompletePayload` and `CLEO_TO_CAAMP_HOOK_MAP` entries for `file.write`, `error.caught`, `prompt.submit`, `response.complete`.
- `T5377`: `src/dispatch/dispatcher.ts` emits `onError` dispatch on caught terminal errors; `src/core/hooks/handlers/error-hooks.ts` exists with `fromHook` loop guard and brain-schema swallow behavior; handler imported from `src/core/hooks/handlers/index.ts`.
- `T5378`: `src/core/hooks/handlers/__tests__/error-hooks.test.ts` exists; tests cover observe call, schema-error swallow, loop guard skip, and domain/operation propagation.
- `T5379`: `src/store/json.ts` dispatches `onFileChange` after successful save; `src/core/hooks/handlers/file-hooks.ts` exists with 5s dedupe map + relative path conversion + schema-error swallow; handler imported in index.
- `T5380`: `src/core/hooks/handlers/__tests__/file-hooks.test.ts` exists; tests include dedupe timing behavior, multi-file allowance, relative path conversion, schema-error swallow.
- `T5381`: `src/dispatch/adapters/mcp.ts` dispatches `onPromptSubmit` before dispatch and `onResponseComplete` after completion; `src/core/hooks/handlers/mcp-hooks.ts` has env-gated brain capture via `CLEO_BRAIN_CAPTURE_MCP`; index import present.
- `T5382`: `src/core/hooks/handlers/__tests__/mcp-hooks.test.ts` exists and validates default no-capture, env-enabled capture, and schema-error swallow when capture enabled.

### Workstream B (BRAIN) - T5383-T5398
- `T5383`: `src/store/brain-accessor.ts` has PageIndex CRUD (`add/get/remove node`, `add/get/remove edge`, `getNeighbors`) using brain page tables.
- `T5384`: `src/store/__tests__/brain-accessor-pageindex.test.ts` exists with 8 required CRUD/constraint cases.
- `T5385`: memory domain wiring includes `memory.graph.add.node`, `memory.graph.add.edge`, `memory.graph.show`, `memory.graph.neighbors`, `memory.graph.remove.node`, `memory.graph.remove.edge` with handler delegation.
- `T5386`: `src/core/memory/brain-embedding.ts` exists with lazy model load, `embedText(): Promise<Float32Array>` (384-dim), `isEmbeddingAvailable()`, env override `BRAIN_EMBEDDING_MODEL`; dependency declared in `package.json`.
- `T5387`: observation write path triggers embedding insert into `brain_embeddings`; backfill function `populateEmbeddings()` exists with chunk option.
- `T5388`: `src/core/memory/brain-similarity.ts` exists with embedding-driven similarity search + joined result metadata + graceful empty fallback when embeddings unavailable.
- `T5389`: hybrid search implementation in `src/core/memory/brain-search.ts` combines FTS/vector/graph with normalization, weights, dedupe, and vector-unavailable weight redistribution.
- `T5390`: `src/core/memory/brain-reasoning.ts` has `reasonWhy()` with dep traversal, cycle prevention, depth cap, and root-cause synthesis.
- `T5391`: `reasonSimilar()` exists and uses vector path when available with FTS/Jaccard fallback.
- `T5392`: session end flow writes brain summary observation and enriches handoff context with relevant entries.
- `T5393`: memory domain wiring includes `memory.reason.why`, `memory.reason.similar`, plus stubs `memory.reason.impact` and `memory.reason.timeline` returning explicit not-implemented semantics.
- `T5394`: `src/core/memory/brain-lifecycle.ts` provides `applyTemporalDecay()` and operation wiring `memory.lifecycle.decay`.
- `T5395`: consolidation logic exists in same lifecycle module with archival + summary generation and `memory.lifecycle.consolidate` wiring.
- `T5396`: CLI command path supports `cleo migrate claude-mem` with `--dry-run` and `--batch-size`; dispatch operation `memory.migrate.claude-mem` wired.
- `T5397`: `docs/specs/CLEO-BRAIN-SPECIFICATION.md` updated for phases/ops/model rationale/PageIndex; `AGENTS.md` operation counts updated if changed.
- `T5398`: `tests/e2e/brain-lifecycle.test.ts` exists and covers end-to-end lifecycle scenarios listed in claim.

### Workstream C (Warp/Protocol Chains) - T5399-T5407
- `T5407`: `src/types/warp-chain.ts` defines all claimed chain interfaces and canonical gate/check union types.
- `T5399`: `src/core/lifecycle/default-chain.ts` builds canonical RCASD-IVTR+C chain; exports `DEFAULT_CHAIN_ID = 'rcasd-ivtrc'`.
- `T5400`: `src/core/lifecycle/__tests__/default-chain.test.ts` exists and validates 9-stage topology plus prerequisite/gate coverage.
- `T5401`: `src/core/validation/chain-validation.ts` provides shape validation, gate satisfiability validation, and orchestrated `validateChain` result model.
- `T5402`: `src/core/validation/__tests__/chain-validation.test.ts` exists and includes cycle/unreachable/nonexistent/empty/fork-join/default-chain cases.
- `T5403`: `src/store/chain-schema.ts` exists with `warp_chains` and `warp_chain_instances`; migration artifacts generated by `drizzle-kit` (SQL + snapshot); `src/core/lifecycle/chain-store.ts` CRUD present.
- `T5404`: `src/core/lifecycle/__tests__/chain-store.test.ts` exists with storage/validation/instance progression scenarios.
- `T5405`: dispatch/registry includes 11 chain-related operations across pipeline/check/orchestrate domains with handler delegation.
- `T5406`: `src/core/lifecycle/chain-composition.ts` provides `sequenceChains` and `parallelChains` and validates composed output.

### Workstream D (MEOW/Tessera) - T5408-T5412
- `T5408`: `src/types/tessera.ts` exists with `TesseraTemplate`, `TesseraVariable`, `TesseraInstantiationInput` and category/type constraints.
- `T5409`: `src/core/lifecycle/tessera-engine.ts` provides `instantiateTessera`, `listTesseraTemplates`, `showTessera`, required/default/type validation, and default RCASD template registration.
- `T5410`: `src/core/lifecycle/__tests__/tessera-engine.test.ts` exists with six required behavior cases.
- `T5411`: dispatch wiring includes `orchestrate.tessera.show`, `orchestrate.tessera.list`, `orchestrate.tessera.instantiate` with engine delegation.
- `T5412`: `tests/e2e/warp-workflow.test.ts` exists with full workflow checks (template list, instantiate, validate, advance, wave plan, compose, cleanup).

## 3) Command Matrix for Verification

| Purpose | Command | Expected Evidence |
|---|---|---|
| Baseline type safety | `npx tsc --noEmit` | Exit 0; no TS errors across modified surfaces |
| Locate WS-A symbols/files | `rg -n "isMissingBrainSchemaError|onPromptSubmit|onResponseComplete|onFileChange|onError|CLEO_BRAIN_CAPTURE_MCP" src/core src/dispatch src/store` | Required hooks symbols present in expected modules |
| Validate WS-A tests | `npx vitest run src/core/hooks/handlers/__tests__/task-hooks.test.ts src/core/hooks/handlers/__tests__/error-hooks.test.ts src/core/hooks/handlers/__tests__/file-hooks.test.ts src/core/hooks/handlers/__tests__/mcp-hooks.test.ts` | All declared WS-A handler tests pass |
| Locate WS-B symbols/files | `rg -n "addPageNode|getNeighbors|embedText|isEmbeddingAvailable|populateEmbeddings|searchSimilar|hybridSearch|reasonWhy|reasonSimilar|applyTemporalDecay|consolidateMemories|migrate claude-mem|memory\.graph|memory\.reason|memory\.lifecycle" src tests docs package.json` | Core BRAIN APIs and operation wiring strings exist |
| Validate WS-B focused tests | `npx vitest run src/store/__tests__/brain-accessor-pageindex.test.ts tests/e2e/brain-lifecycle.test.ts` | PageIndex + BRAIN e2e tests pass |
| Probe WS-B CLI wiring | `node dist/cli/index.js migrate claude-mem --dry-run` | Command executes, reports preview stats, no crash |
| Locate WS-C symbols/files | `rg -n "WarpChain|buildDefaultChain|DEFAULT_CHAIN_ID|validateChainShape|validateGateSatisfiability|validateChain|warp_chains|warp_chain_instances|sequenceChains|parallelChains|pipeline\.chain|check\.chain|orchestrate\.chain\.plan" src tests drizzle` | Chain type/validation/storage/composition/wiring evidence present |
| Validate WS-C focused tests | `npx vitest run src/core/lifecycle/__tests__/default-chain.test.ts src/core/validation/__tests__/chain-validation.test.ts src/core/lifecycle/__tests__/chain-store.test.ts` | Core chain tests pass |
| Validate drizzle artifacts | `rg -n "warp_chains|warp_chain_instances" drizzle src/store` | Schema + migration output both present |
| Locate WS-D symbols/files | `rg -n "TesseraTemplate|instantiateTessera|listTesseraTemplates|showTessera|orchestrate\.tessera|warp-workflow" src tests` | Tessera type/engine/wiring/e2e symbols present |
| Validate WS-D focused tests | `npx vitest run src/core/lifecycle/__tests__/tessera-engine.test.ts tests/e2e/warp-workflow.test.ts` | Tessera unit + warp workflow e2e pass |
| Optional full confidence suite | `npx vitest run` | No regressions across global suite |

## 4) Acceptance Criteria

- `verified`: all required artifacts for a task are present, prerequisite claims are evidenced, all task-scoped required commands pass, and runtime behavior checks (if applicable) match claim text.
- `partially verified`: some core artifacts exist but at least one required behavior/test/wiring check fails or is missing; no contradictory evidence proving claim false.
- `unverified`: required artifact absent, command/test fails with direct contradiction, prerequisite not met, or claim cannot be reproduced at frozen revision.
- Task completion recommendation rule: mark complete only when status is `verified`; keep open for both `partially verified` and `unverified`.
- Epic readiness rule (T5373): each workstream must have zero `unverified` tasks and no unresolved prerequisite violations.

## 5) Escalation Rules for Discrepancies

- Severity `S1` (blocker): missing core schema/types, broken build (`tsc` fails), migration artifacts invalid/missing snapshot, or critical claimed operation absent -> immediately classify affected tasks `unverified`, open blocker issue, stop downstream dependent validation.
- Severity `S2` (major): task-scoped tests fail, handler wired but behavior mismatch, operation registered but wrong domain/verb -> classify `partially verified`, require remediation + re-run targeted matrix.
- Severity `S3` (minor): docs/version/count drift, non-critical log/progress text mismatch -> classify `partially verified` only if implementation is otherwise correct; track as follow-up documentation fix.
- Dependency escalation: if prerequisite task is `unverified`, all dependent completion claims are automatically capped at `partially verified` until prerequisite is corrected.
- Evidence conflict handling: when claim text conflicts with repository state or test output, repository state + executable output are authoritative; capture command transcript and file references in discrepancy log.
