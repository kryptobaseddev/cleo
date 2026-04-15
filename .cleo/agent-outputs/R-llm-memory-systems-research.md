# LLM-Managed Memory Systems: State of the Art Research Report

**Date**: 2026-04-13
**Scope**: Production-ready techniques for LLM-managed memory in AI coding agents
**Confidence**: HIGH -- based on 40+ sources including peer-reviewed papers, production system docs, and benchmark data

---

## Executive Summary

The field of AI agent memory has undergone a fundamental shift between 2024-2026. Memory is no longer treated as a storage problem (vector DB + keyword search). The state-of-the-art systems treat memory as a **cognitive substrate** -- the LLM itself manages what to remember, what to forget, and how to organize knowledge.

Five architectures dominate production systems in 2026:

1. **Observational Memory** (Mastra) -- background agents compress conversations into dense observation logs. 95% on LongMemEval. No vector DB needed.
2. **Tiered Self-Editing Memory** (Letta/MemGPT) -- OS-inspired memory hierarchy where the agent manages its own context via tool calls. Git-backed context repositories for coding agents.
3. **Hybrid Triple-Store** (Mem0) -- vector + graph + key-value stores with LLM-driven extraction and conflict resolution. 68% on LOCOMO with graph enhancement.
4. **Temporal Knowledge Graph** (Zep/Graphiti) -- bitemporal knowledge graph with validity windows on every fact. Best for domains where facts change over time.
5. **Structured Retain-Recall-Reflect** (Hindsight) -- four memory networks (world, experience, opinion, observation) with multi-strategy retrieval and synthesis. 91.4% on LongMemEval.

**The key insight for CLEO**: The winning pattern is not better retrieval -- it is better write-time processing. Systems that extract structured knowledge at ingestion time and use LLM-driven consolidation dramatically outperform systems that store raw data and try to retrieve it later.

---

## 1. LLM-as-Memory-Manager

### How the Best Systems Work

**Letta (MemGPT) Architecture**:
- Three memory tiers: core memory (in-context, like RAM), recall memory (conversation history, searchable), archival memory (long-term, vector DB)
- The LLM manages data movement between tiers via function calls it generates itself
- Core memory consists of editable "memory blocks" -- labeled sections with descriptions and size limits
- Sleep-time agents run during idle periods to consolidate and rewrite memory blocks
- As of March 2026: Context Repositories store agent context as git-tracked files. Agents can write scripts and spawn subagents to programmatically restructure their own context
- Skill Learning: agents distill successful patterns into `.md` skill files that persist across sessions

**Mem0 Architecture**:
- Three storage backends working in parallel: vector store (semantic search), key-value store (fast exact lookups), graph store (relationship modeling)
- Memory scoping at four dimensions: `user_id`, `agent_id`, `run_id`, `app_id`
- On write: LLM extracts structured facts from raw input, detects contradictions with existing memories, updates or creates entries
- On read: parallel retrieval across all three stores, reranking with cross-encoder
- Self-editing: when new info contradicts existing memory (e.g., user moved from SF to NY), the system updates the record rather than creating a duplicate

**Hindsight Architecture**:
- Memory bank M = {W, B, O, S} -- four epistemically distinct networks:
  - **W (World)**: objective facts about the world
  - **B (Beliefs)**: agent's evolving opinions/preferences
  - **O (Observations)**: raw episodic records
  - **S (Summaries)**: synthesized entity summaries
- Three operations: **retain** (add new memory), **recall** (retrieve relevant memories), **reflect** (synthesize across memories to produce answers and update beliefs)
- TEMPR retrieval runs four parallel searches: semantic vector, BM25 keyword, graph traversal, temporal filtering -- merged via Reciprocal Rank Fusion + neural reranker
- CARA reflection layer applies configurable disposition parameters (skepticism, literalism, empathy) for consistent reasoning

### Concrete Implementation Recommendation for CLEO

Replace the current keyword extraction with an **LLM extraction gate** that runs at write time. The prompt pattern:

