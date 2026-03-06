# Workstream B Audit (B1-B15 / T5383-T5398)

Date: 2026-03-05
Auditor: Workstream B
Scope: PageIndex + MCP wiring, embeddings provider/pipeline, vector similarity, hybrid search, reasoning ops, temporal decay, consolidation, session bridge, claude-mem wiring, operation-count spec update, E2E lifecycle coverage.

## Claim Matrix

| ID | Claim | Task(s) | Verdict | Evidence |
|---|---|---|---|---|
| B1 | PageIndex node/edge CRUD is implemented | T5383 | PASS | `src/store/brain-accessor.ts:410`, `src/store/brain-accessor.ts:473`, `src/store/brain-schema.ts:201`, `src/store/brain-schema.ts:212` |
| B2 | PageIndex is wired into memory domain handler | T5385 | PASS (dispatch) | `src/dispatch/domains/memory.ts:42`, `src/dispatch/domains/memory.ts:201`, `src/dispatch/domains/memory.ts:387`, `src/core/memory/engine-compat.ts:836`, `src/core/memory/engine-compat.ts:1008` |
| B3 | PageIndex MCP gateway wiring is complete | T5385 | FAIL | Gateway matrices omit graph ops: `src/mcp/gateways/__tests__/query.test.ts:71`, `src/mcp/gateways/__tests__/mutate.test.ts:51`; runtime probe rejects ops with `E_INVALID_OPERATION` (see executed tests/probes) |
| B4 | Embedding provider abstraction exists and is dimension-safe | T5386 | PASS | `src/core/memory/brain-embedding.ts:15`, `src/core/memory/brain-embedding.ts:25`, `src/core/memory/brain-embedding.ts:35`; validated by `src/core/memory/__tests__/brain-embedding.test.ts:96` |
| B5 | Embedding pipeline/backfill is implemented | T5387 | PASS | Inline ingest embedding at observe: `src/core/memory/brain-retrieval.ts:541`; backfill pipeline: `src/core/memory/brain-retrieval.ts:564`, `src/core/memory/brain-retrieval.ts:584` |
| B6 | Vector similarity search exists (vec0 + fallback behavior) | T5388 | PASS | `src/core/memory/brain-similarity.ts:4`, `src/core/memory/brain-similarity.ts:58`, `src/core/memory/brain-similarity.ts:84` |
| B7 | Hybrid search exists (FTS + vec + graph weighting) | T5389 | PASS | `src/core/memory/brain-search.ts:441`, `src/core/memory/brain-search.ts:480`, `src/core/memory/brain-search.ts:584` |
| B8 | `reason.why` causal tracing exists | T5390 | PASS | `src/core/memory/brain-reasoning.ts:4`, `src/core/memory/brain-reasoning.ts:52`, `src/dispatch/domains/memory.ts:222` |
| B9 | `reason.similar` exists with vector-first + FTS fallback | T5391 | PASS | `src/core/memory/brain-reasoning.ts:154`, `src/core/memory/brain-reasoning.ts:178`, `src/dispatch/domains/memory.ts:231` |
| B10 | Temporal decay exists for learnings | T5394 | PASS | `src/core/memory/brain-lifecycle.ts:25`, `src/core/memory/brain-lifecycle.ts:37`, `src/core/memory/brain-lifecycle.ts:61` |
| B11 | Memory consolidation exists for old observations | T5395 | PASS | `src/core/memory/brain-lifecycle.ts:79`, `src/core/memory/brain-lifecycle.ts:145`, `src/core/memory/brain-lifecycle.ts:245` |
| B12 | Session->memory bridge is wired in session end flow | T5392 | PASS | Bridge implementation: `src/core/sessions/session-memory-bridge.ts:31`; invoked during end-session: `src/core/sessions/index.ts:219` |
| B13 | claude-mem migration wiring is present (CLI + core) | T5396 | PASS | CLI registration: `src/cli/commands/migrate-claude-mem.ts:21`; core migration: `src/core/memory/claude-mem-migration.ts:124`; command wired in CLI: `src/cli/index.ts:287` |
| B14 | Spec/op-count update 207->256 is fully synchronized | T5397 | PARTIAL / FAIL | Runtime shows 256 ops (145+111) and AGENTS front-matter reflects this (`AGENTS.md:86`, `AGENTS.md:90`), but canonical/spec docs are stale: `docs/specs/CLEO-OPERATION-CONSTITUTION.md:437` (218), `docs/concepts/CLEO-VISION.md:221`, `docs/concepts/CLEO-VISION.md:526`, `AGENTS.md:358` (207) |
| B15 | E2E brain lifecycle tests exist and execute | T5398 | PASS | Lifecycle suite present: `tests/e2e/brain-lifecycle.test.ts:1` and all 6 scenarios pass (FTS, hybrid, graph traversal, reasonWhy, temporal decay, consolidation) |

