# T549-R5: Context Rot & Token Budget Management Research

**Date**: 2026-04-13
**Task**: T549 — CLEO Memory Architecture v2 (Research Phase)
**Research Strand**: R5 — Context Rot, Token Budget, JIT Memory Injection

---

## 1. Context Rot: The Science

### 1.1 What Is Context Rot?

Context rot is the measurable, continuous degradation in LLM output quality that occurs as input context length increases — well before any context window overflow. Chroma's 2025 study tested 18 frontier models (GPT-4.1, Claude Opus 4, Gemini 2.5 Pro, Qwen3-235B) and found **every single one** degrades with context length. Not some. All of them. The decline is continuous and begins immediately — not at some threshold.

Key distinction: context rot is not context overflow. A model with a 200K token window can exhibit significant rot at 20K tokens. The problem is signal-to-noise ratio, not capacity.

### 1.2 The Three Compounding Mechanisms

**Mechanism 1: Lost-in-the-Middle (Positional Bias)**

Liu et al. (Stanford/TACL 2024) — the most cited paper in LLM reliability — documented a U-shaped performance curve across context positions:

| Position | Relative Accuracy | Attention Quality |
|----------|-------------------|-------------------|
| Start (position 1) | Highest (~75%) | Strong primacy bias |
| Middle (positions 5-15 of 20) | Lowest (~45-55%) | Blind spot — 30%+ drop |
| End (last position) | High (~72%) | Strong recency bias |

In 20-document QA experiments, accuracy dropped by **more than 30%** when the relevant document sat in the middle. This effect:
- Persists across model sizes, architectures, and training approaches
- Is a fundamental property of softmax attention, not a bug
- Gets worse as context grows (position 5 of 20 is different from position 500 of 2000)

Adobe research (February 2025) confirmed that on multi-hop reasoning tasks, longer contexts cause compound degradation. Claude 3.5 Sonnet: 88% accuracy at small context → 30% at 32K tokens. The problem compounds for reasoning tasks requiring 2+ inference steps.

**Mechanism 2: Attention Dilution**

Transformer self-attention is quadratic. Each token computes weights against every other token. As context grows:

```
At 10K tokens:   attention_weight_per_relevant_token ≈ 1/10,000
At 100K tokens:  attention_weight_per_relevant_token ≈ 1/100,000
At 1M tokens:    attention_weight_per_relevant_token ≈ 1/1,000,000
```

Softmax normalization means the noise floor rises as context expands. The signal doesn't get louder — it gets proportionally quieter. A function that was clearly attended to at 5K tokens becomes one signal among thousands at 100K tokens.

**Mechanism 3: Distractor Interference**

Chroma isolated a third compounding mechanism: semantically similar but irrelevant content causes degradation beyond what context length alone explains. Topically-related distractors that are factually wrong are the most damaging. Crucially:

- Models performed *better* on shuffled haystacks than logically structured documents (across all 18 models)
- Structural coherence creates more plausible distractors, not fewer
- Code search (semantically similar function names, same domain) is the worst case

### 1.3 The 35-Minute Wall

Research on long-running agents (zylos.ai, January 2026) identified a critical threshold: every AI agent's success rate decreases after approximately 35 minutes of human-equivalent task time. The relationship is non-linear: doubling task duration quadruples the failure rate.

This corresponds to the point where context accumulation typically crosses 80K-150K tokens in coding agents. The compounding loop:
1. Degraded context → worse reasoning → mistakes
2. Mistakes → more search, more file reads → more context
3. More context → more degradation → worse reasoning

### 1.4 What the Research Says About "Sweet Spot"

There is no universal sweet spot — degradation begins immediately. The practical guidance from the literature:

- **Keep working context under ~10K tokens** for reasoning tasks requiring multi-hop inference
- **Signal-to-noise ratio matters more than total size** — 500 highly relevant tokens beats 10K mixed tokens
- **Position what matters at the start or end** — never bury critical information in the middle
- **Each LLM call should get the minimum tokens to do its job** — surgical injection, not bulk loading
- **Context engineering > context capacity** — the question is not "how much fits?" but "what belongs here?"

---

