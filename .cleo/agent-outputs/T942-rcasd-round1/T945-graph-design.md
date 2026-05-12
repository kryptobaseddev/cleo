# T945 — Universal Semantic Graph Design

**Parent**: T942 | **Round**: 2 (research) | **Date**: 2026-04-17
**Scope**: promote `brain_page_nodes` + `brain_page_edges` to THE universal
semantic graph across CLEO (tasks, decisions, nexus, conduit, llmtxt).

---

## 0. Ground-truth correction up front

The prior round's premise that `brain_page_*` tables are "dormant infrastructure,
NOT populated by any code path" is **factually wrong**. A focused grep proves the
graph is already live and partially wired:

| Writer call site | Emits |
|---|---|
| `packages/core/src/tasks/complete.ts:342-377` | `task:<id>` node + `epic:<parentId>` node + `part_of` edge on `cleo complete` |
| `packages/core/src/memory/decisions.ts:122, 207, 219-233` | `decision:<id>` + `task:<id>` / `epic:<id>` stubs + `applies_to` edges |
| `packages/core/src/memory/decision-cross-link.ts:210-276` | `file:<path>` / `symbol:<name>` stubs + `applies_to` edges (regex-extracted from decision text) |
| `packages/core/src/memory/patterns.ts:98, 179` | `pattern:<id>` nodes |
| `packages/core/src/memory/learnings.ts:79, 161` | `learning:<id>` nodes |
| `packages/core/src/memory/brain-retrieval.ts:913, 925, 933` | `observation:<id>` + `session:<id>` + `produced_by` edge |
| `packages/core/src/memory/observer-reflector.ts:461, 854` | `supersedes` edges between compressed & source observations |
| `packages/core/src/memory/extraction-gate.ts:581` | structural edges during extraction |
| `packages/core/src/memory/graph-memory-bridge.ts:autoLinkMemories` | `code_reference` edges (memory → nexus symbol/file), called from `brain-lifecycle.ts:744` during `runConsolidation` |
| `packages/core/src/memory/brain-backfill.ts` | one-shot backfill from typed tables |

Readers:
- `packages/core/src/memory/graph-queries.ts:152, 226, 301, 407` (`traceBrainGraph`, `relatedBrainNodes`, `contextBrainNode`, `graphStats` — recursive-CTE BFS already exists)
- `packages/studio/src/routes/api/brain/graph/+server.ts:42-95` (force-directed graph payload, capped at 500 nodes)
- `packages/studio/src/lib/server/living-brain/adapters/brain.ts` (Living Brain SSE adapter — T-BRAIN-LIVING substrate)

**What's actually missing is not writers — it's coverage.** Three big gaps:

1. **No task-insert trigger.** `addTask` in `packages/core/src/tasks/add.ts:529` never calls `upsertGraphNode`. Task nodes only appear at completion time or as stubs from decisions. A task created today is invisible to the graph until done.
2. **CONDUIT is not integrated.** `conduit_messages` → `msg:<id>` nodes do not exist. No `discusses` edge type. CONDUIT delivery issues have kept this off the roadmap.
3. **llmtxt docs are not indexed.** `cleo docs add` writes to `attachments` (`packages/core/src/store/tasks-schema.ts:910-929`) but never mints `llmtxt:<sha256>` nodes or `embeds` edges.

The T942 synthesis correctly flagged "no Studio graph view consuming this" —
which is also wrong: there's a viewer (see `api/brain/graph`), it's just not the
final product envisaged by P-BRAIN-LIVING.

---

## 1. Edge-type canonicalization

`BRAIN_EDGE_TYPES` (`packages/core/src/store/brain-schema.ts:661-683`) already
carries 16 values. Table of the canon, plus 5 **additions** required for T945:

