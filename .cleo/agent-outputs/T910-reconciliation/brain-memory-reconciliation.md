# BRAIN vs Memory Reconciliation (T910)

**Date:** 2026-04-17
**Author:** system-architect subagent
**Scope:** Audit current codebase taxonomy against the operator's authoritative mental model.

---

## Operator's Authoritative Model

- **BRAIN** (super-domain) = the unified graph substrate of every NODE across NEXUS (code symbols), memory (observations/patterns/decisions/learnings), TASKS (task graph), CONDUIT (message flow), and SIGNALDOCK (agents). BRAIN is the complete graph of brain connections across all substrates.
- **memory** (subdomain of BRAIN) = observation/pattern/decision/learning store with tiers (`short` / `medium` / `long`).

---

## Executive Summary (5 bullets)

1. **The operator's BRAIN model is ALREADY implemented — just labelled wrong.** The Living Brain substrate API (`packages/studio/src/lib/server/living-brain/`) is, by contract, exactly the operator's BRAIN super-domain: it projects `LBNode`/`LBEdge` across the five substrates (`brain | nexus | tasks | conduit | signaldock`) with substrate-prefixed IDs. The work to build it was done; only the naming drifted.
2. **The current `brain` namespace (CLI, contracts, `brain.db`, `/api/brain/*`) is actually `memory`.** Every surface called `brain` today — the `brain.db` file, the 31-op contract file `packages/contracts/src/operations/brain.ts`, the dispatch routes, the studio REST endpoints `/api/brain/observations|decisions|graph|quality|tier-stats` — stores exclusively observations/patterns/decisions/learnings + the PageIndex graph. That is the memory subdomain per the operator's model.
3. **The CLI verb is `cleo memory ...` and aligned.** `CANONICAL_DOMAINS` (`packages/cleo/src/dispatch/types.ts:46-61`) has `memory` not `brain`. `cleo memory observe` dispatches correctly; a legacy `brain.observe` mutate is explicitly rejected (`memory-legacy-rejection.test.ts:90-91`). Keep this. The drift is mostly in internal artifact names, not in the public CLI verb.
4. **No `@cleocode/brain` package exists.** The 15 packages are `@cleocode/{adapters, agents, caamp, cant, cleo, cleo-os, contracts, core, lafs, nexus, playbooks, runtime, skills, studio}`. The substrate graph machinery lives inside `@cleocode/studio` — this is the right package only if BRAIN remains an HTTP-surface concept. If BRAIN becomes a CLI/programmatic domain too, it should move to `@cleocode/core`.
5. **Unified Node model is partially implemented.** `LBNode` (`packages/studio/src/lib/server/living-brain/types.ts:43-73`) is the unified node type but is scoped to the studio package. `packages/contracts/src/graph.ts` has a separate `GraphNodeKind` for NEXUS code intelligence. Two node-concept silos exist; they need a shared root.

---

## 1. Taxonomy Audit Table

