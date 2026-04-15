# T549-R2: Industry Memory Architecture — Deep Research Report

**Date**: 2026-04-13
**Task**: T549 (subagent research wave)
**Type**: Research
**Status**: Complete

---

## Executive Summary

The AI agent memory space has matured dramatically in 2024-2026. What was once "store conversation history in a vector DB" is now a multi-billion dollar infrastructure category with peer-reviewed benchmarks, typed memory hierarchies, sleep-time compute, and graph-native temporal reasoning. CLEO's BRAIN system is well-positioned but has specific architectural gaps that, if closed, would make it a genuine industry leader.

Key finding: **No current system combines all best practices.** Hindsight wins on retrieval accuracy (91.4% LongMemEval), Letta wins on agent-driven memory control, Zep wins on temporal reasoning, Mem0 wins on ecosystem breadth. CLEO can synthesize all of these.

---

## 1. Systems Studied — Comparison Table

| System | Architecture | Memory Tiers | Storage Backend | Extraction | Retrieval Strategy | Benchmarks | Self-Hosting | Notes |
|--------|-------------|-------------|----------------|-----------|-------------------|------------|--------------|-------|
| **Letta (MemGPT)** | OS-inspired tiered, agent-managed | Core (in-context), Archival (external), Recall (history) | Vector + KV | Agent tool calls at runtime | Agent-driven tool selection | 74.0% LoCoMo (Filesystem), 94.8% DMR | Yes (open source) | Agent decides what to store/retrieve; sleep-time compute introduced 2025 |
| **Mem0** | Selective extraction pipeline | User, Session, Agent scopes | Vector + Graph (KG) + KV | LLM-based extraction per turn | Intent-aware hybrid | 66.9% LOCOMO LLM score (26% above OpenAI Memory); 91% latency improvement | Yes (open source + cloud) | Best ecosystem (49K stars); graph behind Pro tier |
| **Zep / Graphiti** | Temporal knowledge graph | Episodic (events), Semantic (entity/community), Community summaries | Neo4j / FalkorDB graph + embeddings | Bitemporal entity extraction | Hybrid: semantic + BM25 + graph traversal | 71.2% LongMemEval (vs 60.2% full-context baseline); 94.8% DMR | Yes | Dual timestamp model (valid_at / invalid_at); peer-reviewed (arXiv 2501.13956) |
| **Hindsight** | Multi-strategy retrieval with synthesis | Fact graph + episodic | Embedded PostgreSQL | Entity resolution + fact extraction at write time | 4 parallel strategies: semantic, BM25, graph, temporal + cross-encoder reranking | 91.4% LongMemEval (highest published) | Yes (MIT, Docker) | Read-optimized; reflects across memories not just retrieves |
| **LangMem (LangChain)** | Three typed memory classes | Semantic, Episodic, Procedural | LangGraph StateStore (pluggable) | Background or hot-path update | Vector similarity + namespace filter | Not independently published | Yes (open source) | LangGraph-coupled; no episodic utilities yet (2025) |
| **CrewAI** | Role-based structured memory | Short-term (RAG), Long-term (SQLite), Entity, Contextual | SQLite + Chroma/Qdrant | Built-in per agent role | Agentic RAG | Not published | Yes | Memory tied to agent role; provider-neutral RAG |
| **AutoGen (Microsoft)** | Message-based + external integrations | Short-term (message list), Long-term (external) | Pluggable (no built-in) | None built-in | Depends on plugin | Not published | Yes | Memory is a plugin concern, not core |
| **ChatGPT (OpenAI)** | 4-layer context window injection | Saved memories, Chat history synthesis, Session metadata, Current context | Proprietary periodic synthesis | Periodic background synthesis; no per-turn RAG | Full synthesis injected as block | 52.9% LOCOMO (Mem0 +26% over this) | No | Simpler than expected: no vector DB, no graph; uses periodic LLM consolidation |
| **A-Mem** | Zettelkasten-inspired agentic network | Dynamic linked note network | Embedding + link graph | Agent generates contextual descriptions, keywords, tags; links by similarity | Evolving link traversal | State-of-art on long-term conversational tasks (NeurIPS 2025) | Yes (open source) | Memories evolve: new memories trigger updates to existing; higher-order attributes |
| **SuperMemory** | Memory + RAG + user profiles + connectors | Memory, RAG, profiles | Cloudflare Workers + PostgreSQL/pgvector | Fact extraction + contradiction resolution + stale expiration | Vector similarity | 81.6% LongMemEval (GPT-4o) | Enterprise only | Simple API ("one call"); closed source |
| **MemOS** | OS abstraction over multiple stores | Fact, Experience, Working memory | Multi-store (unified API) | LLM-based per store | Unified API dispatch | Not published | Yes | Treats memory as OS concern; most conceptually aligned with CLEO |
| **Mastra (Observational Memory)** | Log-based with prompt-cacheable context | Stable memory log | PostgreSQL | Session log summarization | No dynamic per-turn retrieval | 95% LongMemEval (highest OM variant) | Yes | Predictable latency via stable context; trades freshness for speed |

