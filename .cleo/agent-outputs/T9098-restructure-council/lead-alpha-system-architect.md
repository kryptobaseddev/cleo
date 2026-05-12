# LEAD ALPHA — System Architect Proposal (T9098)

**Specialty:** Structural decomposition, canonical naming, scope boundary architecture.
**Date:** 2026-05-06 · **Branch context:** main · **Stance:** opinionated, decisive.

---

## 1. Recommended Split — TWO top-level commands, THREE internal subsystems, TWO databases

> **One system, two surfaces.** The 50+ ops are not "one tree with five hats" — they are **two distinct user-facing nouns** that happen to share an underlying graph engine. Forcing a single `cleo nexus *` tree perpetuates exactly the confusion the owner flagged. Inventing five sibling top-levels (`cleo graph`, `cleo nexus`, `cleo brain-link`, `cleo registry`, `cleo transfer`) shatters discoverability. Both extremes are wrong.

**Decision matrix:**

| Option | Discoverability | Cognitive load | Migration cost | LLM-legibility | Verdict |
|---|---|---|---|---|---|
| Single tree (`nexus graph/all/living/...`) | medium | high (5 sub-namespaces) | low | low (still one help blob) | reject |
| 5 top-levels (one per scope) | low | low per cmd, high overall | high (5 dispatch entries, 5 contract files) | low | reject |
| **2 top-levels + 1 thin bridge** | **high** | **low** | **medium** | **high** | **accept** |

**The split:**

| User-facing CLI | Subsystem (canonical name) | Scope | Database | Package |
|---|---|---|---|---|
| `cleo graph <op>` | **Graph** (project-local code intelligence) | scopes #1, #2 | `<repo>/.cleo/graph.db` *(per-project, local)* | `@cleocode/graph` |
| `cleo atlas <op>` | **Atlas** (cross-project registry + meta-graph) | scopes #3, #4, #5 | `~/.local/share/cleo/atlas.db` *(global)* | `@cleocode/atlas` |
| (no new top-level) | **Bridge** (Living Brain joins) | scope #2 lives here as a method, surfaced under `cleo graph living *` | reads both | `@cleocode/graph-bridge` |

The Living Brain is **not** a third user-facing top-level. It is a *capability of Graph* (it is anchored to one project at a time and joins BRAIN/TASKS/CONDUIT for that project). Promoting it to a peer would replicate today's confusion — three nouns where there are two scopes (local/global) and one cross-cutting capability.