## 2. Current CLEO Injection Chain: Token Cost Analysis

### 2.1 Full Injection Chain Map

When Claude Code loads a CLEO project, the following chain resolves:

```
CLAUDE.md
  └── @AGENTS.md  (CAAMP injection)
        ├── @~/.agents/AGENTS.md
        │     └── @~/.local/share/cleo/templates/CLEO-INJECTION.md
        ├── @.cleo/project-context.json
        └── @.cleo/memory-bridge.md

+ Global PRINCIPLES.md (via ~/.claude/CLAUDE.md -> PRINCIPLES.md)
+ Base protocol (injected by claude code system prompt)
```

### 2.2 Measured Token Costs (2026-04-13)

| File | Bytes | Tokens (~4 chars/token) | Content Type |
|------|-------|------------------------|--------------|
| CLAUDE.md | 51 | ~13 | Entry stub |
| AGENTS.md | 9,349 | ~2,337 | Code quality rules + GitNexus |
| .cleo/project-context.json | 1,389 | ~347 | Project config |
| .cleo/memory-bridge.md | 3,670 | ~918 | Brain memory (current) |
| ~/.agents/AGENTS.md | 89 | ~22 | Global hub stub |
| CLEO-INJECTION.md | 2,259 | ~565 | CLEO protocol |
| PRINCIPLES.md | 2,573 | ~643 | Engineering principles |
| Base protocol (system prompt) | ~4,096 | ~1,024 | CLEO subagent protocol |

**GRAND TOTAL: ~19,476 bytes / ~5,869 tokens**

This is the token cost paid on every single agent invocation, before the agent reads the task, writes a line of code, or makes a single tool call.

### 2.3 Where Tokens Are Wasted

**Problem 1: AGENTS.md is 2,337 tokens of mostly static content**

The GitNexus section alone (lines 96-195 of AGENTS.md) is ~1,800 characters / ~450 tokens. It contains detailed instructions for a code intelligence tool. Agents working on memory architecture, documentation, or research tasks do not need this. It sits in the context at full weight regardless.

**Problem 2: Memory bridge is not token-budget-enforced in practice**

`BrainMemoryBridgeConfig.maxTokens` defaults to 2,000. But the memory bridge generator (`packages/core/src/memory/memory-bridge.ts`) only enforces this budget in the `contextAware` code path (`generateContextAwareContent`). The standard `writeMemoryBridge()` path uses fixed item counts (10 observations, 8 learnings, 8 patterns, 5 decisions) with no token budget enforcement. Current memory bridge is ~918 tokens — under the 2,000 limit — but the limit is not enforced in the standard path.

**Problem 3: Static injection at session start, never evicted**

The entire injection chain is loaded once at session start and stays loaded for the entire session. A 35-minute coding session accumulates tool results, file reads, and search results on top of the ~5,869 baseline tokens. By the 35-minute wall, the baseline has likely doubled or tripled.

**Problem 4: Middle-of-context placement for task-specific knowledge**

The task details (`cleo show T549`) are loaded *after* the 5,869-token baseline. This means task-specific context — the most important information for the agent — sits at an arbitrary position in a growing context, not at the primacy-biased start.

**Problem 5: All memory is treated as equal priority**

The memory bridge outputs recent observations, learnings, patterns, and decisions in recency order. There is no task-relevance scoring at session start. A learning about the auth system sits at equal weight as a learning directly relevant to the current task.

---

## 3. Token Budget Enforcement: Current State

### 3.1 The `maxTokens` Config Field

`BrainMemoryBridgeConfig`:

```typescript
/** Maximum token budget for memory bridge content (default: 2000). */
maxTokens: number;
```

### 3.2 Where It Is (and Isn't) Enforced

The budget is only enforced in `generateContextAwareContent()`, which:
1. Requires `brain.memoryBridge.contextAware: true` in config
2. Requires a session scope to be passed
3. Is only triggered when those conditions are met

The **default code path** (`writeMemoryBridge()`) uses fixed item counts only:

```typescript
const DEFAULT_CONFIG: MemoryBridgeConfig = {
  maxObservations: 10,
  maxLearnings: 8,
  maxPatterns: 8,
  maxDecisions: 5,
  includeHandoff: true,
  includeAntiPatterns: true,
};
```