```
You are the memory manager for a coding agent working on project "{project_name}".

Given this interaction transcript, extract memories worth keeping. For each memory:

1. CLASSIFY the type: decision | pattern | preference | fact | mistake | insight
2. EXTRACT the core content in one clear sentence
3. ASSIGN importance: critical (affects architecture) | high (affects workflow) | medium (useful context) | low (nice to know)
4. IDENTIFY entities: what files, functions, packages, or concepts are referenced?
5. DETECT conflicts: does this contradict any of these existing memories? {existing_memories}

Rules:
- Extract the WHY, not just the WHAT. "We chose SQLite because WAL mode prevents corruption during concurrent reads" beats "We use SQLite."
- If the user corrected a previous decision, mark the old memory as SUPERSEDED and create the new one.
- Ignore: tool output noise, file contents that were just read, routine status messages.
- Maximum 5 memories per interaction. Quality over quantity.

Output as JSON array of memory objects.
```

This prompt pattern is derived from production patterns in Mem0 and Hindsight. The key innovations:
- Type classification enables downstream routing (decisions go to a different store than patterns)
- Importance scoring at write time eliminates the need for post-hoc quality scoring
- Conflict detection at write time prevents the duplicate/contradiction accumulation problem
- Entity extraction at write time enables graph construction without a separate pass

---

## 2. Semantic Extraction

### What Works in Production

**Mem0's Extraction Pipeline**:
1. Raw input goes through an entity extractor that identifies nodes (people, projects, concepts)
2. A relations generator infers labeled edges between entities
3. A conflict detector compares new extractions against existing graph before writing
4. Facts are stored with both vector embeddings and graph structure simultaneously

**Hindsight's Retain Pipeline**:
1. Each conversation turn is processed into structured "memory atoms"
2. Each atom gets: content, entities mentioned, timestamp, source session ID
3. Atoms are embedded for vector search AND linked into an entity graph
4. Entity summaries are maintained and updated incrementally

**A-MEM's Zettelkasten Pipeline** (NeurIPS 2025):
1. Each new memory becomes a "note" with: concise description, tags, creation date, source
2. The LLM analyzes the note against ALL existing notes to find connections
3. Links are established where meaningful similarities exist
4. Critically: when a new note is linked to existing ones, the existing notes' descriptions and tags are UPDATED to reflect the new connection
5. This creates a self-evolving knowledge network that gets richer over time

**Mastra's Observational Memory**:
- The Observer agent watches conversations and produces structured observations
- Each observation is: a dated, prioritized note about a specific event (user statement, agent action, tool result, preference)
- Format is plain text with emoji priorities and timestamps -- no structured objects needed
- Three-date model per observation: observation date, referenced date, relative date offset
- Compression ratio: 3-6x for text content, 5-40x for tool-call-heavy workloads

### Concrete Extraction Prompt Pattern for CLEO

For a coding agent, the extraction should be domain-specific. Here is the prompt pattern for extracting structured knowledge from coding sessions:

```
You are analyzing a coding agent session to extract durable knowledge.

Session context:
- Project: {project_name}
- Task: {task_title} ({task_id})
- Files touched: {file_list}

Transcript:
{transcript_chunk}

Extract knowledge in these categories:

DECISIONS: Architectural or design choices with rationale
  Format: "Decided to {action} because {reason}. Alternatives considered: {alternatives}."

PATTERNS: Recurring approaches that worked or failed
  Format: "When {situation}, {approach} works because {reason}."
  Format: "When {situation}, avoid {approach} because {reason}."

CODEBASE_FACTS: Structural facts about the code
  Format: "{component} depends on {component} via {mechanism}."
  Format: "{file/function} is responsible for {purpose}."

CONSTRAINTS: Rules or limitations discovered during work
  Format: "{constraint} applies to {scope} because {reason}."

CORRECTIONS: Mistakes made and their fixes
  Format: "Bug: {description}. Root cause: {cause}. Fix: {fix}."

For each extraction:
- confidence: 0.0-1.0 (how certain is this knowledge?)
- durability: session | sprint | permanent (how long is this relevant?)
- entities: list of code symbols, files, packages referenced

Output JSON. Maximum 7 extractions per chunk. Prefer fewer high-quality extractions.
```