---

## 2. Best Practices From Each System

### 2.1 Letta / MemGPT — OS-Inspired Tiering + Sleep-Time Compute

**What it gets right:**
- Treating context like virtual memory (RAM vs disk) is the right mental model
- Agents that self-edit their own memory blocks create dynamic personalization without external orchestration
- **Sleep-time compute** (arXiv 2504.13171, April 2025): agents run asynchronously during idle time to consolidate, reorganize, and pre-compute memory. Reduces live latency and improves memory quality. "Silent housekeeper" pattern.
- Separation of memory management agent from conversation agent prevents interference
- Memory blocks are typed and structured (not free-form strings)

**Eviction/lifecycle:**
- Core memory: fixed-size, never evicted (always in context)
- Archival memory: append-only vector storage, searched on demand
- Recall memory: conversation history, vector-searchable

**Takeaway for CLEO**: Sleep-time compute is the single highest-leverage architectural idea. BRAIN observations accumulate; a background consolidator should run between sessions.

### 2.2 Mem0 — Production Pipeline + Multi-Scope

**What it gets right:**
- Clear separation of scopes: user-level, session-level, agent-level
- Three storage backends working together: vector (semantic), KV (explicit facts), graph (relationships)
- Memory lifecycle management: update/deduplicate when new info conflicts rather than append
- Intent-aware retrieval filtering (not raw similarity)
- 90% token reduction vs full-context because only relevant facts injected
- Published benchmark-backed research (ECAI 2025, arXiv:2504.19413)
- Procedural memory (`memory_type="procedural_memory"`) stored separately from factual

**Extraction pipeline:**
1. Parse conversation turn
2. LLM identifies salient facts
3. Check existing memories for conflicts
4. Update (not duplicate) if contradiction found
5. Store with metadata and scope tags
6. On retrieval: filter by user/session/agent, then semantic search

**Takeaway for CLEO**: Memory update-not-append is critical. BRAIN currently accumulates noise because it only adds, never reconciles. The three-backend pattern (vector + KV + graph) is worth adopting.

### 2.3 Zep / Graphiti — Temporal Knowledge Graphs

**What it gets right:**
- **Bitemporal modeling**: every fact has `valid_at` (when it became true) and `invalid_at` (when it stopped being true). This is the difference between "knows state" and "knows state over time"
- Entity and community summaries: raw conversation → entities → relationships → community clusters → summaries. Five levels of abstraction
- State-of-art on temporal reasoning benchmarks
- Hybrid retrieval: semantic + BM25 + graph traversal
- Supports structured business data ingested alongside conversational data

**Temporal validity windows:**
- New contradicting info auto-invalidates old relationship (e.g., "user moved to NYC" invalidates "user lives in SF")
- Audit trail preserved: you can query "what did the agent believe at time T?"

**Takeaway for CLEO**: BRAIN has no temporal validity. Facts rot silently. Adding `valid_at`/`invalid_at` to BRAIN observations would enable contradiction detection and temporal auditing. This is the most underrated gap in CLEO today.

### 2.4 Hindsight — Multi-Strategy Retrieval with Synthesis