| # | Artifact | Current name | Scope (per operator's model) | Correct? | Rename proposal |
|---|----------|--------------|------------------------------|----------|-----------------|
| 1 | `packages/core/src/memory/` | `memory` | memory (observations/patterns/decisions/learnings + graph) | YES aligned | — |
| 2 | `packages/core/src/memory/brain-*.ts` (14 files: `brain-lifecycle.ts`, `brain-retrieval.ts`, `brain-search.ts`, `brain-stdp.ts`, `brain-export.ts`, `brain-backfill.ts`, `brain-consolidator.ts`, `brain-embedding.ts`, `brain-links.ts`, `brain-maintenance.ts`, `brain-migration.ts`, `brain-plasticity-class.ts`, `brain-purge.ts`, `brain-reasoning.ts`, `brain-row-types.ts`, `brain-similarity.ts`) | `brain-*` | memory (all operate on brain.db memory tables) | NO drift | rename to `memory-*.ts` OR leave and treat "brain" as short-hand for "brain.db memory store" (document the convention) |
| 3 | `packages/core/src/store/brain-schema.ts` | `brain-schema` | memory SQLite schema (`brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_page_nodes`, `brain_page_edges`, `brain_memory_links`) | NO drift | rename to `memory-schema.ts` — but table names `brain_*` stay (migration cost too high) |
| 4 | `packages/core/src/store/brain-sqlite.ts` | `brain-sqlite` | memory SQLite connection | NO drift | rename to `memory-sqlite.ts` |
| 5 | `packages/core/src/store/brain-accessor.ts` | `brain-accessor` | memory data accessor | NO drift | rename to `memory-accessor.ts` |
| 6 | `.cleo/brain.db` | `brain.db` | memory store (observations, patterns, decisions, learnings, PageIndex graph) | NO drift | rename to `memory.db`; HIGH RISK — breaks 59+ files that literally reference the filename |
| 7 | `packages/contracts/src/brain.ts` | `brain` | memory type contracts (`BrainMemoryTier`, `BrainCognitiveType`, `BrainEntryRef`) | NO drift | rename to `memory.ts`, merge with existing memory-bridge types |
| 8 | `packages/contracts/src/memory.ts` | `memory` | memory bridge types (`.cleo/memory-bridge.md` shape) | YES aligned | keep; absorb content from `brain.ts` after rename |
| 9 | `packages/contracts/src/operations/brain.ts` | `brain` | memory operations (31 ops: observe, find, timeline, fetch, decision.*, pattern.*, learning.*, graph.*, reason.*, search.*, quality, code.*, llm-status, pending-verify, verify) | NO drift | RENAME to `operations/memory.ts`. Keep `brain.ts` slot for the future unified-substrate BRAIN ops |
| 10 | `packages/cleo/src/dispatch/domains/memory.ts` | `memory` handler | memory handler routes to brain.db ops | YES aligned | keep |
| 11 | `packages/cleo/src/dispatch/types.ts` `CANONICAL_DOMAINS` | contains `memory` (not `brain`) | memory CLI domain | YES aligned | keep. Adding `brain` as a NEW canonical domain (for unified graph) would bump the canon count from 14 → 15 |
| 12 | `packages/cleo/src/cli/commands/memory-brain.ts` | `memory-brain.ts` | implements `cleo memory *` verbs | mixed naming | rename file to `memory.ts` |
| 13 | `packages/cleo/src/cli/commands/memory-brain.ts` `export const memoryBrainCommand` | `memoryBrainCommand` | CLI command tree for `cleo memory ...` | mixed naming | rename to `memoryCommand` |
| 14 | `packages/studio/src/routes/api/brain/observations/` | `/api/brain/observations` | memory observations REST | NO drift | RENAME to `/api/memory/observations` — **PUBLIC HTTP API** |
| 15 | `packages/studio/src/routes/api/brain/decisions/` | `/api/brain/decisions` | memory decisions REST | NO drift | RENAME to `/api/memory/decisions` — **PUBLIC HTTP API** |
| 16 | `packages/studio/src/routes/api/brain/graph/` | `/api/brain/graph` | memory PageIndex graph REST | NO drift | RENAME to `/api/memory/graph` — **PUBLIC HTTP API** |
| 17 | `packages/studio/src/routes/api/brain/quality/` | `/api/brain/quality` | memory quality stats REST | NO drift | RENAME to `/api/memory/quality` — **PUBLIC HTTP API** |
| 18 | `packages/studio/src/routes/api/brain/tier-stats/` | `/api/brain/tier-stats` | memory tier distribution REST | NO drift | RENAME to `/api/memory/tier-stats` — **PUBLIC HTTP API** |
| 19 | `packages/studio/src/routes/api/living-brain/+server.ts` | `/api/living-brain` | BRAIN unified graph REST (five substrates) | aligned with concept, misnamed | RENAME to `/api/brain` — **PUBLIC HTTP API** |
| 20 | `packages/studio/src/routes/api/living-brain/stream/` | `/api/living-brain/stream` | BRAIN SSE event stream | aligned with concept, misnamed | RENAME to `/api/brain/stream` — **PUBLIC HTTP API** |
| 21 | `packages/studio/src/routes/api/living-brain/node/[id]/` | `/api/living-brain/node/[id]` | BRAIN node detail | aligned with concept, misnamed | RENAME to `/api/brain/node/[id]` |
| 22 | `packages/studio/src/routes/api/living-brain/substrate/[name]/` | `/api/living-brain/substrate/[name]` | BRAIN per-substrate projection | aligned with concept, misnamed | RENAME to `/api/brain/substrate/[name]` |
| 23 | `packages/studio/src/lib/server/living-brain/types.ts` `LBNode`/`LBEdge`/`LBGraph` | `LB*` | BRAIN unified node/edge/graph types | aligned, misnamed | RENAME to `BrainNode`/`BrainEdge`/`BrainGraph` (or keep `LB` as internal shorthand — decide) |
| 24 | `packages/studio/src/lib/server/living-brain/adapters/{brain,tasks,nexus,conduit,signaldock}.ts` | 5 per-substrate adapters | BRAIN substrate projection | aligned with concept | OK; rename directory to `brain-substrates/` or `brain/adapters/` if `/living-brain/` renamed |
| 25 | `packages/contracts/src/graph.ts` `GraphNodeKind` | graph (nexus-scoped) | NEXUS code symbol kinds | partial | unify with `LBNodeKind` — see Section 4 |
| 26 | global `nexus.db` (`~/.local/share/cleo/nexus.db`) | `nexus.db` | NEXUS substrate (code graph) | YES aligned | keep |
| 27 | global `signaldock.db` (`~/.local/share/cleo/signaldock.db`) | `signaldock.db` | SIGNALDOCK substrate (agents) | YES aligned | keep |
| 28 | `.cleo/conduit.db` | `conduit.db` | CONDUIT substrate (messages) | YES aligned | keep |
| 29 | `.cleo/tasks.db` | `tasks.db` | TASKS substrate (tasks, sessions) | YES aligned | keep |