There is no character counting, token estimation, or budget enforcement in the standard path. The output size is a function of how much data exists in brain.db and the text length of each item, not any budget target.

### 3.3 Quality vs. Recency Scoring

Learnings are filtered by confidence decay (effectiveConfidence >= 0.6) using a 90-day half-life. This is the only prioritization mechanism currently applied. There is no task-relevance scoring — a learning about SSH keys is weighted the same as a learning about the brain module.

---

## 4. JIT (Just-In-Time) Memory Injection: Design

The owner's request: "JIT injection of knowledge." Here is a concrete design.

### 4.1 Core Principle

**Static injection = bulk context loaded once, pays the cost for the entire session.**
**JIT injection = agent pulls what it needs, when it needs it, via tool calls.**

The JIT model requires:
1. Minimal baseline context (identity + task + protocol)
2. Agent-callable memory retrieval tools (already exist: `cleo memory find`, `cleo memory fetch`)
3. Agent awareness of when to pull more context
4. A retrieval budget per JIT call

### 4.2 What Triggers a JIT Memory Load?

Triggers (agent-detectable situations requiring deeper context):

| Trigger | Signal | What to Fetch |
|---------|--------|---------------|
| Unfamiliar domain | Agent hits a concept it hasn't seen | `cleo memory find "<domain>"` |
| Prior decision needed | "Has this approach been tried?" | `cleo memory find "<decision-topic>"` |
| Pattern question | "Is this the right pattern for X?" | `cleo memory find "<pattern-type>"` |
| Resuming work | Session starts on existing task | `cleo briefing` (handoff) |
| Blocked on history | "Why was X done this way?" | `cleo memory timeline <id>` |

The agent knows to pull when it hits uncertainty. This is observable in agent behavior — hesitation, hedging language, or the need to check prior work are all signals that memory retrieval would help.

### 4.3 Retrieval Budget Per JIT Call

Based on the research: each JIT call should return at most **300-500 tokens** of memory content. The 3-layer retrieval protocol already enforces this:

| Layer | Cost | Returns |
|-------|------|---------|
| `cleo memory find "query"` | ~50/hit | IDs + titles only — use to discover |
| `cleo memory timeline <id>` | ~200-500 | Temporal context around one entry |
| `cleo memory fetch <id>` | ~500/entry | Full entry details |

The agent should:
1. Call `find` first (cheap, ~50-100 tokens total)
2. Evaluate whether results are relevant
3. Fetch only the 1-2 entries that are directly relevant

This means a JIT retrieval costs 100-600 tokens total — versus 5,869 tokens at session start for all memory.

### 4.4 How the Agent Decides When It Has Enough

Termination criteria for a JIT retrieval session:
- The retrieved memory directly answers the question (certainty restored)
- The retrieved entries contain no new relevant information (low-confidence search result)
- The agent has made 3 JIT calls without resolution (escalate to human)

Budget limit: 2 JIT retrievals per task phase maximum before continuing with available context. Deep memory archaeology is a smell that the task is ambiguous.

### 4.5 Progressive Disclosure Pattern

```
Session Start (minimal baseline: ~1,000 tokens):
  - Identity: which project, which session
  - Task: what am I working on (cleo show {id})
  - Protocol: CLEO work loop (500 tokens CLEO-INJECTION.md)

Task Execution (JIT as needed):
  - Domain context: pulled on first encounter, ~300 tokens
  - Prior decisions: pulled when relevant pattern appears, ~300 tokens
  - Code quality rules: always needed → keep in baseline

Session End (full memory bridge refresh):
  - All accumulated context written to brain.db
  - Memory bridge regenerated with current session's knowledge
```

---

## 5. Attention-Optimal Context Strategy for CLEO

Based on the research, here is the recommended context strategy for CLEO agents:

### 5.1 Token Budget Targets