**What it gets right:**
- Four parallel retrieval strategies simultaneously: semantic similarity, BM25 keyword, graph traversal, temporal proximity
- Cross-encoder reranker merges results and scores relevance before injection
- **Reflect** operation: synthesizes across memories rather than just retrieving them (reasoning over accumulated experience)
- Read-optimized: all extraction, entity resolution, and embedding happens at write time so reads are fast (100-600ms)
- Entity resolution at ingest: "John" and "John Smith" resolved to same entity before storage

**Benchmark dominance**: 91.4% LongMemEval — highest published score. Demonstrates multi-strategy retrieval's value over any single-strategy approach.

**Takeaway for CLEO**: CLEO's `memory brain.search` is single-strategy (likely vector similarity). Adding even one additional strategy (keyword/BM25) alongside vector search would meaningfully improve recall. The cross-encoder reranking pattern is worth evaluating.

### 2.5 LangMem — Typed Memory as First-Class API

**What it gets right:**
- Formal taxonomy enforced at API level: semantic, episodic, procedural
- Each type has different storage pattern and retrieval logic
- Procedural memory stored as system prompt updates (agents literally rewrite their own instructions)
- Background vs hot-path update modes with explicit tradeoffs documented

**Type taxonomy:**
- **Semantic**: facts and knowledge (stored in profile or collection)
- **Episodic**: past experiences, few-shot examples (stored in collection)
- **Procedural**: how to do tasks, behavioral rules (stored as prompt rules or collection)

**Takeaway for CLEO**: BRAIN does not distinguish observation types. All BRAIN entries are blobs. Introducing typed storage (even just semantic vs procedural vs episodic) would enable type-targeted retrieval and improve precision.

### 2.6 A-Mem — Zettelkasten Memory Network

**What it gets right:**
- Every new memory is contextualized with keywords, tags, and contextual description (not just raw text)
- Memory establishment of explicit links to related existing memories based on shared attributes
- Historical memories **evolve**: new memories can trigger updates to existing memory attributes
- Higher-order attribute emergence: system develops its own abstractions over time
- Agent-driven without rigid schema (adapts to diverse tasks)

**Takeaway for CLEO**: BRAIN observations are standalone. Adding link generation (new observation → find related observations → create bidirectional links) would create a knowledge network instead of a flat list.

### 2.7 ChatGPT (OpenAI) — Radical Simplicity

**What it does:**
- No vector database, no RAG, no graph
- Periodic LLM consolidation synthesizes all past conversations into a memory block
- Memory block injected wholesale into context window every session
- User-editable explicit memories layered on top

**Why it matters**: Achieves 52.9% LOCOMO (worst in class among dedicated systems, but still functional). Proves that **simplicity has value** — the architecture is predictable, debuggable, and scales without infrastructure. Cost of complexity must justify the accuracy gain.

**Takeaway for CLEO**: Complexity should be justified by benchmark data. Don't over-engineer when a simpler approach might serve the use case. The memory block injection pattern (pre-composed, stable) reduces per-turn latency.

### 2.8 Mastra — Observational Memory (95% LongMemEval)

**What it gets right:**
- Achieves 95% LongMemEval via a structured observation log, not complex retrieval
- Prompt-cacheable: stable memory context = no dynamic injection overhead
- Predictable latency because context is pre-composed, not assembled per query
- Trades absolute freshness for speed and reliability

**Takeaway for CLEO**: The CLEO memory bridge pre-composition pattern (`.cleo/memory-bridge.md`) is conceptually aligned with this approach. Strengthen it: make the bridge a properly structured observation log, not just a narrative summary.

---

## 3. What CLEO Should Adopt

### Priority 1 (Critical — Core Architecture Gaps)

**3.1 Sleep-Time Compute / Background Consolidator**
- Current state: BRAIN observations accumulate passively between sessions with no consolidation
- Target: A consolidation pass that runs at session end (already triggered by `cleo session end`) that:
  1. Deduplicates semantically similar observations
  2. Merges conflicting facts (new takes precedence, old marked invalid)
  3. Promotes high-signal observations to long-term semantic store
  4. Prunes noise below quality threshold
  5. Updates procedural summaries from pattern data
- This is the `vacuumIntoBackupAll` equivalent for the semantic layer