**Drift count:** 17 artifacts misnamed. **Aligned count:** 8. **Public API renames required:** 9 routes (items 14–22).

---

## 2. Living Brain Substrate Analysis — This IS the Operator's BRAIN

**Evidence: `packages/studio/src/lib/server/living-brain/types.ts:1-11`**

> "Unified node and edge model for the Living Brain API. Provides a substrate-agnostic projection across all five CLEO databases: BRAIN, NEXUS, TASKS, CONDUIT, SIGNALDOCK. Every node carries a substrate-prefixed ID so cross-substrate edges can reference nodes unambiguously."

The pattern:
- **`LBSubstrate`** (`types.ts:35`) = `'brain' | 'nexus' | 'tasks' | 'conduit' | 'signaldock'` — 5 substrates (note: here `'brain'` in `LBSubstrate` means *brain.db / memory store*, not BRAIN super-domain).
- **`LBNode`** (`types.ts:43-73`) = substrate-prefixed `id` (`"brain:O-abc"`, `"nexus:sym-123"`, `"tasks:T5127"`), `kind`, `substrate`, `label`, `weight`, `createdAt`, `meta`.
- **`LBEdge`** (`types.ts:81-102`) = `source`, `target`, `type`, `weight`, `substrate: LBSubstrate | 'cross'` (cross-substrate edges are first-class).
- **`LBGraph`** (`types.ts:111-119`) = `{ nodes, edges, counts, truncated }` — deduped unified graph.
- **`getAllSubstrates()`** (`adapters/index.ts:160`) = the merge function — queries all 5 substrates, dedupes by id, recovers cross-substrate edge targets via stub loading (second-pass loader at `adapters/index.ts:51-141`).
- **SSE stream** (`types.ts:158-178`) emits `node.create`, `edge.strengthen`, `task.status`, `message.send` — **live updates across the BRAIN as substrates change**.

**Verdict:** The substrate pattern already implements the operator's BRAIN super-domain exactly. It is a unified graph of every node across NEXUS + memory (brain.db) + TASKS + CONDUIT + SIGNALDOCK, with cross-substrate edges. The only problem is it is called "living brain" instead of "brain", and the thing called "brain" is actually "memory."

**Internal naming collision:** Note the awkward overload — `LBSubstrate = 'brain' | ...` uses `'brain'` to mean "the brain.db memory store", while the whole API is called "Living Brain" to mean the unified super-graph. Post-rename, the `LBSubstrate` value `'brain'` would need to become `'memory'` to eliminate this shadow.

---

## 3. Canonical Rename Proposal

### 3.1 Domain-level naming (post-rename)

| Concept (operator) | Canonical name | Scope |
|--------------------|----------------|-------|
| BRAIN super-domain | `brain` | Unified graph across all 5 substrates; cross-substrate edges; SSE stream |
| memory subdomain | `memory` | brain.db observations/patterns/decisions/learnings + PageIndex graph + tiers |
| NEXUS substrate | `nexus` | code symbols, files, folders, calls, imports |
| TASKS substrate | `tasks` | task tree, sessions, gates |
| CONDUIT substrate | `conduit` | inter-agent messages |
| SIGNALDOCK substrate | `signaldock` | agents, identity |