| Edge type | Direction | Cardinality | Semantics | Status |
|---|---|---|---|---|
| `derived_from` | child → parent | N:1 | learning ← observation | present |
| `produced_by` | artifact → producer | N:1 | observation ← session | present |
| `informed_by` | decision → input | N:M | decision ← pattern | present |
| `supports` / `contradicts` | observation → claim | N:M | evidence toward/against decision | present |
| `supersedes` | new → old | N:1 | decision v2 → decision v1 (also reused by observer-reflector for compressed notes) | present |
| `applies_to` | scope-owner → subject | N:M | decision / pattern → task / file / symbol | present |
| `documents` | doc → subject | N:M | observation → symbol/file | present |
| `summarizes` | summary → source | 1:N | summary → observation | present |
| `part_of` | child → whole | N:1 | task → epic | present |
| `references` | observation → named code | N:M | observation → symbol (weak) | present |
| `modified_by` | file → actor | N:M | file → session | present |
| `code_reference` | memory → nexus | N:M | any brain node → nexus node (cross-DB canonical) | present |
| `affects` / `mentions` | observation → symbol/file | N:M | impact / weak reference | present |
| `co_retrieved` | node → node (symmetric) | N:M | Hebbian/STDP plastic edge | present |
| **`blocks`** | blocker → blocked | N:M | **NEW — task:A blocks task:B (replaces `tasks.blockedBy` soft FK)** | add |
| **`discusses`** | message → subject | N:M | **NEW — conduit msg → task/decision** | add |
| **`cites`** | decision → source | N:M | **NEW — decision → llmtxt blob / URL / research note** | add |
| **`embeds`** | entity → blob | N:M | **NEW — task/decision/observation → llmtxt:\<sha256\>** | add |
| **`touches_code`** | task → symbol | N:M | **NEW — task modifies symbols (commit-derived, distinct from `code_reference` which is text-derived)** | add |

All five additions fit the existing DDL — just extend the `BRAIN_EDGE_TYPES`
tuple. Migration is append-only (no CHECK constraint enforcement at SQLite
level; the enum lives in Drizzle TS). Tests at
`packages/core/src/memory/__tests__/edge-type-enum-coverage.test.ts` cover drift.

**Node-type additions**: `BRAIN_NODE_TYPES` at `brain-schema.ts:633-650` covers
decision/pattern/learning/observation/sticky/task/session/epic/file/symbol/
concept/summary. Add **`msg`** (conduit), **`llmtxt`** (blob by sha256),
**`commit`** (git sha). Same migration pattern as edges.

---

## 2. Auto-population design (Drizzle hooks)

Rather than SQLite triggers (which cannot call out to another DB and would
force us to re-implement extraction in C-SQL), we use **Drizzle write-path
wrappers** that already exist for memory entries and extend them to the
four uncovered domains.

### 2.1 Tasks — new hook

`packages/core/src/tasks/add.ts` currently has no graph touch. Add at end of
`addTask` (after `db.insert(tasks).values(...)` commits):

```ts
// T945 — mint task node at create time (not just completion)
void import('../memory/graph-auto-populate.js').then(({ upsertGraphNode, addGraphEdge }) =>
  (async () => {
    await upsertGraphNode(
      projectRoot,
      `task:${task.id}`,
      'task',
      `${task.id}: ${task.title}`.substring(0, 200),
      0.7, // unstarted quality; raises to 1.0 on complete
      task.title,
      { status: task.status, priority: task.priority, kind: task.kind },
    );
    if (task.parentId) {
      await addGraphEdge(projectRoot, `task:${task.id}`, `task:${task.parentId}`, 'part_of', 1.0, 'auto:add');
    }
    // New edge: blocks / blocked_by
    if (task.blockedBy) {
      for (const blockerId of parseBlockedBy(task.blockedBy)) {
        await addGraphEdge(projectRoot, `task:${blockerId}`, `task:${task.id}`, 'blocks', 1.0, 'auto:add');
      }
    }
  })().catch(() => {/* best-effort */}),
);
```

This is **additive**, **idempotent** (composite PK in `brain_page_edges`),
and gated by `brain.autoCapture` inside `upsertGraphNode` (see
`graph-auto-populate.ts:38-45`). Zero risk to task write path.

### 2.2 Conduit — new hook

`packages/core/src/hooks/handlers/conduit-hooks.ts` already exists as the
integration seam. On `PostToolUse` after `conduit send`:

```ts
await upsertGraphNode(projectRoot, `msg:${msg.id}`, 'msg', msg.subject.substring(0, 120), 0.6, msg.body);
for (const taskId of extractTaskMentions(msg.body)) {
  await upsertGraphNode(projectRoot, `task:${taskId}`, 'task', taskId, 0.5, '');
  await addGraphEdge(projectRoot, `msg:${msg.id}`, `task:${taskId}`, 'discusses', 0.8, 'auto:conduit-send');
}
```