---

## 3. Memory Consolidation

### How Production Systems Handle It

**The Four-Layer Consolidation Model** (from production patterns across Mem0, Letta, and independent systems):

**Layer 1: Deduplication**
- Run at write time, not batch
- Compare new extraction against existing memories using both embedding similarity AND entity overlap
- Threshold: if cosine similarity > 0.85 AND entities overlap > 50%, treat as potential duplicate
- LLM adjudicates: "Are these two memories saying the same thing? If yes, produce one canonical version."

**Layer 2: Contradiction Resolution**
- When a new fact conflicts with an existing one (e.g., "project uses PostgreSQL" vs "project uses SQLite"):
- Check timestamps -- newer wins by default
- Check source authority -- user statement > agent inference
- Mark the old memory as SUPERSEDED with a pointer to the replacement
- Never delete -- maintain the audit trail

**Layer 3: Strengthening (Connection Reinforcement)**
- When the same pattern is observed in multiple sessions, increase its confidence score
- When a decision is referenced in subsequent work (e.g., "as we decided in T523"), strengthen the link between the decision memory and the referencing work
- A-MEM's key insight: when a new note links to existing notes, update the existing notes' metadata to reflect the connection

**Layer 4: Consolidation Sweep (Sleep-Time)**
- Run asynchronously after session end or during idle periods
- Use a cheaper/faster model (Haiku-class) for bulk processing
- The consolidation prompt:

```
You are consolidating memories for a coding agent. Here are the current memories
and today's new session memories.

Current memories:
{current_memories_json}

New session memories:
{session_memories_json}

Produce a consolidated memory set following these rules:
1. KEEP only durable information (preferences, architectural decisions, stable patterns)
2. DROP session-only context (containing "this time", "right now", "currently debugging")
3. DEDUPLICATE: if two memories say the same thing, keep one canonical version
4. CONFLICT RESOLUTION: if memories conflict, keep the most recent. Mark the old one superseded.
5. STRENGTHEN: if a pattern appears in multiple sessions, increase its confidence
6. AGING: memories older than 30 days with importance <= "low" -> mark for pruning
7. SYNTHESIS: if 3+ related memories can be combined into one higher-order insight, do it

Output the consolidated set as JSON with change annotations (kept/merged/superseded/pruned/synthesized).
```

**Microsoft Foundry Agent Service** (production since late 2025) implements exactly this three-phase model: extraction -> consolidation -> retrieval, using LLMs at every stage.

**TiMem** (state-of-the-art as of Feb 2026) uses temporal-hierarchical consolidation:
- Memories are organized in time-based tiers
- Semantic clustering groups related memories before consolidation
- Achieves 75.3% on LoCoMo and 76.9% on LongMemEval while reducing recalled memory length by 50%+

### CLEO-Specific Consolidation Architecture

Given CLEO's existing SQLite-based brain with 309 graph nodes and 231 edges, the consolidation system should:

1. **At session end** (`cleo session end`): trigger extraction on the session transcript, produce candidate memories
2. **Dedup gate**: compare candidates against existing brain entries using embedding similarity (you already have sqlite-vec)
3. **LLM consolidation**: for any conflicts or near-duplicates, run the consolidation prompt
4. **Graph update**: for any entities mentioned in new memories, update or create graph nodes/edges
5. **Prune sweep** (weekly or on `cleo memory gc`): run aging + synthesis on the full memory store

---

## 4. Context Rot Prevention

### The Problem Quantified

- Chroma Research (2025) tested 18 frontier models: ALL exhibit degradation at every input length increment
- Performance drops 15-30% as context stretches from 8K to 128K tokens
- The "lost in the middle" effect: models recall information at the beginning or end of prompts, but performance significantly degrades for information in the middle
- Cognition (Devin) measured: agents spend 60%+ of their first turn just retrieving context, and each search result stays in context for the rest of the session, accumulating like sediment

### What Actually Works

**Anthropic's Three Production Techniques** (from their context engineering guide):