| Layer | Current | Recommended | Reasoning |
|-------|---------|-------------|-----------|
| Baseline static | ~5,869 | ~2,000 | 3x reduction; keep only what's always needed |
| Memory bridge | ~918 | ~500 | Strict budget enforcement, top-5 most relevant only |
| Task context | Variable | ~400 | Show only relevant fields, not full task |
| JIT retrieval | 0 | ~300/call | On-demand, capped per call |
| **Total working budget** | **~6,800+** | **~3,200** | **~50% reduction** |

### 5.2 Priority Ordering (Primacy Bias = High Attention)

Information at the **start** of context gets the most attention. Reorder the injection chain:

**Start (primacy slot — highest attention):**
1. Current task description + acceptance criteria (most important right now)
2. CLEO work loop (small, always needed)
3. Directly relevant memory (fetched JIT or pre-fetched for task)

**Middle (lower attention — put static reference material here):**
4. Code quality rules (important but mostly absorbed)
5. Project context (language, framework, patterns)

**End (recency bias — secondary attention slot):**
6. Session state (last handoff summary, blockers)
7. Extended memory bridge (lower-confidence, lower-recency items)

**Never in middle:**
- Critical task constraints
- Acceptance criteria
- Blocking decisions

### 5.3 Dynamic vs. Static Injection: The Optimal Split

| Content | Static | Dynamic/JIT | Rationale |
|---------|--------|-------------|-----------|
| CLEO work loop | Yes | No | Tiny (500 tokens), always needed |
| Code quality rules | Yes | No | High-frequency reference, always needed |
| Current task details | Yes (per task) | No | Refreshed per task, not per session |
| Project identity (name, language) | Yes | No | 50 tokens, always needed |
| Memory bridge (recent decisions) | Partial | JIT enrichment | Top 3 recent only statically |
| Domain-specific knowledge | No | JIT on trigger | Only when entering that domain |
| Prior decisions | No | JIT on trigger | Only when pattern appears |
| GitNexus instructions | No | JIT on trigger | Only for code editing tasks |

**The answer**: a small, permanent static baseline (~1,500-2,000 tokens) plus task-specific JIT enrichment.

### 5.4 When to Evict from Context (Running Context Management)

Context pruning strategy for long-running sessions:

1. **After a task phase completes**: evict all tool results from that phase, keep only the outcome
2. **After 20K tokens accumulated**: trigger compaction of tool call history
3. **On task switch**: full context reset except identity + new task
4. **Dead ends / backtrack moments**: mark search results as "explored, irrelevant" and evict

The key insight from the research: **never let failed exploration accumulate**. When an agent reads 5 files looking for a function and finds it in the 5th, the first 4 files should be evicted.

---

## 6. Recommendations for CLEO Memory Architecture v2

### 6.1 Immediate Wins (Low Effort, High Impact)

**R5-REC-1: Enforce maxTokens in the standard memory bridge path**

Current `writeMemoryBridge()` ignores `maxTokens`. Fix: apply the same character-budget logic as `generateContextAwareContent()` after assembling content. This prevents future memory bridge bloat as brain.db grows.

**R5-REC-2: Add task-relevance scoring to memory bridge generation**

Before writing the bridge, score each candidate entry (learnings, decisions, patterns) against the current session scope using keyword overlap or the existing `hybridSearch()`. Include the top-N by relevance score, not by recency. This converts the bridge from "recent = included" to "relevant = included."

**R5-REC-3: Reduce AGENTS.md static size by 40%**

GitNexus instructions are 450+ tokens. Extract them to a conditional block:
- If session scope is a code-editing task → inject GitNexus block
- Otherwise → skip it

**R5-REC-4: Put task context before memory bridge in injection order**

Currently, task context is loaded after the 5,869-token baseline. Invert this: inject task context first (highest primacy), then protocol, then memory bridge.

### 6.2 Medium-Term: JIT Memory Retrieval Protocol

**R5-REC-5: Create a "cold start" vs. "warm start" session protocol**

Cold start (new task, no relevant history):
- Baseline: identity + CLEO protocol + task context = ~1,500 tokens
- No memory bridge injection at start
- Agent pulls memory JIT as needed

Warm start (resuming task, known domain):
- Baseline: identity + CLEO protocol + task context = ~1,500 tokens
- Plus: handoff summary + last session's top-3 decisions for this task = ~500 tokens
- Agent still pulls domain memory JIT