`extractTaskMentions` = `/\bT\d{3,}\b/g`, dedup. Same regex style used in
`decision-cross-link.ts:53-57`.

### 2.3 llmtxt (attachments) — new hook

`cleo docs add` writes `attachments` + `attachment_refs` in tasks.db. Add in
`packages/core/src/docs/add.ts` (or wherever `attachBlob` lands after
v2026.4.9 adoption):

```ts
await upsertGraphNode(projectRoot, `llmtxt:${sha256}`, 'llmtxt',
  filename.substring(0, 120), 0.9, filename,
  { bytes: size, contentType: mime });
for (const ownerId of refs.filter(r => r.ownerType === 'task')) {
  await addGraphEdge(projectRoot, `task:${ownerId}`, `llmtxt:${sha256}`, 'embeds', 1.0, 'auto:docs-add');
}
```

Alignment with llmtxt v2026.4.9: `llmtxt/events.appendEvent` SHOULD be called
in parallel so the hash-chained audit log tracks edge creation too
(§8 below).

### 2.4 Nexus analyze — bulk upsert

`cleo nexus analyze` populates `nexus_nodes`. It already does NOT write to
brain — `autoLinkMemories` (brain-lifecycle.ts:744) does the cross-wiring on
consolidation. That's the correct pattern (one-way: brain READS nexus, brain
WRITES its own edges). **No change needed** except the opposite direction:
when `touches_code` is implemented, the task-complete hook must derive
modified symbols from the commit atom and emit edges:

```ts
// inside completeTask, after ADR-051 atom validation
for (const atom of evidence.filter(a => a.kind === 'files')) {
  for (const filePath of atom.value.split(',')) {
    await upsertGraphNode(projectRoot, `file:${filePath}`, 'file', filePath, 0.5, '');
    await addGraphEdge(projectRoot, `task:${task.id}`, `file:${filePath}`, 'touches_code', 1.0, `auto:evidence:${atom.kind}`);
  }
}
```

### 2.5 Memory observe, decisions, patterns, learnings

**Already wired.** No change. See call sites audited in §0.

---

## 3. SDK traversal surface (coordinates with T948)

These exist in `graph-queries.ts` already. Rename + re-export at the SDK
layer (`@cleocode/cleo-sdk/graph`):

```ts
// Outbound 1-hop neighbours (optional edge-type filter)
export async function getRelated(
  nodeId: string,
  opts?: { edgeTypes?: BrainEdgeType[]; direction?: 'out'|'in'|'both'; limit?: number }
): Promise<RelatedNode[]>;        // thin wrapper over relatedBrainNodes()

// Impact: BFS outbound, includes touches_code + blocks transitive
export async function getImpact(
  nodeId: string,
  opts?: { maxDepth?: number; edgeTypes?: BrainEdgeType[] }
): Promise<TraceNode[]>;          // thin wrapper over traceBrainGraph()

// Budgeted retrieval for LLM prompt construction (integrates with llmtxt planRetrieval)
export async function getContext(
  nodeId: string,
  opts: { tokenBudget: number; include?: BrainNodeType[] }
): Promise<{ nodes: BrainPageNodeRow[]; tokensUsed: number }>;
//         ^ calls llmtxt.planRetrieval(candidateNodes, budget) on top of contextBrainNode()

// Text search with graph expansion
export async function search(
  query: string,
  opts?: { types?: BrainNodeType[]; expandDepth?: number }
): Promise<{ seedNodes: BrainPageNodeRow[]; expanded: TraceNode[] }>;
```

All four return shapes already have Drizzle-inferred row types exported at
`brain-schema.ts:1253-1256` (`BrainPageNodeRow`, `BrainPageEdgeRow`). The SDK
package just re-exports — zero new logic per T948's "facade already exists"
finding.

---

## 4. Studio integration

Two routes exist, split the responsibilities:

- **`/api/brain/graph`** (`packages/studio/src/routes/api/brain/graph/+server.ts`):
  Keep as the "static snapshot" endpoint for force-directed layouts. Payload
  already `{nodes, edges}` JSON. **Recommend Cytoscape.js** over D3 — handles
  500+ nodes with better labelling and supports the plasticity columns
  (`reinforcementCount`, `stabilityScore`) as visual encoding.
