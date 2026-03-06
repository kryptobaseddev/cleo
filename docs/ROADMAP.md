# CLEO Roadmap

This roadmap reflects current implementation reality from `docs/concepts/CLEO-VISION.md`, active task state, and shipped changes through `2026.3.8`.

## Current Reality

### Shipped (🟢 [IMPLEMENTED])

- **🟢 [IMPLEMENTED] BRAIN foundation** in `.cleo/brain.db` with retrieval (`memory find`, `memory timeline`, `memory fetch`) and write (`memory observe`).
- **🟢 [IMPLEMENTED] NEXUS** dispatch domain handler wired with 12 operations in registry and test coverage.
- **🟢 [IMPLEMENTED] SQLite-vec** extension loading support and PageIndex graph table schema (`brain_page_nodes`, `brain_page_edges`).
- **🟢 [IMPLEMENTED] Shared-core architecture** with MCP-first contract and CLI parity.
- **🟢 [IMPLEMENTED] MCP Server** v0.91.0+ with native TypeScript engine (256 operations across 10 domains).
- **🟢 [IMPLEMENTED] TypeScript CLI** ~86 commands with shared-core delegation.
- **🟢 [IMPLEMENTED] Protocol CLI** consensus.sh and contribution.sh wrappers added.
- **🟢 [IMPLEMENTED] Validation layer** with 4-layer anti-hallucination system (schema → semantic → referential → protocol).
- **🟢 [IMPLEMENTED] CAAMP Integration** - All 11 provider capability API functions implemented.
- **🟢 [IMPLEMENTED] Universal Hooks** - Hook registry with CAAMP event types and BRAIN observers.
- **🟢 [IMPLEMENTED] Spawn Adapter** - CLEOSpawnAdapter wrapping CAAMP for subagent execution.
- **🟢 [IMPLEMENTED] Portable Brain** - `.cleo/` directory as git-trackable, zippable, cross-provider project memory.

### In Progress

- **T5241**: BRAIN/NEXUS cognitive infrastructure completion epic (critical).
- **T5152**: Advanced search completion wave (depends complete; child tasks partially complete).
- **T5153**: Reasoning and session integration phase.
- **T5154**: Memory lifecycle and retirement phase.

### Pending Critical Gaps

- **T5145**: Full claude-mem retirement automation (hooks + injection replacement) is not complete.
- **T5158/T5159**: Embedding generation and vector similarity pipeline not complete; these remain Living BRAIN substrate tasks, not the autonomous runtime epic.
- **T5161**: PageIndex traversal/query API not complete.
- **T5519 / T5573 / T5574 / T5575**: Autonomous runtime foundation remains pending. The canon is now defined in `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`, but Agent-Runtime Core, The Impulse, and Watchers are not implemented yet.

---

## Future Targets (🔴 [TARGET])

> These are aspirational targets gated by validation. They move to "In Progress" only after explicit gate approval. All TARGET items have corresponding epics.

### Phase 1: Validation Gates

- [ ] **🔴 [TARGET] Nexus Usage Validation** (T5500): ≥3 developers using Nexus across 2+ projects for 30+ consecutive days, >100 cross-project queries in 30-day period
- [ ] **🔴 [TARGET] MCP Server Adoption** (T5501): 3+ developers using MCP server for 60+ days, >500 queries/dev/month
- [ ] **🔴 [TARGET] Strategic Direction Decision** (T5502): Explicit commit to BRAIN expansion OR simplification path

### Phase 2: Intelligence (Tier M → L)

- [ ] **🔴 [TARGET] Semantic Search (SQLite-vec)** (T5493): Query <3s for 10K tasks, >80% relevance
- [ ] **🔴 [TARGET] TypeScript Hotspot Migration** (T5494): Sessions, migrate, orchestrator modules to TypeScript
- [ ] **🔴 [TARGET] Research Indexing** (T5503): SQLite index of MANIFEST.jsonl with FTS5 support