### 3.2 File + DB renames (internal-only, safe)

| From | To | Risk | Scope |
|------|----|----|------|
| `packages/core/src/store/brain-schema.ts` | `memory-schema.ts` | LOW | internal import fix |
| `packages/core/src/store/brain-sqlite.ts` | `memory-sqlite.ts` | LOW | internal import fix |
| `packages/core/src/store/brain-accessor.ts` | `memory-accessor.ts` | LOW | internal import fix |
| `packages/core/src/memory/brain-*.ts` (14 files) | `memory/memory-*.ts` or keep | LOW | internal; or leave as-is and document "brain-*" = memory pipeline |
| `packages/contracts/src/brain.ts` | merge into `memory.ts` | LOW | internal types |
| `packages/contracts/src/operations/brain.ts` | `operations/memory.ts` | LOW | internal; 31-op contract file authored in commit 12a8819914ea needs rename |
| `packages/cleo/src/cli/commands/memory-brain.ts` | `commands/memory.ts` | LOW | internal rename; update 3 import sites |
| `memoryBrainCommand` export | `memoryCommand` export | LOW | internal |

### 3.3 Public-API renames (BREAKING — require version bump)

| From | To | Risk | Consumers |
|------|----|----|-----------|
| HTTP `/api/brain/observations` | `/api/memory/observations` | MEDIUM | studio UI, any external client |
| HTTP `/api/brain/decisions` | `/api/memory/decisions` | MEDIUM | studio UI, external |
| HTTP `/api/brain/graph` | `/api/memory/graph` | MEDIUM | studio UI, external |
| HTTP `/api/brain/quality` | `/api/memory/quality` | MEDIUM | studio UI, external |
| HTTP `/api/brain/tier-stats` | `/api/memory/tier-stats` | MEDIUM | studio UI, external |
| HTTP `/api/living-brain` | `/api/brain` | MEDIUM | studio UI 3D Brain view, external |
| HTTP `/api/living-brain/stream` | `/api/brain/stream` | MEDIUM | studio SSE consumers |
| HTTP `/api/living-brain/node/[id]` | `/api/brain/node/[id]` | MEDIUM | studio UI side panel |
| HTTP `/api/living-brain/substrate/[name]` | `/api/brain/substrate/[name]` | MEDIUM | studio UI per-substrate views |
| file `.cleo/brain.db` | `.cleo/memory.db` | HIGH | 59+ code references literal `brain.db`; runtime data; backup/restore; external scripts |
| SQLite table prefix `brain_*` | `memory_*` | VERY HIGH | requires full schema migration; all queries, ORM code, indexes |

### 3.4 CLI verb decision (HITL)

The CLI verb `cleo memory observe` maps to `memory.observe` (op), writes to `brain.db`. The operator's model says memory IS the right name for the subdomain. **Recommended: keep `cleo memory ...` exactly as-is**. If a unified-BRAIN CLI verb is desired later, add `cleo brain ...` as a NEW domain (pushes `CANONICAL_DOMAINS` to 15).

---

## 4. Unified Node Model — Partial, Needs Consolidation

### 4.1 Current state

Two parallel node-concept silos exist:

| Silo | Location | Scope | Used by |
|------|----------|-------|---------|
| `LBNode` (unified) | `packages/studio/src/lib/server/living-brain/types.ts:43-73` | 10 kinds: `observation\|decision\|pattern\|learning\|task\|session\|symbol\|file\|agent\|message`; carries `substrate` discriminator; substrate-prefixed `id` | Only studio Living Brain API |
| `GraphNodeKind` (nexus) | `packages/contracts/src/graph.ts:26-67` | 33 kinds of code symbols: `file\|folder\|module\|namespace\|function\|method\|constructor\|class\|interface\|struct\|trait\|impl\|type_alias\|enum\|...` | Nexus code graph only |

Additional memory-side node models:
- `BrainGraphNode` (`packages/contracts/src/operations/brain.ts:103-122`) — PageIndex graph nodes (`brain_page_nodes` table, nodeType = `symbol | file | concept`) — scoped to memory PageIndex, not unified.
- `BrainGraphEdge` (`packages/contracts/src/operations/brain.ts:125-138`).

### 4.2 Gap

**No single canonical `Node` type exists that the operator's model would expect.** The closest thing — `LBNode` — is buried in `@cleocode/studio` and duplicates concepts from `@cleocode/contracts/graph.ts`.