1. **Compaction**: Summarize conversation when nearing context limit. Preserve: architectural decisions, unresolved bugs, implementation details. Discard: redundant tool outputs, completed steps. Continue with compressed context + 5 most recently accessed files.

2. **Structured Note-Taking**: Agent maintains a persistent file (like NOTES.md or a TODO list) outside the context window. Notes get pulled back in at relevant moments. Claude Code uses this for tracking progress across complex tasks.

3. **Sub-Agent Architectures**: Specialized sub-agents handle focused tasks with clean context windows. Each explores extensively (10K+ tokens) but returns only a condensed summary (1-2K tokens). Main agent coordinates with high-level plan.

**Mastra's Observational Memory** (the current benchmark leader):
- Two background agents (Observer + Reflector) maintain a dense observation log
- Observer runs when message history hits a token threshold (not time-based)
- Observations REPLACE the messages they summarized -- append-only log
- Reflector runs when observations accumulate past a second threshold -- restructures, combines, drops redundant
- Context window is completely stable and prompt-cacheable between turns
- Average context window size for entire LongMemEval run: ~30K tokens
- Compression: 3-6x for text, 5-40x for tool calls

**Key insight from production systems**: The distinction between "compaction" (bulk summarization when full) and "observation" (incremental event logging as it happens) matters enormously. Observational approaches preserve specific events, decisions, and details that compaction loses.

### Concrete Context Management Strategy for CLEO

```
CONTEXT BUDGET ALLOCATION (per session):
  System prompt + CLAUDE.md injection:  ~3K tokens (fixed)
  Memory bridge (hot memories):         ~2K tokens (curated)
  Task context (current task + deps):   ~2K tokens (dynamic)
  Active working context:               remaining budget
  
COMPACTION TRIGGERS:
  - At 70% context utilization: compress tool outputs older than 5 turns
  - At 85%: run observer to compress conversation history into observations
  - At 95%: emergency compaction -- keep only: task state, active observations, last 3 turns

WHAT TO ALWAYS KEEP (never compress):
  - Current task description and acceptance criteria
  - Active architectural decisions affecting current work
  - Error states and their root causes (if debugging)
  - File paths and symbols currently being modified

WHAT TO AGGRESSIVELY COMPRESS:
  - Tool call outputs (file reads, grep results) older than 5 turns
  - Exploration dead ends (paths tried and abandoned)
  - Verbose build/test output (keep only pass/fail + error messages)
  - Repeated status checks
```

---

## 5. Neural Graph Memory

### How Graph Memory Compares