### Phase 2.5: Learning Infrastructure

- [ ] **🔴 [TARGET] Pattern Extraction Engine** (T5495): ≥10 actionable patterns from 50 completed epics
- [ ] **🔴 [TARGET] Adaptive Prioritization** (T5504): >20% blocker reduction via learned patterns
- [ ] **🔴 [TARGET] Epic Summarization** (T5505): Distill completed epics into reusable knowledge

### Phase 3: Scale (Tier L)

- [ ] **🔴 [TARGET] Agent Coordination** (T5496): 5-20 concurrent agents with capability routing
- [ ] **🔴 [TARGET] PostgreSQL Backend** (T5497): Cross-project intelligence at 10K+ task scale
- [ ] **🔴 [TARGET] Graph-RAG Global** (T5506): Cross-project semantic discovery

### Phase 3.5: BRAIN Certification

- [ ] **🔴 [TARGET] Base (Memory)** (T5498): Query <3s for 10K tasks, vector search operational
- [ ] **🔴 [TARGET] Reasoning** (T5498): Identify similar tasks across 3 projects with >80% accuracy
- [ ] **🔴 [TARGET] Agent** (T5498): 5 subagents complete epic without HITL, <5% error rate
- [ ] **🔴 [TARGET] Intelligence** (T5498): Extract ≥10 actionable patterns, suggest optimizations
- [ ] **🔴 [TARGET] Network** (T5498): Transfer learned patterns between projects, >70% relevance

### CAAMP Future Enhancements

- [ ] **🔴 [TARGET] skill.precedence.set** (T5499): Set precedence mode operation
- [ ] **🔴 [TARGET] skill.precedence.clear** (T5499): Clear precedence override operation
- [ ] **🔴 [TARGET] skill.precedence.list** (T5499): List available precedence modes operation

---

## Active Roadmap Tracks

### Track A - BRAIN Completion (near-term)

- Complete vector pipeline (`T5158`, `T5159`) on top of shipped sqlite-vec loading as Living BRAIN substrate work.
- Complete PageIndex query/traversal API (`T5161`) on top of shipped graph tables.
- Complete reasoning and session integration (`T5153` children).

### Track B - Retirement and Automation

- Complete native hook-based memory automation and remove runtime dependency on claude-mem plugin (`T5145`).
- Align session-start/session-end/tool-use memory capture with BRAIN-native flow.

### Track C - NEXUS Maturation

- Evolve from JSON-backed registry toward dedicated `nexus.db` target architecture.
- Expand cross-project retrieval quality and federated memory workflows.

### Track D - Autonomous Runtime

- Build the autonomous runtime foundation (`T5519`, `T5573`, `T5574`, `T5575`) per `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md`.
- Deliver the runtime stations (`T5520`-`T5529`) with canon-aligned roles, hooks, and domain mappings.
- Keep `T5158`/`T5159` scoped to Living BRAIN retrieval substrate rather than treating them as the runtime epic.

## Verification Policy

Any roadmap item moves from planned to shipped only when:

- Implementation is merged.
- Tests pass in the canonical suite.
- Documentation is synchronized (`vision`, `README`, specs, and changelog).

No time estimates are used in roadmap reporting. Scope is tracked via task status, dependencies, and verification evidence.

---

## Legend

- 🟢 **[IMPLEMENTED]** - Shipped and operational
- 🟡 **[IN PROGRESS]** - Currently being worked
- 🔴 **[TARGET]** - Aspirational, gated by validation, requires explicit approval

---

**Scale Tiers**: S (1 project) → M (2-3 projects) → L (3-10 projects) → XL (10-100+ projects)

**Current Tier**: S (mature) with M foundation in progress

**Migration**: JSON files (S) → SQLite (M) → PostgreSQL (L)

**Gate Enforcement**: Strict mode default. Phase progression requires explicit HITL approval.