The "Hybrid" scope (#4 — `transfer`, `link-tasks`) belongs to **Atlas**: every hybrid op operates on the registry's view of two registered projects. It is a 2-arg form of cross-project, not a separate scope.

---

## 2. Canonical Naming

| Today (overloaded) | Tomorrow (canonical) | Why |
|---|---|---|
| "Nexus" (project graph) | **Graph** | Already what GitNexus calls it; matches `gitnexus_*` MCP tools the owner uses; `.gitnexus/` already lives in repo. The word "nexus" is reserved for cross-project. |
| "Nexus" (cross-project registry) | **Atlas** | Connotes cartography of multiple territories. Distinct phoneme from "graph". Short (5 chars). Not collisions with any existing CLEO domain (TASKS, LOOM, BRAIN, NEXUS→ATLAS, CANT, CONDUIT). |
| "Living Brain" (cross-substrate join) | **Living Graph** *(capability)* — surfaced as `cleo graph living <op>` | "Brain" already names another subsystem. "Living" reads correctly as a modifier on Graph. Avoids naming a third peer. |
| `nexus.db` | `graph.db` (per-project) + `atlas.db` (global) | Physical separation matches logical scope. |
| `packages/nexus/` | `packages/graph/` + `packages/atlas/` + `packages/graph-bridge/` | One package per database boundary. |

**The Six-Domain canon updates cleanly:** TASKS, LOOM, BRAIN, **GRAPH+ATLAS** (replacing NEXUS), CANT, CONDUIT. Two systems where there was one — which is honest, since the data lives in two databases today and that has been the source of the leakage.

---

## 3. Command-Tree Shape (10 representative paths)

```
# GRAPH — project-local, defaults to cwd, exits 0 if not analyzed
cleo graph status                          # was: nexus status
cleo graph analyze [--embeddings]          # was: nexus analyze
cleo graph clusters                        # was: nexus clusters
cleo graph context <symbol>                # was: nexus context
cleo graph impact <target> --direction up  # was: nexus impact
cleo graph hot-nodes                       # was: nexus hot-nodes
cleo graph living context                  # was: nexus full-context
cleo graph living why <task>               # was: nexus why
cleo graph wiki                            # was: nexus wiki

# ATLAS — global registry, no cwd default; --project=<id|name> required for project-targeting ops
cleo atlas list
cleo atlas show <projectId>
cleo atlas scan
cleo atlas deps <projectId>
cleo atlas critical-path
cleo atlas blocking
cleo atlas transfer <fromId> <toId>        # was: nexus transfer (hybrid op)
cleo atlas link-tasks <projectA> <projectB> # was: nexus link-tasks
cleo atlas register / unregister
cleo atlas init                            # initializes ~/.local/share/cleo/atlas.db
cleo atlas clean --polluted                # the 80,969-row cleanup gets a first-class verb
```

**Discoverability rule (enforced in spawn prompts and help):** an LLM agent never has to guess scope. If the command starts with `cleo graph`, it operates on **this** project. If it starts with `cleo atlas`, it operates on the **registry**. There is no third option. Living capability is a verb under graph (`graph living *`) so it inherits "this project" semantics.

---

## 4. Package + DB Topology

### Packages — split `@cleocode/nexus` into three

```
packages/graph/             # was: packages/nexus/src/{code,intelligence,pipeline,schema}
  src/
    pipeline/               # analyze, embeddings, AST extraction
    intelligence/           # clusters, hot-nodes, cold-symbols, god-nodes
    code/                   # context, impact, query
    living/                 # full-context, why, conduit-scan, brain-anchors, task-footprint
    schema/                 # graph.db schema (Drizzle)
    index.ts                # exports + factory: openProjectGraph(repoPath)

packages/atlas/             # was: packages/nexus/src/registry
  src/
    registry/               # list, show, scan, register, unregister, resolve
    crossproject/           # deps, critical-path, blocking, orphans, graph, impact-full
    hybrid/                 # transfer, transfer-preview, link-tasks
    sharing/                # share, permission, export, sigil
    schema/                 # atlas.db schema (Drizzle)
    index.ts

packages/graph-bridge/      # NEW — thin (~300 LOC), no schema of its own
  src/
    join.ts                 # opens graph.db + brain.db + tasks.db + conduit.db, performs read-only joins
    living-context.ts       # the actual cross-substrate query implementation
```

`graph-bridge` is the **only** module that imports from `@cleocode/brain`, `@cleocode/core/store/tasks`, and `@cleocode/conduit`. This isolates the cross-substrate join surface to one auditable file. Everywhere else, Graph is pure code-graph; Brain is pure memory; Tasks is pure tasks.

### Databases — split `nexus.db` into two physical files

| File | Location | Owner | Lifecycle |
|---|---|---|---|
| `graph.db` | `<repo>/.cleo/graph.db` *(was `.gitnexus/db.sqlite` for GitNexus; we adopt that pattern)* | per-project | created by `cleo graph analyze`, deleted by `cleo graph clean` |
| `atlas.db` | `~/.local/share/cleo/atlas.db` (XDG via `@cleocode/paths`) | global | created by `cleo atlas init`, never cwd-coupled |

**Why per-project `.cleo/graph.db` (not `.gitnexus/`)** — keeps CLEO's data envelope coherent (`.cleo/` is already where `tasks.db`, `brain.db`, `config.json` live; same `.gitignore` rules and same `cleo backup add` snapshot path apply per ADR-013 §9). GitNexus continues to write its own `.gitnexus/` for its analyzer; CLEO reads from `.cleo/graph.db` produced by our pipeline. The two are separable artifacts of the same analysis.

**Why this kills the 80,969-row pollution at the architectural level:** test fixtures cannot leak into `atlas.db` because **tests cannot reach `~/.local/share/cleo/`** without explicit env override. Every test currently leaking is calling project-graph code which today writes to the registry — under this split, project-graph writes only to `.cleo/graph.db` *of the test fixture's own cwd*, which is a tmpdir that gets cleaned up. This is a **structural** fix, not a "we'll be more careful" fix.

---

## 5. Why This Beats the Obvious Alternatives

**Anticipated BETA ("contracts-first single tree with `scope` field"):** BETA will likely propose keeping `cleo nexus *` and adding `meta.scope: 'project' | 'cross-project' | 'living' | 'hybrid' | 'global'` to envelopes. *That is necessary but insufficient.* Envelope metadata fixes machine-readability for already-running commands, but it cannot fix CLI help discoverability — an agent reading `cleo nexus --help` still sees a flat list. My proposal makes BETA's contracts work strictly easier: only **two** contract files (`packages/contracts/src/operations/graph.ts`, `atlas.ts`) instead of one bloated file with a discriminator. Scope becomes a *package boundary*, not a runtime field.

**Anticipated GAMMA ("aggressive aliasing keeps `cleo nexus *` working forever"):** GAMMA will protect existing muscle memory with permanent aliases. *Reasonable for one minor version, harmful as steady state.* My split lets GAMMA cleanly map `nexus <op>` → `graph <op>` OR `atlas <op>` based on a static lookup table (the 50 ops sort cleanly into two buckets). A two-version deprecation window (warn at v2026.6, remove at v2026.8) is sufficient because the routing is deterministic.

**Anticipated DELTA ("agent-discovery via better help text and grouped sections"):** DELTA will likely propose `cleo nexus --help` with `## Project Graph` / `## Cross-Project` / `## Living Brain` headers and a tighter CLEO-INJECTION.md section. *Solves the symptom, not the cause.* When the noun itself is overloaded, no amount of help-text grouping makes `cleo nexus list` (lists registered projects) feel adjacent to `cleo nexus context foo` (looks up a symbol in cwd). Different verbs need different nouns. My split means DELTA's help text writes itself: each top-level has one clear scope statement, no mixed sections.

**Where I diverge from all three:** they are each iterating on the assumption that "Nexus" is the canonical name. I am asserting **the name is the bug**. "Nexus" was correctly named when it was *one* graph; it became a category mistake when registry+living-brain were grafted on. Renaming is not cosmetic — it is the load-bearing architectural act that lets every downstream improvement (BETA's contracts, GAMMA's migration, DELTA's docs) compose without the underlying ambiguity bleeding through.

---

## 6. One Concrete Failure Mode of My Own Proposal

**The Living-as-capability boundary is fragile.** Today's `nexus full-context <task>` joins Graph (which symbols changed) + Tasks (acceptance criteria) + Brain (memory anchors) + Conduit (recent agent chatter). I am placing this under `cleo graph living *` because it is anchored to a single project. But:

- If a future op needs to ask "what is the Living Brain view across **two** projects?" (e.g., "show me all tasks blocked by missing memory anchors in both `cleocode` and `gitnexus`"), it doesn't fit under `graph` (which is single-project) and doesn't fit under `atlas` (which doesn't see substrate joins). It would force a third top-level OR a leaky `atlas living *` namespace that re-imports the bridge.
- The packaging mitigates this — `graph-bridge` is already the only joiner, so adding `atlas living *` would be a thin re-export, not a duplication. But the **CLI shape** would suddenly grow a third hat after I just argued for two. That is a real demerit and an honest predictor of regret in 12-18 months if cross-project Living Brain becomes a real workflow.

**Mitigation I am NOT pretending solves it:** reserve the namespace by writing the ADR now ("`cleo graph living *` is single-project; if cross-project Living emerges, it lives at `cleo atlas living *` with the same bridge, NOT a third top-level"). This bounds the regret to "we add one more namespace under an existing top-level" rather than "we re-architect again." Worth flagging in the council vote so the owner's eyes are open.

---

**TL;DR for the chairman:**
- Two top-levels: `cleo graph` (project) and `cleo atlas` (cross-project).
- Two databases: `.cleo/graph.db` (per-project) and `~/.local/share/cleo/atlas.db` (global).
- Three packages: `@cleocode/graph`, `@cleocode/atlas`, `@cleocode/graph-bridge`.
- Living Brain demoted from peer to capability (`cleo graph living *`).
- Renaming is the load-bearing act; everything else (contracts, aliasing, help) composes downstream of it.
- Known risk: cross-project Living Brain would force a fourth namespace; ADR'd up front.