**Benchmark Data** (from Mem0's published comparisons):

| Approach | LLM Score | Latency (p95) | Token Cost |
|----------|-----------|---------------|------------|
| Full Context | 72.9% | 17.12s | ~26K/conv |
| Mem0 (vector only) | 66.9% | 1.44s | ~1.8K/conv |
| Mem0g (vector + graph) | 68.4% | 2.59s | ~1.8K/conv |
| RAG baseline | 61.0% | 0.70s | - |
| OpenAI Memory | 52.9% | - | - |

**When graph beats vector**:
- Multi-hop reasoning: "User works with Python -> for data pipelines -> using pandas -> at a company that uses dbt -> migrating from Spark"
- Temporal reasoning: "Alice was project lead until January, then Bob took over"
- Entity relationships: supplier -> part -> product chains
- Contradiction detection: graph structure makes conflicts between entities visible

**When vector is sufficient**:
- Simple preference recall ("user prefers dark mode")
- Similarity-based retrieval ("find memories about database configuration")
- Low-latency requirements (graph adds ~1s overhead)

**Zep/Graphiti's Temporal Knowledge Graph**:
- Every fact has explicit validity windows (valid_from, valid_to)
- Bitemporal model: system time (when recorded) + assertion time (when true in reality)
- Community detection groups related entities into navigable subgraphs
- Handles contradiction by tracking temporal validity rather than overwriting

**Graph Memory for Code Intelligence** (directly relevant to CLEO/Nexus):
- Nodes: files, functions, classes, packages, decisions, patterns
- Edges: calls, imports, depends-on, decided-by, supersedes, related-to
- This is essentially what CLEO's Nexus already does (11,261 nodes, 20,276 relations)
- The gap: Nexus indexes CODE structure but not MEMORY structure
- The opportunity: connect brain (memory) nodes to nexus (code) nodes

### Concrete Graph Architecture for CLEO Brain

The existing brain has 309 nodes and 231 edges. Here is how to evolve it:

**Node Types**:
- `decision`: architectural/design decisions with rationale
- `pattern`: recurring approaches (successful or failed)
- `fact`: codebase structural facts
- `constraint`: discovered rules/limitations
- `entity`: code symbols, packages, files (link to Nexus)
- `session`: session summaries with key outcomes

**Edge Types**:
- `supersedes`: newer decision replaces older one (temporal chain)
- `supports`: evidence supporting a decision
- `contradicts`: conflicting information (flagged for resolution)
- `references`: memory mentions a code entity
- `caused_by`: causal chain (bug -> root cause -> fix)
- `related_to`: general semantic relationship

**Retrieval Strategy** (multi-hop):
1. Query embedding -> find top-5 similar nodes via vector search
2. For each hit, traverse 1-2 hops outward via edges
3. Score traversed nodes by: relevance to query + recency + importance
4. Return assembled subgraph context (not just individual facts)

This hybrid approach (vector search for entry points, graph traversal for context expansion) is the pattern used by Mem0g and Graphiti in production.

---

## 6. Self-Improving Memory

### How Systems Measure and Improve Memory Quality

**Hindsight's Feedback Loop**:
- Confidence scores on beliefs that update as new evidence arrives
- When new information supports a belief -> confidence increases
- When new information contradicts -> confidence decreases, conflict flagged
- Beliefs below a confidence threshold are marked uncertain and presented differently

**Letta's Skill Learning**:
- After successful task completion, agent distills the approach into a reusable skill
- Skills are `.md` files with: description, trigger conditions, step-by-step procedure
- Skills are git-tracked, shareable, and loadable on demand
- A `/skill` command enters skill learning mode -- agent reflects on what worked
- Skills that are never retrieved during recall eventually get pruned

**Trajectory-Informed Memory** (arXiv 2603.10600):
- Extract "tips" from successful AND failed agent trajectories
- Tips are generalized (remove entity-specific details) and clustered by subtask type
- LLM consolidation merges redundant tips within each cluster
- Tips stored with dual representations: vector embeddings + structured metadata
- Creates a feedback loop: agents receiving tips avoid failure patterns, producing better trajectories

**Memory-Driven Expectation Maximization** (ICLR 2026 submission):
- Memory table stores state-action pairs from previous episodes
- Q-values estimate which actions are high-quality in which states
- The LLM prior gets refined by sampling from memory table
- Each episode updates both the memory table and the LLM's action distribution

### Self-Improvement Metrics Stack

**Layer 1 -- Task Effectiveness** (outcome):
- Task completion rate with vs without memory
- Time to completion with vs without relevant memories retrieved
- Error rate (did memory prevent repeating a known mistake?)

**Layer 2 -- Memory Quality** (internal):
- Precision: % of retrieved memories actually relevant to the query
- Recall: % of relevant memories successfully retrieved
- Contradiction rate: how many conflicting facts exist in the store
- Staleness: age distribution of memories, % older than threshold

**Layer 3 -- Efficiency** (cost):
- Tokens consumed by memory content per session
- Retrieval latency (p50, p95)
- Storage growth rate over time
- Consolidation cost (LLM calls per sweep)

### Concrete Self-Improvement System for CLEO

```
MEMORY QUALITY SCORING (run at retrieval time):

For each retrieved memory, track:
  - was_used: did the agent reference this memory in its response? (heuristic: check output)
  - task_outcome: did the task succeed? (from cleo complete)
  - retrieval_rank: position in retrieval results
  - age_at_retrieval: how old was this memory?

FEEDBACK SIGNAL:
  - Memory was retrieved AND used AND task succeeded -> reinforce (+0.1 quality)
  - Memory was retrieved AND NOT used -> neutral (maybe irrelevant retrieval)
  - Memory was retrieved AND used AND task FAILED -> signal for review (-0.05 quality)
  - Memory was NEVER retrieved in 30 days -> candidate for archival/pruning

PERIODIC REVIEW (on cleo memory gc or weekly):
  1. Find memories with quality < 0.3 -> present for human review or auto-prune
  2. Find memories retrieved 5+ times with quality > 0.8 -> promote to "core" tier
  3. Find clusters of 3+ related memories -> suggest consolidation into higher-order insight
  4. Find contradicting memory pairs -> flag for resolution
```

---

## 7. Practical Patterns for Coding Agents

### What's Different About Coding Agent Memory

Coding agents have fundamentally different memory needs than chatbots:

1. **Codebase is the ground truth** -- memories must stay synchronized with actual code state
2. **Decisions have architectural weight** -- "we chose X because Y" matters for months
3. **Patterns compound** -- a successful debugging approach used 5 times should become procedure
4. **Context is structured** -- files, functions, symbols, packages have explicit relationships
5. **Sessions are task-oriented** -- memory should be organized around work items, not conversations

### Production Patterns from State-of-the-Art Systems

**Letta Code's Memory Architecture** (March 2026):
- Context Repositories: agent context stored as git-tracked markdown files
- Agent can write scripts to programmatically restructure its own context
- Memory subagents periodically review sessions to rewrite context and refine memory
- `/init` learns from old Claude Code/Codex sessions
- `/doctor` cleans up and reorganizes memories
- Decouples agent memory from model provider -- switch models, keep memory

**Claude Code's Internal Approach** (from Anthropic's engineering guide):
- CLAUDE.md files are "core memory" -- always in context, checked into repo
- Progressive disclosure: agent discovers context through exploration, not bulk loading
- Lightweight identifiers (file paths, stored queries) instead of full data in context
- Compaction preserves: architectural decisions, unresolved bugs, implementation details
- Discards: redundant tool outputs, completed routine steps