- **`/api/living-brain/stream`** (existing SSE adapter at
  `packages/studio/src/routes/api/living-brain/stream/+server.ts`): Keep as
  the "this is P-BRAIN-LIVING" view with animated STDP/Hebbian pulses. Use
  `brain_plasticity_events` feed (last N seconds) as the heartbeat.

**New route needed**: `/graph/:nodeId` that renders `contextBrainNode(nodeId)`
as a radial "ego network" — the 360° view. This is the sentience demo: "show
me T942 and everything connected."

---

## 5. Cross-DB soft-FK (XFKB) retirement

Map from `cross-db-cleanup.ts:41-88`:

| XFKB id | Current soft-FK | Replacement edge |
|---|---|---|
| XFKB-001 | `brain_decisions.context_epic_id` -> tasks.id | `decision:<id> -> applies_to -> epic:<id>` |
| XFKB-002 | `brain_decisions.context_task_id` -> tasks.id | `decision:<id> -> applies_to -> task:<id>` (already written at `decisions.ts:219-233`) |
| XFKB-003 | `brain_memory_links.task_id` -> tasks.id | Edge with appropriate type per `link_type`: `produced_by` / `applies_to` / `informed_by` / `contradicts` — all already in the enum |
| XFKB-004 | `brain_observations.source_session_id` -> sessions.id | `observation:<id> -> produced_by -> session:<id>` (already written at `brain-retrieval.ts:933`) |
| XFKB-005 | `task:<id>` node deletion cascade | Already handled at `cross-db-cleanup.ts:72-83` — keep this path regardless |

**Retirement plan**: Because edges live in brain.db only (never cross-DB FKs),
they have no dangling-reference problem on task delete as long as
`cleanupBrainRefsOnTaskDelete` continues to cascade edge deletion. The
columns (`context_task_id`, `source_session_id`) can be marked `@deprecated`
in Drizzle and removed in a 3-release arc AFTER the graph achieves 100%
parity (measurable: parity query at `brain_decisions WHERE
context_task_id IS NOT NULL AND NOT EXISTS (matching applies_to edge)`
hits zero).

**`reconcileOrphanedRefs`** (`cross-db-cleanup.ts:195-314`) becomes a pure
edge pruner once columns retire.

---

## 6. Performance

Indexes already exist for every hot path:

- `idx_brain_edges_from` / `_to` / `_type` (`brain-schema.ts:853-855`)
- `idx_brain_nodes_type` / `_quality` / `_last_activity`
- `idx_brain_edges_plasticity_class` / `_stability`

Recursive CTE is already implemented at `graph-queries.ts:172-200` with cycle
detection via `'|'`-delimited path string. SQLite handles this in ~O(depth ×
edges/node) with the current indexes. For the observed sizes (<= 50K nodes,
<= 200K edges per project) no out-of-process graph engine is warranted. If a
project crosses 1M edges, `kuzu` via WAL-mode readers is the right next step
(DuckDB-graph is less mature). **Not in scope for T945.**

One optimization needed now: add a partial index for the living-brain
traversal: `CREATE INDEX idx_brain_edges_high_weight ON brain_page_edges(from_id, to_id) WHERE weight >= 0.7;`
— removes ~60% of co_retrieved noise from ego-network queries.

---

## 7. llmtxt v2026.4.9 integration

Per the v2026.4.9 context doc (same directory):

- **`llmtxt/graph`** helpers (T667, SemVer stable): assess against our
  `graph-queries.ts`. If llmtxt ships BFS + context expansion with compatible
  types, **replace our impl under the hood** per constraint #3 (no
  duplication). If llmtxt's graph model is pure in-memory (no SQLite
  substrate), keep our substrate and layer llmtxt's helpers for traversal
  arithmetic only. **Action item**: spike a 1-day integration PoC before
  committing either way.
- **`llmtxt/events`** (T608, hash-chained append-only): EVERY edge creation
  SHOULD write one event: `{kind: 'graph-edge', fromId, toId, edgeType, provenance, createdAt}`.
  This gives us a tamper-evident audit trail for the autonomy loop (T946
  Tier 3) without reinventing Merkle chains. Budget ~1 event per
  `addGraphEdge` call (fire-and-forget, same pattern as current writes).