**What a unified model should look like:**

```typescript
// packages/contracts/src/node.ts (PROPOSED)
export type Substrate = 'memory' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';
export type NodeKind =
  | MemoryNodeKind    // observation | decision | pattern | learning
  | NexusNodeKind     // symbol | file | folder | module | ...
  | TasksNodeKind     // task | session | gate
  | ConduitNodeKind   // message
  | SignaldockNodeKind; // agent

export interface Node {
  id: string;                    // substrate-prefixed: "memory:O-abc"
  substrate: Substrate;
  kind: NodeKind;
  label: string;
  weight?: number;
  createdAt: string | null;
  meta: Record<string, unknown>;
}

export interface Edge {
  source: string;
  target: string;
  type: string;
  weight: number;
  substrate: Substrate | 'cross';
}
```

This becomes the canonical surface for `/api/brain/` (unified) — and all 5 substrate-specific types become tagged unions of it.

---

## 5. Risk + Migration Sequencing

### Wave A — Zero-risk internal renames (1 PR)
- `packages/contracts/src/operations/brain.ts` → `operations/memory.ts`
- `packages/contracts/src/brain.ts` → merge into `memory.ts`
- `packages/core/src/store/brain-{schema,sqlite,accessor}.ts` → `memory-*.ts`
- `packages/cleo/src/cli/commands/memory-brain.ts` → `commands/memory.ts`
- `memoryBrainCommand` → `memoryCommand`
- Test + build + ship single PR; no version bump needed (pure internal).

### Wave B — Canonical Node model (1 PR)
- Create `packages/contracts/src/node.ts` with `Substrate`, `Node`, `Edge` root types.
- Fold `LBNode`/`LBEdge`/`LBGraph` into it; keep `@cleocode/studio` imports working via re-export.
- Unify `GraphNodeKind` (nexus) under `NexusNodeKind`.
- Patch version bump; zero runtime breakage.

### Wave C — Studio HTTP surface (2 PRs — because this breaks public API)
- PR C1: Add `/api/memory/*` alongside existing `/api/brain/*` (both routes active). Add `/api/brain/*` alongside existing `/api/living-brain/*`. Deprecation warnings in old routes.
- PR C2: Remove old routes after 1 minor version cycle. Major version bump on `@cleocode/studio`.

### Wave D — DB file rename (DEFER — HIGH RISK)
- `brain.db` → `memory.db` touches 59+ files, backup/restore, external scripts, agent MEMORY.md docs.
- Requires: rename logic in `cleo init`, migration helper, backup/restore alias, documentation sweep.
- Major version bump on `@cleocode/cleo`.
- **Recommendation: defer to a dedicated epic. Low leverage, high cost. The file name is internal-ish (`.cleo/` is agent-managed).**

### Wave E — SQLite table prefix rename (DEFER — VERY HIGH RISK)
- `brain_observations` → `memory_observations` etc. affects every SQL query, every migration, every accessor function.
- **Recommendation: never do this unless the operator explicitly insists. The table name is pure internal and the cost/benefit is terrible.**

---

## 6. Open HITL Questions

1. **CLI verb: keep `cleo memory observe` or add `cleo brain observe` for unified BRAIN operations?** Recommend KEEP `cleo memory observe` for memory writes. Add `cleo brain *` as NEW canonical domain for unified-graph queries (`cleo brain node <substrate:id>`, `cleo brain neighbors`, `cleo brain stream`). This preserves zero-breakage on the high-traffic memory write path.

2. **`brain.db` file rename to `memory.db` — do now or defer?** Recommend defer. The cost (59+ files, backup/restore machinery, docs, external tooling) outweighs the value. The file is agent-internal. Document the convention: "brain.db is the memory store; the unified BRAIN is a query layer over all 5 databases" and move on.

3. **Where does the unified `@cleocode/brain` package live?** Currently the substrate merger (`getAllSubstrates()`) lives in `@cleocode/studio`. If the operator wants CLI/programmatic access to the unified graph, it MUST move to `@cleocode/core` or a new `@cleocode/brain` package. Recommend: create `@cleocode/brain` package; move `living-brain/types.ts` + `living-brain/adapters/*` into it; `@cleocode/studio` imports from it. This makes BRAIN a first-class package, matching NEXUS's status as `@cleocode/nexus`.