**Codified Context Infrastructure** (arXiv 2602.20478, 108K-line C# system):
- Hot-memory "constitution": conventions, retrieval hooks, orchestration protocols
- 19 specialized domain-expert agents with isolated context
- Cold-memory knowledge base: 34 on-demand specification documents
- Key metric: infrastructure growth tracked across 283 development sessions

**Beads (Steve Yegge, 2026)**:
- Git-backed persistent context stored as versioned JSONL
- Structured task graph with dependency links (not flat TODO lists)
- Audit trail for decision forensics
- Survives branch switches, merges, session restarts

### The Memory Architecture CLEO Should Build

Based on this research, here is the recommended architecture combining the best patterns:

```
MEMORY TIERS (adapted from Letta + Hindsight + Observational Memory):

TIER 0 -- HOT CONTEXT (always in prompt, ~2K tokens)
  Source: memory-bridge.md (already exists)
  Content: last session handoff, active task context, critical decisions
  Update: on every session start/end
  Pattern: YAML frontmatter + markdown (Tian Pan's pattern)

TIER 1 -- WARM RETRIEVAL (fetched on demand, ~500 tokens per hit)
  Source: brain.db with vector search (sqlite-vec already wired)
  Content: decisions, patterns, constraints, codebase facts
  Retrieval: semantic search + entity graph traversal
  Update: LLM extraction gate at session end

TIER 2 -- COLD ARCHIVE (searched rarely, ~200 tokens per hit)
  Source: brain.db archival partition
  Content: historical decisions (superseded), old session summaries, low-confidence memories
  Retrieval: explicit search only (cleo memory find)
  Update: consolidation sweep moves entries here

TIER 3 -- CODE INTELLIGENCE (Nexus, already built)
  Source: nexus index (11K nodes, 20K relations)
  Content: symbol definitions, call graphs, communities, flows
  Retrieval: cleo nexus context / cleo nexus impact
  Bridge: link brain memory nodes to nexus code nodes via entity references

WRITE PATH (every session end):
  1. Session transcript -> LLM extraction gate -> candidate memories
  2. Candidate memories -> dedup check (embedding similarity against existing)
  3. Survivors -> entity extraction -> graph node/edge creation
  4. Conflicts detected -> mark old as superseded, create new
  5. All writes -> quality score initialized at 0.5

READ PATH (every session start + on-demand):
  1. Load Tier 0 (hot context) into system prompt
  2. On task start: retrieve Tier 1 memories matching task entities
  3. On explicit query: search across Tier 1 + Tier 2
  4. On code question: bridge to Tier 3 (Nexus)

BACKGROUND PROCESSES:
  - Session-end consolidation: extract + dedup + store (mandatory)
  - Weekly consolidation sweep: merge duplicates, prune stale, synthesize clusters
  - Quality feedback: track retrieval-use correlation, adjust scores
  - Sleep-time reflection: use cheap model to review recent memories, find patterns
```

### Observer/Reflector Pattern for CLEO Sessions

Adapted from Mastra's Observational Memory for coding agent use:

**Observer** (runs at token threshold during session):
```
You are observing a coding agent session. Convert the recent messages into
dense observations. Each observation should capture ONE specific event.

Format:
Date: {date}
- {priority_emoji} {time} {observation}
  - {supporting detail if needed}

Priority levels:
- RED: Architectural decisions, breaking changes, critical bugs found
- YELLOW: Implementation choices, patterns discovered, constraints found  
- GREEN: Routine actions, file reads, test runs

Rules:
- Capture the DECISION and its RATIONALE, not the discussion leading to it
- For tool calls: capture the outcome, not the invocation
- For file reads: capture what was LEARNED, not what was read
- For errors: capture the ROOT CAUSE, not the stack trace
- Maximum 10 observations per batch
```

**Reflector** (runs when observations exceed threshold):
```
You are reflecting on accumulated observations from a coding agent session.

Current observations:
{observations}

Restructure these observations:
1. COMBINE related observations about the same topic
2. IDENTIFY overarching patterns across observations
3. DROP observations that have been superseded by later ones
4. PRESERVE all architectural decisions and their rationale
5. PRESERVE all discovered constraints and bugs
6. ADD any cross-cutting insights that emerge from the full picture

Maintain the same date/priority/observation format.
```

---

## Benchmark Reference

| System | Architecture | LongMemEval Score | LoCoMo Score | Latency | Open Source |
|--------|-------------|-------------------|-------------|---------|-------------|
| Mastra OM | Observational (text) | 94.87% (gpt-5-mini) | -- | <100ms (cached) | Apache 2.0 |
| Hindsight | 4-network structured | 91.4% (Gemini-3 Pro) | 89.61% | 100-600ms | MIT |
| Supermemory | Memory + RAG | 85.2% (Gemini-3 Pro) | -- | -- | Closed |
| Mem0g | Vector + Graph + KV | 68.4% (LOCOMO) | 68.4% | 2.59s p95 | Apache 2.0 |
| Mem0 | Vector + KV | 66.9% (LOCOMO) | 66.9% | 1.44s p95 | Apache 2.0 |
| Zep/Graphiti | Temporal KG | 71.2% (gpt-4o) | -- | <200ms | Apache 2.0 (Graphiti) |
| Full Context | Dump everything | 60.2% (gpt-4o) | 72.9% | 17.12s | N/A |
| OpenAI Memory | Flat text | -- | 52.9% | -- | Closed |

---

## Implementation Priority for CLEO

### Phase 1: Replace Keyword Extraction with LLM Extraction Gate (HIGH IMPACT, MEDIUM EFFORT)
- Wire a prompt-based extraction at `cleo session end`
- Use the coding-agent-specific extraction prompt from Section 2
- Store typed memories (decision/pattern/fact/constraint/correction) instead of raw observations
- This alone will fix the "2440 noise patterns, 45+ junk entries" problem

### Phase 2: Write-Time Deduplication and Conflict Detection (HIGH IMPACT, MEDIUM EFFORT)
- Before storing new memories, check against existing via embedding similarity
- LLM adjudicates duplicates and conflicts
- Supersede old memories rather than accumulating contradictions
- This fixes the dedup problem that was flagged in the brain integrity crisis

### Phase 3: Observer/Reflector for Long Sessions (HIGH IMPACT, HIGH EFFORT)
- Implement the two-agent observational pattern for within-session compression
- Observer compresses tool outputs and conversation into dense event log
- Reflector periodically restructures accumulated observations
- This addresses context rot during long coding sessions

### Phase 4: Graph Memory Bridge (MEDIUM IMPACT, MEDIUM EFFORT)
- Connect brain memory nodes to Nexus code nodes via entity references
- When a decision memory mentions `packages/core/src/tasks/add.ts`, create a link
- Enable queries like "what decisions affect this file?" via graph traversal
- Nexus already has the code graph; brain already has the memory graph; bridge them

### Phase 5: Sleep-Time Consolidation (MEDIUM IMPACT, LOW EFFORT)
- Async job that runs after session end using a cheap model
- Merges duplicates, prunes stale entries, synthesizes patterns
- Weekly full sweep for deeper consolidation
- This is the "get smarter over time" loop

### Phase 6: Quality Feedback Loop (LOWER IMPACT, LOWER EFFORT)
- Track which memories are retrieved and used
- Correlate memory usage with task outcomes
- Promote high-utility memories, demote never-used ones
- This closes the self-improvement loop

---

## Sources

### Papers
- Xu et al. "A-MEM: Agentic Memory for LLM Agents" -- NeurIPS 2025. arXiv:2502.12110
- Rasmussen et al. "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" -- arXiv:2501.13956
- Chheda et al. "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" -- ECAI 2025. arXiv:2504.19413
- Kedia et al. "Hindsight: A Biomimetic Memory Architecture for Agents" -- arXiv:2512.12818
- Hu et al. "Memory in the Age of AI Agents: A Survey" -- arXiv:2512.13564
- Lin et al. "Sleep-time Compute: Beyond Inference Scaling at Test-time" -- arXiv:2504.13171
- "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and..." -- arXiv:2603.07670
- "Trajectory-Informed Memory Generation for Self-Improving Agent" -- arXiv:2603.10600
- "Codified Context: Infrastructure for AI Agents in a Complex Codebase" -- arXiv:2602.20478

### Production System Documentation
- Letta Blog: "Agent Memory: How to Build Agents that Learn and Remember" -- https://www.letta.com/blog/agent-memory
- Letta Blog: "Context Repositories: Git-based Memory for Coding Agents" -- https://www.letta.com/blog/context-repositories
- Letta Blog: "Skill Learning: Bringing Continual Learning to CLI Agents" -- https://www.letta.com/blog/skill-learning
- Letta Blog: "Continual Learning in Token Space" -- https://www.letta.com/blog/continual-learning
- Mastra Research: "Observational Memory: 95% on LongMemEval" -- https://mastra.ai/research/observational-memory
- Mem0 Blog: "State of AI Agent Memory 2026" -- https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Anthropic: "Effective context engineering for AI agents" -- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Graphiti/Neo4j: "Graphiti: Knowledge Graph Memory for an Agentic World" -- https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/

### Benchmarks and Comparisons
- VentureBeat: "Hindsight agentic memory provides 20/20 vision" -- https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision
- VentureBeat: "Observational memory cuts AI agent costs 10x" -- https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long
- Vectorize.io: "Best AI Agent Memory Systems in 2026" -- https://vectorize.io/articles/best-ai-agent-memory-systems
- Atlan: "Best AI Agent Memory Frameworks 2026" -- https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- DevGenius: "AI Agent Memory Systems in 2026 Compared" -- https://blog.devgenius.io/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8

### Context Engineering
- Chroma Research: "Context Rot" -- https://www.morphllm.com/context-rot
- Tian Pan: "Context Engineering for Personalization" -- https://tianpan.co/blog/2025-09-19-context-engineering-long-term-memory-ai-agents
- ByteByteGo: "A Guide to Context Engineering for LLMs" -- https://blog.bytebytego.com/p/a-guide-to-context-engineering-for
- Zylos Research: "LLM Context Window Management 2026" -- https://zylos.ai/research/2026-01-19-llm-context-management