**3.2 Temporal Validity (Bitemporal Facts)**
- Current state: BRAIN facts are timeless — "user prefers X" never expires or conflicts
- Target: Add `valid_at` and `invalid_at` to BRAIN observation schema
- Conflict detection: when a new observation contradicts an existing one, auto-set `invalid_at` on old entry
- Temporal query support: "what did BRAIN know at session start?"
- Audit trail: enable forensic reconstruction of agent reasoning

**3.3 Typed Memory Taxonomy**
- Current state: All BRAIN entries are untyped blobs (observations, learnings, patterns, decisions)
- Target: Four explicit types with different storage and retrieval semantics:
  - **Factual / Semantic**: declarative facts ("codebase uses pnpm", "owner prefers pipe-separated acceptance criteria")
  - **Episodic**: task completion records, session events, error patterns
  - **Procedural**: behavioral rules, coding standards, workflow patterns ("always run biome before commit")
  - **Working**: active session context, current task state (volatile, cleared on session end)
- Each type queries differently: procedural retrieved on task start, factual retrieved on demand, episodic retrieved for context reconstruction

**3.4 Memory Update vs Append**
- Current state: BRAIN only adds observations, never reconciles
- Target: Before storing a new observation, check semantic similarity against existing entries; if >0.85 similarity AND contradiction detected, update rather than append
- Result: 2440-noise-entry crisis would not recur with this gate in place

### Priority 2 (High — Retrieval Quality)

**3.5 Multi-Strategy Retrieval**
- Current state: `cleo memory find` uses single-strategy search (likely vector or keyword)
- Target: Two strategies minimum — vector (semantic) + BM25 (keyword) — merged with score weighting
- Optional Phase 2: Add graph traversal once BRAIN has link structure (see 3.6)
- Even adding keyword search as a fallback when vector returns zero results would improve recall

**3.6 Observation Link Graph**
- Current state: BRAIN observations are isolated entries
- Target: On new observation creation, run a link-generation step:
  1. Embed new observation
  2. Find top-5 most similar existing observations
  3. Create bidirectional links with relationship type (supports, contradicts, updates, extends)
  4. Update existing observation attributes if new info enriches them
- This creates the knowledge network that enables multi-hop reasoning

**3.7 Entity Resolution**
- Current state: "owner" and "keatonhoskins" and "the user" may all exist as separate entities
- Target: Entity normalization at ingest time — canonical entity table with aliases
- Side effect: queries for "owner preferences" would also retrieve observations about "keatonhoskins"

### Priority 3 (Medium — Quality Instrumentation)

**3.8 Memory Quality Scoring**
- Every BRAIN observation should have a quality score (0-100) at write time
- Dimensions: confidence (how certain is the claim?), specificity (general vs precise?), freshness (age decay?), utility (how often has it been retrieved?), source reliability (agent-inferred vs owner-stated?)
- Retrieval penalizes low-quality observations; consolidation prunes below threshold
- This directly addresses the 2440-noise-entry BRAIN Integrity Crisis from memory