**R5-REC-6: Add a `cleo context pull <task-id>` command**

A single command that:
1. Shows task details
2. Finds the top-5 brain.db entries relevant to this task (hybridSearch)
3. Returns a compact summary (~300 tokens) of relevant prior knowledge

This becomes the JIT trigger mechanism — agent calls it when entering a new domain or resuming work.

### 6.3 Long-Term: Typed Memory with JIT-Aware Categories

Based on owner's broader Memory Architecture v2 goals (typed memory — semantic/episodic/procedural):

**Semantic memory** (factual: "the brain module uses SQLite") — suitable for JIT retrieval, domain-triggered
**Episodic memory** (what happened: "T545 was completed with these decisions") — suitable for JIT, task-triggered
**Procedural memory** (how to: "always run biome before committing") — suitable for static injection, always needed

This maps cleanly to the static/JIT split:
- Procedural → always in baseline
- Episodic → JIT on task context match
- Semantic → JIT on domain entry

---

## 7. Summary

### Context Rot is Real and Universal
All 18 frontier models tested by Chroma degrade with context length. The mechanisms are: lost-in-the-middle (30%+ accuracy drop for middle-positioned content), attention dilution (quadratic cost = each token gets less weight as context grows), and distractor interference (similar-but-wrong content actively misleads the model). This is architectural, not a training problem.

### CLEO's Current Injection Chain Costs ~5,869 Tokens
Before an agent reads a single task or writes a line of code, ~5,869 tokens are consumed as static baseline. The largest contributors are AGENTS.md (2,337 tokens, includes content irrelevant to many tasks) and the base protocol (1,024 tokens). The memory bridge is reasonably sized (918 tokens) but could be more targeted.

### The maxTokens Budget Is Not Enforced in the Standard Path
`BrainMemoryBridgeConfig.maxTokens` (default 2,000) is only enforced in the `contextAware` code path. The default `writeMemoryBridge()` path uses fixed item counts with no character or token budget enforcement.

### JIT Injection Is the Right Architecture
The research converges on one answer: keep the reasoning model's context clean. Delegate memory retrieval to on-demand tool calls. The 3-layer retrieval protocol (find → timeline → fetch) already exists; CLEO just needs to reduce its static baseline and teach agents to use JIT retrieval proactively.

### Optimal Strategy
- Static baseline: ~1,500-2,000 tokens (identity + protocol + task + always-needed rules)
- Memory bridge: ~400-500 tokens enforced (top-5 most relevant to current task)
- JIT enrichment: ~300 tokens per retrieval call, triggered by uncertainty
- Total working budget target: ~2,500-3,000 tokens at any given moment

The owner's intuition is correct: more tokens = less attention per token. The fix is not better models — it is smaller, higher-signal context.

---

## Sources

- Liu et al. (2023/2024) — "Lost in the Middle: How Language Models Use Long Contexts" — Stanford/TACL. https://arxiv.org/abs/2307.03172
- Du et al. (2025) — "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval" — EMNLP 2025 Findings. https://aclanthology.org/2025.findings-emnlp.1264.pdf
- Chroma Research (2025) — "Context Rot" study, 18 frontier models. https://research.trychroma.com/context-rot
- Morph (2026) — "Context Rot: Why LLMs Degrade as Context Grows." https://www.morphllm.com/context-rot
- zylos.ai (January 2026) — "Long-Running AI Agents" — 35-minute wall research.
- Anthropic Engineering (September 2025) — "Effective Context Engineering for AI Agents." https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic Engineering — "Multi-Agent Research System" — 90.2% improvement with isolated subagent contexts.
- JetBrains Research (December 2025) — "Efficient Context Management" — NeurIPS 2025 DL4Code workshop.
- Liu, A. (LinkedIn, 2026) — "RAG vs Context Engineering: JIT injection, progressive disclosure."
- Context Engineering Guide (2026) — meta-intelligence.tech
- CLEO codebase: `packages/core/src/memory/memory-bridge.ts`, `packages/contracts/src/config.ts`, `packages/core/src/injection.ts`