4. **SSE event names `node.create` / `edge.strengthen` — rename to `brain.node.create`?** The `LBStreamEvent` type (`types.ts:158-178`) uses bare names. If BRAIN becomes the super-domain, events should namespace as `brain.node.create`, `brain.edge.strengthen`, etc. Minor, but catches drift early.

5. **The 31 ops in `operations/brain.ts` — do they get `brain.*` or `memory.*` op names?** Currently the CLI uses `memory.*` but the file is titled `brain`. After rename to `operations/memory.ts`, all 31 ops are `memory.*`. Confirmed this matches registry.ts (`memory.observe`, not `brain.observe`). No public-API change — just file rename + contract comment fix.

---

## 7. File:line Citations (for every load-bearing claim)

- `CANONICAL_DOMAINS` has `memory` not `brain`: `packages/cleo/src/dispatch/types.ts:46-61` (14 domains).
- Dispatch handler is `MemoryHandler` routing `memory.*`: `packages/cleo/src/dispatch/domains/memory.ts:61`.
- Registry description confirms `memory.observe` writes brain.db: `packages/cleo/src/dispatch/registry.ts:2424`.
- Legacy `brain.observe` mutate is explicitly rejected: `packages/cleo/src/dispatch/domains/__tests__/memory-legacy-rejection.test.ts:86-91`.
- `brain.db` file exists; no `memory.db`, no `nexus.db` project-local (global at `~/.local/share/cleo/nexus.db`, `~/.local/share/cleo/signaldock.db`): verified via filesystem listing.
- No `@cleocode/brain` package exists (all 15 `@cleocode/*` packages listed): `packages/*/package.json` scan.
- 31-op contract file scopes to memory (all 31 ops are observation/decision/pattern/learning/graph/reason/search/quality): `packages/contracts/src/operations/brain.ts:1-955`.
- BRAIN super-domain is already implemented as Living Brain: `packages/studio/src/lib/server/living-brain/types.ts:1-182` (LBNode/LBEdge/LBGraph/LBSubstrate + SSE events).
- Unified graph merger: `packages/studio/src/lib/server/living-brain/adapters/index.ts:160-231`.
- Studio REST surface: `packages/studio/src/routes/api/brain/{decisions,graph,observations,quality,tier-stats}/` + `packages/studio/src/routes/api/living-brain/{+server.ts,node/[id],stream,substrate/[name]}`.
- Brain.db tables `brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_page_nodes`, `brain_page_edges`, `brain_memory_links`: `packages/core/src/store/brain-schema.ts:4`, lines 136-344.
- Memory tiers `short|medium|long`: `packages/core/src/store/brain-schema.ts:27` and `packages/contracts/src/brain.ts:21`.
- `cleo memory *` CLI commands (34 subcommands): `packages/cleo/src/cli/commands/memory-brain.ts:1-41`.
- CLI command exported as `memoryBrainCommand`, imported as `subCommands['memory']`: `packages/cleo/src/cli/commands/memory-brain.ts:2314`, `packages/cleo/src/cli/index.ts:102,223`.

---

## Recommendation At A Glance

**DO NOW (Wave A+B, 1-2 PRs, internal-only, no version bump):**
- Rename `packages/contracts/src/operations/brain.ts` → `operations/memory.ts`
- Merge `packages/contracts/src/brain.ts` → `memory.ts`
- Rename `packages/core/src/store/brain-{schema,sqlite,accessor}.ts` → `memory-*.ts`
- Rename `packages/cleo/src/cli/commands/memory-brain.ts` → `memory.ts`; rename `memoryBrainCommand` → `memoryCommand`
- Create canonical `Node`/`Edge`/`Substrate` types in `@cleocode/contracts`

**DO NEXT (Wave C, 2 PRs, studio major version):**
- Alias then deprecate `/api/brain/*` → `/api/memory/*` and `/api/living-brain/*` → `/api/brain/*`
- Optionally extract `@cleocode/brain` package from `packages/studio/src/lib/server/living-brain/`

**DO NOT (unless owner insists):**
- Rename `brain.db` file → `memory.db`
- Rename SQLite tables `brain_*` → `memory_*`

**ASK OWNER (HITL):**
- Keep `cleo memory observe` AND add new `cleo brain *` domain for unified graph ops?
- Extract `@cleocode/brain` package now or leave inside studio?
- Rename `LBNode`/`LBEdge` types — keep `LB` shorthand or make canonical `BrainNode`/`BrainEdge`?