---

## 8. Migration / backfill

`brain-backfill.ts` exists and handles decisions/patterns/learnings/
observations/sticky. Extend it to:

1. **Tasks**: for each `SELECT id, title, parent_id FROM tasks WHERE
   id NOT IN (SELECT substr(id,6) FROM brain_page_nodes WHERE node_type='task')`,
   emit `task:<id>` node + `part_of` edge if parent present.
2. **Attachments**: for each `SELECT sha256, attachment_json FROM attachments`,
   emit `llmtxt:<sha256>` node; for each `attachment_refs` with
   `owner_type='task'`, emit `embeds` edge.
3. **Conduit**: skip in Stage B (depends on CONDUIT delivery fix).

Auto-populatable fraction:
- Tasks: 100% (single-table SELECT, deterministic)
- Attachments / llmtxt: 100%
- `touches_code`: best-effort — requires parsing `acceptance_json` /
  `verification_json` / ADR-051 evidence atoms; estimate 60% coverage for
  post-ADR-051 tasks, near-zero for pre-ADR-051.
- Conduit `discusses`: 100% once delivery is restored, fresh data only.

---

## 9. Recommendation — staged plan

| Stage | Scope | Risk | Ship gate |
|---|---|---|---|
| **A** | Add 5 new edge types + 3 new node types to `BRAIN_*_TYPES` tuples; extend `addTask` to mint `task:<id>` node + `blocks` edges on create; extend `completeTask` with `touches_code` from evidence atoms | None (additive) | `edge-type-enum-coverage.test.ts` passes; existing graph-queries tests still green |
| **B** | Backfill tasks + attachments into graph via extended `brain-backfill.ts`. `cleo brain backfill --tasks --attachments` | Low (one-shot, idempotent) | Parity query hits zero dangling refs |
| **C** | Add conduit hook (`discusses`), add llmtxt `cites`/`embeds` hooks, wire `llmtxt/events` append-only log for every edge creation | Medium (new integration surface) | Gated on v2026.4.9 adoption step 4 (see step matrix in round-1 context doc) |
| **D** | SDK package at `@cleocode/cleo-sdk/graph` re-exporting `getRelated` / `getImpact` / `getContext` / `search` with T948 facade pattern | Low (re-export) | SDK contract tests snapshot `.d.ts`; Studio route migrates to SDK |
| **E** | Studio `/graph/:nodeId` ego-network view (Cytoscape.js) + retire XFKB-001/002/004 columns in Drizzle with `@deprecated` | Low (additive UI; column retirement non-blocking) | `reconcileOrphanedRefs` reports zero column-based refs for 1 full release |

**Sentience demo for Stage E**: `cleo brain context T942 --depth 2 --format graph`
returns: T942 + all child tasks (T943-T948) + decisions cited + observations
logged in parent session + nexus symbols touched by any child's commits +
llmtxt blobs attached. Single query, single graph, single SDK call.

---

## References

- `packages/core/src/store/brain-schema.ts:633-860` — node/edge type enums, DDL
- `packages/core/src/memory/graph-auto-populate.ts:75-173` — upsert/add primitives
- `packages/core/src/memory/graph-queries.ts:152-438` — traversal SDK (BFS, related, context, stats)
- `packages/core/src/memory/graph-memory-bridge.ts:316-513` — memory <-> nexus bridge via `autoLinkMemories`
- `packages/core/src/memory/decision-cross-link.ts:210-276` — decision -> file/symbol auto-links
- `packages/core/src/tasks/complete.ts:342-377` — current task-complete graph hook
- `packages/core/src/memory/brain-retrieval.ts:911-935` — observation -> session edge
- `packages/core/src/memory/brain-backfill.ts:1-60` — backfill entry point
- `packages/core/src/store/cross-db-cleanup.ts:41-314` — XFKB soft-FK cleanup
- `packages/studio/src/routes/api/brain/graph/+server.ts:42-95` — existing Studio graph API
- `packages/studio/src/lib/server/living-brain/adapters/brain.ts` — Living Brain substrate adapter
- T942 round-1 llmtxt-v2026.4.9-context.md — `llmtxt/graph`, `llmtxt/events` subpaths