**3.9 Signal-to-Noise Metrics**
- Track: total observations vs observations retrieved in last N sessions
- Track: retrieval precision (were retrieved observations relevant?) via outcome correlation
- Dashboard metric: "memory utility ratio" = useful retrievals / total retrievals
- Alert when ratio drops below 0.6 (60% of what's stored is being used)

**3.10 Retrieval Outcome Correlation**
- After task completion, record which memories were injected into that session
- Mark observations as "contributed to successful completion" vs "retrieved but irrelevant"
- Feed back into quality scores: observations that contribute to success get quality boost, noise gets penalized

### Priority 4 (Nice to Have — Advanced)

**3.11 Procedural Self-Improvement**
- Procedural observations (coding rules, workflow patterns) should be periodically reviewed
- Consolidator checks if new episodic evidence (task completions) supports or contradicts existing procedures
- If procedure violated 3+ times with good outcomes, it should be updated or deprecated
- If procedure followed consistently, boost its priority/confidence

**3.12 Community Summaries (Zep pattern)**
- For large BRAIN stores, entity and topic clusters should generate community summaries
- A summary of "all observations about the CLI audit" is more token-efficient than injecting 20 individual observations
- Community summaries as a compression layer: retrieve summary first, then individual nodes only if needed

---

## 4. What CLEO Should Avoid

**4.1 Full-Context Injection**
- Injecting entire BRAIN content into every session context. OpenAI Memory does this (periodic synthesis into a block) but it does not scale.
- CLEO's memory bridge already avoids this by being selective. Preserve that discipline.
- The moment the memory bridge exceeds ~2K tokens, context rot starts degrading reasoning on the actual task.

**4.2 Append-Only Without Reconciliation**
- BRAIN's crisis (2440 noise entries) was caused by append-only design
- Every store operation must check for conflicts and near-duplicates before writing
- The cost of dedup at write time is far less than the cost of noisy retrieval at read time

**4.3 Single-Strategy Retrieval**
- Vector-only retrieval misses exact-match queries (keywords, IDs, command names)
- Keyword-only retrieval misses semantic associations
- Use at minimum a vector + keyword hybrid with score fusion

**4.4 Un-typed Memory**
- Mixing facts, procedures, events, and working context in one flat store forces retrieval to compete across incompatible memory types
- A procedural rule ("always use pnpm") should not compete with an episodic event ("completed T526 on 2026-04-11") in the same retrieval pool

**4.5 Graph as Optional Add-On**
- Mem0 gates graph behind Pro tier; this creates a two-class memory system
- If CLEO adds a knowledge graph layer, it should be first-class, not optional
- Half-implemented graph (no traversal, just storage) adds overhead without benefit

**4.6 Real-Time Extraction During Live Agent Work**
- Extracting memories synchronously during task execution adds latency and can interfere with reasoning
- Letta's sleep-time compute addresses this by separating extraction from conversation
- CLEO should extract/consolidate at session boundaries, not mid-task

**4.7 Trusting Unverified Claims**
- The worst noise in BRAIN comes from agent-generated observations that were never verified
- Observations should have a `confidence` field and a `source_type` field (owner-stated vs agent-inferred vs task-outcome)
- Owner-stated facts have highest reliability; agent-inferred facts should degrade over time without confirmation

**4.8 Ignoring Context Rot**
- Adding more memory context is not always better
- Chroma's 2025 research ("Context Rot") proved that every token added depletes attention budget
- CLEO's memory bridge size should have a hard token budget (recommend: 1500-2000 tokens max)
- When budget exceeded: compress, summarize, or tier (inject only the highest-priority memories)

---

## 5. The Ideal Tiered Memory Architecture for CLEO

Based on industry best practices, CLEO should implement a four-tier architecture:

```
TIER 0: Working Memory (In-Context)
├── Current task details (from cleo show)
├── Active session context (from cleo briefing)
├── Relevant procedural rules (top 5 by priority)
└── Recent decisions from current session
    Budget: 1500-2000 tokens
    Lifecycle: volatile, cleared at session end

TIER 1: Session Memory (Near-Term)
├── Session handoffs and sticky notes
├── Decisions made in last 3 sessions
├── Active task context for current epic
└── Recently retrieved factual memories
    Storage: brain.db (observations table)
    Lifecycle: 7-14 day recency window
    Retrieval: hot-path, pre-loaded at session start

TIER 2: Long-Term Semantic Memory (Persistent)
├── Factual observations (owner preferences, codebase facts)
├── Episodic records (task completions, patterns)
├── Procedural rules (coding standards, workflows)
└── Community summaries (topic clusters)
    Storage: brain.db (typed memory tables)
    Retrieval: on-demand, multi-strategy (vector + BM25)
    Lifecycle: quality-gated (score < 30 pruned after 30 days)

TIER 3: Archival Memory (Cold Storage)
├── Completed session transcripts
├── Historical task records (via cleo archive)
├── Deprecated observations (marked invalid_at)
└── Raw agent output files (.cleo/agent-outputs/)
    Storage: brain.db archival tables + filesystem
    Retrieval: explicit query only, not auto-injected
    Lifecycle: permanent (for audit trail)
```

### Injection Pattern (Harness-Agnostic)

The memory bridge file (`.cleo/memory-bridge.md`) is the right approach for provider-agnostic injection. Every LLM provider processes markdown in system prompts. Recommendations:

1. **Structure the bridge** as sections matching tier importance: Working > Recent > Procedural > Factual
2. **Token budget enforcement**: bridge generator must count tokens and truncate low-priority sections first
3. **Stability over freshness**: pre-compose the bridge at session end (not per-turn) to enable prompt caching
4. **Typed sections**: `## Procedural Rules` / `## Current Context` / `## Recent Decisions` / `## Active Patterns` rather than a narrative blob

---

## 6. Extraction → Verification → Consolidation → Retrieval Pipeline

### Phase 1: Extraction (at session end, async)

```
INPUT: Raw session events (tool calls, task completions, decisions)
STEP 1: Parse structured events (task.complete, decision, observation)
STEP 2: For each event, run LLM extraction:
  - Identify factual claims (declarative)
  - Identify procedural rules (behavioral)
  - Identify episodic records (events with timestamps)
STEP 3: Assign initial confidence score based on source:
  - owner-stated: 0.95
  - task-outcome-verified: 0.80
  - agent-inferred: 0.55
  - speculative: 0.30
OUTPUT: Typed candidate observations with confidence scores
```

### Phase 2: Verification (conflict detection)

```
INPUT: Candidate observations
STEP 1: Embed each candidate
STEP 2: Query existing brain.db for top-3 similar observations (cosine > 0.85)
STEP 3: For each similar pair:
  - If SAME claim: merge, boost retrieval count, raise confidence
  - If CONTRADICTING claim: mark old as invalid_at=now, store new as authoritative
  - If EXTENDING claim: link new as related to old, store new
STEP 4: Entity resolution:
  - Extract entities from candidate
  - Match against canonical entity table
  - Normalize before storage
OUTPUT: Verified, deduplicated observations with entity links
```

### Phase 3: Consolidation (quality scoring + pruning)

```
INPUT: Full brain.db observation set (run weekly or after 50+ new observations)
STEP 1: Score each observation:
  quality = (confidence * 0.3) 
          + (recency_score * 0.2)      # recent = high
          + (retrieval_utility * 0.3)  # was it used?
          + (specificity * 0.2)        # precise > vague
STEP 2: Community clustering:
  - Group observations by entity and topic
  - For clusters > 10 observations, generate community summary
  - Store summary as TIER 2 node; individual observations demote to TIER 3
STEP 3: Pruning:
  - quality < 0.30 AND age > 30 days: archive to TIER 3
  - invalid_at IS NOT NULL AND age > 90 days: delete (keep audit log entry)
  - Procedural rules with no retrieval in 60 days: lower priority
OUTPUT: Healthy brain.db with quality scores, community summaries, pruned noise
```

### Phase 4: Retrieval (at session start and on-demand)

```
INPUT: Query (task context, user message, topic)
STEP 1: Multi-strategy parallel search:
  a. Vector similarity (semantic): embed query → cosine search
  b. BM25 keyword: tokenize query → keyword match
  c. Entity lookup: extract entities from query → direct lookup
STEP 2: Score fusion:
  final_score = (0.5 * vector_score) + (0.3 * bm25_score) + (0.2 * entity_score)
  Apply quality multiplier: final_score *= observation.quality_score
  Apply recency boost: +0.1 for observations < 7 days old
STEP 3: Re-rank top-20 by final_score
STEP 4: Type-based injection:
  - Procedural rules → inject into working memory unconditionally (top 5)
  - Factual observations → inject top-10 by score
  - Episodic records → inject only if directly relevant to current task
  - Community summaries → inject if topic overlap > 0.7
STEP 5: Token budget enforcement:
  - Count tokens for assembled bridge
  - If > 2000 tokens: drop episodic records first, then factual, never procedural
OUTPUT: Token-budgeted memory bridge ready for injection
```

---

## 7. Benchmark Reference

| System | LongMemEval Score | LOCOMO Score | Notes |
|--------|-------------------|--------------|-------|
| Hindsight | **91.4%** | — | Highest published LongMemEval |
| Mastra (Observational Memory) | **95%** | — | Observational log method, no dynamic retrieval |
| Zep / Graphiti | 71.2% | — | Temporal KG focus |
| SuperMemory | 81.6% | — | GPT-4o backbone |
| Mem0 | 66.9% LLM Score | 66.9% vs 52.9% OpenAI | 26% better than OpenAI Memory |
| Mem0g (graph variant) | 68.4% | — | 2.59s p95 vs 1.44s for vector-only |
| Full-context baseline | 60.2% | ~25K tokens | Most token-expensive |
| OpenAI Memory (ChatGPT) | — | 52.9% | Lowest dedicated system |
| LangMem | Not published | — | |
| Letta Filesystem | 74.0% (LoCoMo) | — | Simple file-based histories |

**Key insight**: Hindsight (91.4%) and Mastra (95%) both outperform complex vector+graph systems. Hindsight through multi-strategy retrieval + synthesis; Mastra through stable pre-composed context. CLEO should learn from both — stable memory bridge (Mastra) for tier 0/1, multi-strategy retrieval (Hindsight) for tier 2 on-demand queries.

---

## 8. CLEO-Specific Recommendations

### 8.1 Immediate (close within T549 epic)

1. **Token budget enforcement on memory bridge** — Add token counting to `cleo refresh-memory`. Hard cap at 1800 tokens. When exceeded, drop Tier 1 episodic first, then observations, never procedural or active context.

2. **Typed observation schema** — Extend brain.db `observations` table with:
   - `memory_type`: ENUM(factual, episodic, procedural, working)
   - `confidence`: FLOAT (0-1)
   - `source_type`: ENUM(owner-stated, task-outcome, agent-inferred)
   - `valid_at`: TIMESTAMP
   - `invalid_at`: TIMESTAMP (NULL = still valid)
   - `quality_score`: FLOAT (computed)

3. **Deduplication gate at write time** — Before `cleo observe` completes, check cosine similarity against top-5 existing observations. If similarity > 0.85 and same claim, merge. If contradicting, invalidate old.

### 8.2 Near-Term (within 2-3 sprints)

4. **Sleep-time consolidator** — Extend `cleo session end` to trigger an async consolidation pass: dedup, quality-score, generate community summaries, prune below threshold.

5. **Dual-strategy retrieval** — Extend `cleo memory find` to run vector + BM25 in parallel, score-fuse results, apply quality multiplier.

6. **Temporal validity queries** — Add `cleo memory find --at "2026-04-01"` to query brain state at a historical point (for debugging agent decisions).

### 8.3 Longer-Term (T549 roadmap)

7. **Observation link graph** — Generate bidirectional links between related observations at write time. Enable multi-hop queries like "find all observations related to T523 and their downstream effects."

8. **Entity normalization table** — Canonical entities with aliases, referenced from observations. Enables "tell me everything BRAIN knows about owner's preferences" to aggregate across all aliases.

9. **Procedural memory self-improvement** — Compare procedural rules against task outcome patterns; auto-update rules that are consistently violated with good outcomes.

10. **Memory quality dashboard** — `cleo brain health` showing: total observations, quality distribution, retrieval utility ratio, stale (invalid) entries, community cluster count.

---

## 9. Sources

- Vectorize.io: Best AI Agent Memory Systems 2026 (comparison article)
- arXiv 2504.13171: Sleep-time Compute (Letta, April 2025)
- arXiv 2502.12110: A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025)
- arXiv 2501.13956: Zep: A Temporal Knowledge Graph Architecture for Agent Memory (January 2025)
- arXiv 2504.19413: Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (ECAI 2025)
- Chroma Research: Context Rot (July 2025) — 18 frontier models tested
- Liu et al., TACL 2024: Lost in the Middle — U-shaped recall curve
- LangChain LangMem SDK Launch (February 2025)
- mem0.ai/blog/state-of-ai-agent-memory-2026 (State of AI Agent Memory 2026)
- Mastra Research: Observational Memory — 95% LongMemEval
- Hindsight Benchmarks GitHub: vectorize-io/hindsight-benchmarks
- OpenAI Memory announcement and updates (April 2025, June 2025)
- ChatGPT Memory reverse-engineering analysis (Shlok Khemani, September 2025)
- IAAR-Shanghai/Awesome-AI-Memory (curated research list, 2026)

---

*Output written by research subagent. See MANIFEST.jsonl for entry.*