## Executed Tests and Probes

### Targeted Vitest run

Command:

`npx vitest run src/store/__tests__/brain-accessor-pageindex.test.ts src/store/__tests__/brain-pageindex.test.ts src/core/memory/__tests__/brain-embedding.test.ts src/core/memory/__tests__/claude-mem-migration.test.ts src/mcp/gateways/__tests__/query.test.ts src/mcp/gateways/__tests__/mutate.test.ts tests/e2e/brain-lifecycle.test.ts`

Result: PASS

- 7 test files passed
- 170 tests passed
- Key files: PageIndex CRUD/tests, embedding provider tests, claude-mem migration tests, gateway matrix tests, E2E lifecycle tests

### Runtime matrix probe (operation counts)

Command:

`npx tsx -e "import { QUERY_OPERATIONS, getQueryOperationCount } from './src/mcp/gateways/query.ts'; import { MUTATE_OPERATIONS, getMutateOperationCount } from './src/mcp/gateways/mutate.ts'; console.log(JSON.stringify({queryTotal:getQueryOperationCount(), mutateTotal:getMutateOperationCount(), total:getQueryOperationCount()+getMutateOperationCount(), memoryQuery:QUERY_OPERATIONS.memory, memoryMutate:MUTATE_OPERATIONS.memory}, null, 2));"`

Result:

- `queryTotal=145`, `mutateTotal=111`, `total=256`
- Memory gateway ops are limited to 12 query + 6 mutate (no `graph.*`, `reason.*`, `search.hybrid`)

### Dispatch supported-ops probe

Command:

`npx tsx -e "import { MemoryHandler } from './src/dispatch/domains/memory.ts'; const h = new MemoryHandler(); console.log(JSON.stringify(h.getSupportedOperations(), null, 2));"`

Result:

- Dispatch handler supports `graph.show`, `graph.neighbors`, `reason.why`, `reason.similar`, `search.hybrid`, `graph.add`, `graph.remove`
- Confirms dispatch/gateway mismatch

### Gateway validation probe (new memory ops)

Command:

`npx tsx -e "import { validateQueryParams } from './src/mcp/gateways/query.ts'; import { validateMutateParams } from './src/mcp/gateways/mutate.ts'; const q = validateQueryParams({domain:'memory', operation:'reason.why', params:{taskId:'T1'}} as any); const m = validateMutateParams({domain:'memory', operation:'graph.add', params:{nodeId:'n1',nodeType:'task',label:'x'}} as any); console.log(JSON.stringify({reasonWhyValid:q.valid, reasonWhyError:q.error?.error?.code, graphAddValid:m.valid, graphAddError:m.error?.error?.code}, null, 2));"`

Result:

- `reason.why` -> `E_INVALID_OPERATION`
- `graph.add` -> `E_INVALID_OPERATION`

### Embedding pipeline + similarity runtime probe

Command:

`npx tsx -e "..."` (IIFE probe; provider registration + `populateEmbeddings` + `searchSimilar` + `reasonSimilar`)

Result:

- `populateEmbeddings`: `{ processed: 1, skipped: 0 }`
- `searchSimilar`: returns matches (`similarCount: 2`)
- `reasonSimilar`: returns results (`reasonCount: 1`)

### CLI wiring probe

Command:

`npx tsx src/cli/index.ts migrate claude-mem --help`

Result: command is registered and exposes expected options (`--dry-run`, `--source`, `--project`, `--batch-size`)

## Discrepancies

1. **MCP wiring gap for advanced memory ops**
   - Dispatch layer supports graph/reason/hybrid operations, but MCP gateway operation matrices do not include them.
   - Impact: ops cannot be called through canonical MCP `query/mutate` tools despite implementation.

2. **Spec/documentation count drift**
   - Runtime and AGENTS headline indicate 256 ops.
   - Constitution summary still states 218; CLEO-VISION and one AGENTS reference still state 207.
   - Impact: source-of-truth docs are inconsistent; claims of completed 207->256 spec update are only partially true.

3. **Test coverage asymmetry**
   - Strong E2E coverage exists for lifecycle scenarios (`tests/e2e/brain-lifecycle.test.ts`).
   - No dedicated unit tests found for `session-memory-bridge.ts` or direct MCP-level graph/reason/hybrid acceptance through gateway validation paths.
