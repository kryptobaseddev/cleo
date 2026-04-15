# T549-CA3: JIT Memory Injection + Context Window Management Specification

**Spec ID**: CA3
**Date**: 2026-04-13
**Task**: T549 — CLEO Memory Architecture v2
**Author**: Architect subagent
**Status**: Complete
**ADR Authority**: Proposes new ADR (ADR-044-JIT-INJECTION)

---

## Executive Summary

Context rot is real, universal, and begins immediately. Every token added to static injection
costs attention weight on every token that follows. CLEO's current baseline of ~5,869 tokens
fires before an agent reads a single task or writes a single line of code. This spec defines:

1. A static baseline reduction plan cutting that cost to ~1,500 tokens
2. A JIT retrieval protocol with triggers, commands, and per-call budgets
3. A three-tier provider strategy matching JIT capability to harness support
4. A Memory Bridge v2 design (compact for JIT-capable, rich for static-only)
5. A new AGENTS.md structure that implements all of the above
6. Attention-optimal placement ordering based on lost-in-the-middle science
7. Token metrics to track and alert on

The target outcome: every agent session begins with ~1,500 tokens of high-signal context
instead of ~5,869 tokens of mixed-priority content.

---

## 1. Static Baseline Reduction Plan

### 1.1 Current Baseline Accounting

| File | Bytes | Est. Tokens | Audience |
|------|-------|-------------|---------|
| CLAUDE.md | 51 | 13 | Entry stub |
| AGENTS.md (code quality rules) | ~4,500 | ~1,125 | All agents |
| AGENTS.md (GitNexus block) | ~4,849 | ~1,212 | Code-editing sessions only |
| ~/.agents/AGENTS.md (stub) | 89 | 22 | Hub |
| CLEO-INJECTION.md | 2,259 | 565 | All agents |
| .cleo/project-context.json | 1,389 | 347 | All agents |
| .cleo/memory-bridge.md (current) | 3,670 | 918 | All agents |
| PRINCIPLES.md | 2,573 | 643 | All agents |
| Base protocol (system prompt) | ~4,096 | ~1,024 | All agents |
| **Total** | **~23,476** | **~5,869** | |

**Observation**: GitNexus (1,212 tokens) is loaded for every session — research, documentation,
memory architecture — but contains instructions relevant only when editing code with the GitNexus
MCP tools active. It is the single largest removable block.

### 1.2 What Gets CUT from the Static Baseline

**Cut entirely (move to JIT / conditional injection):**

| Block | Tokens | Rationale |
|-------|--------|-----------|
| GitNexus instructions (full block) | ~1,212 | Irrelevant unless editing code; tool not available in all sessions |
| PRINCIPLES.md full content | ~643 | SOLID/DRY/KISS principles are absorbed after first few sessions; consume tokens without active benefit |
| memory-bridge.md sections 3-5 | ~400 | Patterns, anti-patterns, older observations — low recency relevance |
| CLEO-INJECTION.md session quick reference table | ~120 | Duplicates the work loop; remove redundancy |

**Total tokens eliminated from static baseline: ~2,375 tokens**

### 1.3 What STAYS in the Static Baseline

**Keep (always relevant, high attention value):**

| Block | Tokens | Rationale |
|-------|--------|-----------|
| Project identity (name, type, language) | ~100 | 3 lines; always needed |
| CLEO work loop (commands table) | ~300 | Core protocol; procedural memory |
| Code quality rules (zero tolerance) | ~800 | Non-negotiable; always active |
| Quality gates (biome/build/test) | ~150 | Always relevant before completion |
| Runtime data safety (ADR-013) | ~125 | Prevents data loss; permanent constraint |
| Memory bridge v2 compact header | ~200 | Active task + top-3 recent decisions |
| JIT retrieval protocol (new) | ~150 | How to pull more context on demand |
| Base protocol (system prompt) | ~1,024 | Cannot change |

**Total static baseline target: ~2,849 tokens**

After accounting for reduced memory-bridge (from 918 to ~200 compact header):

**Realistic static baseline target: ~1,850 tokens** (excluding base protocol)
**Including base protocol: ~2,874 tokens** (vs. current ~5,869 — a 51% reduction)

### 1.4 Conditional Injection Blocks

Some content belongs in the static baseline only when certain conditions are met:

| Block | Condition | Trigger |
|-------|-----------|---------|
| GitNexus full instructions | Editing code AND GitNexus index fresh | Session scope contains code-editing intent |
| PRINCIPLES.md | Agent is making architecture decisions | Session scope = architecture/design |
| Rich memory bridge (top-10 entries) | No JIT tool use available (Tier 3 providers) | Provider detection at session start |
| Extended CLEO protocol (escalation) | Agent explicitly requests it | `cleo admin help` |

The mechanism for conditional injection is the CAAMP provider-detection flow at install/session-start.
For Claude Code, the `CLAUDE.md` `@`-reference chain handles static blocks. Conditional blocks require
a new CAAMP feature: a `<!-- conditional:code-editing -->` block comment syntax that CAAMP resolves
based on detected provider and session scope.

**Implementation note**: The conditional injection mechanism is a new capability requiring a CAAMP
extension. Until that extension ships, the pragmatic solution is to extract the GitNexus block into
a separate file (`.claude/context/gitnexus.md`) and reference it only from `CLAUDE.md` (Claude Code),
not from `AGENTS.md` (cross-provider). This reduces the cross-provider baseline immediately.

---

## 2. JIT Retrieval Protocol

### 2.1 Core Principle

Static injection pays the token cost for the entire session. JIT injection pays the cost
only at the moment of need, for exactly the content needed. The 3-layer retrieval protocol
already exists (ADR-021); this spec standardizes when agents invoke it.

```
Static baseline (~1,850 tokens):
  Identity + CLEO work loop + Quality rules + Memory compact header + JIT commands

JIT enrichment (on-demand, ~300 tokens/call):
  cleo memory find → cleo memory timeline → cleo memory fetch
  cleo show <id> → full task details
  cleo context pull <task-id> → task-relevant memory summary (NEW)
```

### 2.2 Trigger → Action Table

Agents MUST invoke JIT retrieval when these conditions are detected:

| Trigger | Condition | JIT Command | Expected Return |
|---------|-----------|-------------|----------------|
| **Task start** | Beginning a new task | `cleo show <id>` | Full task + acceptance criteria (~400 tokens) |
| **Domain entry** | First encounter with a module/concept | `cleo memory find "<module-name>"` | IDs + titles (~50-150 tokens) |
| **Prior decision** | "Has this approach been tried?" | `cleo memory find "<topic>" --type decision` | Decision IDs + summaries (~100 tokens) |
| **Pattern check** | "Is this the right pattern for X?" | `cleo memory find "<pattern>" --type pattern` | Pattern IDs (~50 tokens) |
| **Session resume** | Starting on an existing task | `cleo briefing` | Handoff + blockers + next tasks (~400 tokens) |
| **History question** | "Why was X done this way?" | `cleo memory timeline <id> --depth 2` | Temporal context (~300 tokens) |
| **Error encountered** | Hitting a known error type | `cleo memory find "<error-pattern>"` | Related observations (~100 tokens) |
| **Architecture decision** | Designing a new system component | `cleo memory find "<component>" --type decision` | Relevant past decisions (~150 tokens) |
| **Code editing** | About to modify a symbol | `gitnexus_impact({target: "symbolName"})` | Blast radius (separate, via MCP tool) |

**Termination criteria** — stop JIT retrieval when:
- The retrieved memory directly resolves the uncertainty (confidence restored)
- Two consecutive `find` calls return zero relevant results
- Three JIT calls have been made without resolution — escalate to `cleo briefing` or ask the operator

**Budget limit**: Maximum 3 JIT calls per task phase before continuing with available context.
Excessive JIT retrieval is a signal that the task is underspecified — surface that to the operator.

### 2.3 Three-Layer Retrieval Protocol (Canonical)

Per ADR-021, the canonical retrieval sequence:

```bash
# Layer 1: Index lookup — cheap, discovers IDs (50 tokens per hit)
cleo memory find "<query>" --json
cleo memory find "<query>" --type decision --json
cleo memory find "<query>" --type pattern --json

# Layer 2: Graph traversal — temporal + connected context (~300 tokens)
cleo memory timeline <id> --depth 2 --json

# Layer 3: Full entry — maximum detail (~500 tokens per entry)
cleo memory fetch <id> --json
```

**Agent decision tree:**
1. Call Layer 1 first. If `data.results` is empty or irrelevant → stop.
2. If results look relevant, identify the 1-2 most relevant IDs.
3. Call Layer 2 for timeline context around those IDs.
4. Call Layer 3 only if Layer 2 confirms the entry is directly relevant.

**Never** call Layer 3 on all search results. The token cost scales linearly.

### 2.4 New Command: `cleo context pull <task-id>`

This spec proposes a new command (implementation task separate) that bundles the most common
JIT retrieval pattern into one call:

```bash
cleo context pull T549 --json
```

Returns (target: ~400 tokens):
- Task title + description (truncated to 200 chars if long)
- Top 3 acceptance criteria
- Top 3 brain.db entries relevant to this task (hybridSearch by task title + labels)
- Last session handoff note for this task (if any)
- Any open blockers

This becomes the canonical "task resume" command. An agent beginning or resuming any task
calls this once — it replaces the current pattern of running `cleo show` + `cleo briefing`
separately.

### 2.5 Per-Call Budget Table

| Command | Typical Return | Max Budget | Use |
|---------|---------------|------------|-----|
| `cleo memory find "<query>"` | 50-150 tokens | 300 tokens | Discovery |
| `cleo memory timeline <id> --depth 2` | 200-400 tokens | 600 tokens | Context |
| `cleo memory fetch <id>` | 300-500 tokens | 700 tokens | Full detail |
| `cleo show <id>` | 300-500 tokens | 600 tokens | Task details |
| `cleo briefing` | 400-800 tokens | 1,000 tokens | Session resume |
| `cleo context pull <id>` (NEW) | 300-500 tokens | 600 tokens | Task-focused bundle |
| **Single JIT session total** | **500-1,500** | **2,000 tokens** | Per trigger |

The 2,000-token cap per JIT session is a soft limit. Agents must not exceed it without
a compelling reason. Exceeding it consistently signals the memory-bridge.md is failing to
surface relevant content at session start.

---

## 3. Provider-Adaptive Strategy

### 3.1 Three-Tier Classification

The R3 audit established a clear capability spectrum across CLEO's 6 supported providers.
Memory injection strategy must adapt to what each provider can do at runtime.

**Tier 1 — Full JIT (Claude Code)**
- Full Bash tool use: YES
- Mid-session `cleo` CLI calls: YES
- SubagentStart/Stop hooks: YES
- Dynamic memory retrieval: YES

Strategy: Minimal static baseline (~1,850 tokens) + on-demand JIT retrieval.
The agent proactively calls `cleo memory find` when encountering uncertainty.
Memory bridge is compact (pointers only). Agent pulls everything else JIT.

**Tier 2 — Hybrid JIT (OpenCode, Gemini CLI)**
- Shell execution: YES (partial for OpenCode, YES for Gemini CLI)
- PreModel hook: YES for both (not yet implemented in CLEO)
- Dynamic memory retrieval: PARTIAL (tool-dependent)

Strategy: Medium static baseline (~2,500 tokens) + hook-driven refresh.
Implement PreModel hook (OpenCode plugin, Gemini CLI shell hook) to inject
a 200-token memory summary before each LLM call. Agent can call `cleo` CLI
for JIT but should not rely on it being available in all configurations.

**Tier 3 — Static-Only (Cursor, Codex, Kimi)**
- Mid-session shell execution: NO (Cursor), PARTIAL (Codex), UNKNOWN (Kimi)
- Hook system: Minimal (Cursor: 10/16 events, Codex: 3/16, Kimi: 0/16)
- Dynamic memory retrieval: NO

Strategy: Rich static baseline (~3,500 tokens) with pre-rendered memory content.
No JIT possible. Compensate with a more complete memory bridge, pre-rendered
inline (not via `@`-reference which is unverified for these providers).

### 3.2 Provider Detection and Injection Selection

```typescript
/** Returns the appropriate injection config for the detected provider. */
function getInjectionConfig(providerId: string): InjectionConfig {
  const tier = getProviderTier(providerId);

  switch (tier) {
    case 1: // Claude Code
      return {
        staticTokenBudget: 1_850,
        memoryBridgeMode: 'compact',     // ~200 tokens: pointers only
        gitNexusBlock: 'conditional',    // inject only for code-editing sessions
        principlesBlock: 'omit',         // too large, low active utility
        jitEnabled: true,
        preModelHook: false,
      };

    case 2: // OpenCode, Gemini CLI
      return {
        staticTokenBudget: 2_500,
        memoryBridgeMode: 'medium',      // ~600 tokens: top-5 with content
        gitNexusBlock: 'compact',        // summary reference only, ~150 tokens
        principlesBlock: 'omit',
        jitEnabled: true,                // partial — include JIT instructions
        preModelHook: true,              // implement PreModel refresh
      };

    case 3: // Cursor, Codex, Kimi
      return {
        staticTokenBudget: 3_500,
        memoryBridgeMode: 'rich',        // ~1,200 tokens: full pre-rendered content
        gitNexusBlock: 'compact',        // summary only
        principlesBlock: 'compact',      // top-5 principles only
        jitEnabled: false,               // no JIT instructions (won't be used)
        preModelHook: false,
      };
  }
}
```

### 3.3 Tier Classification Table

| Provider | Tier | Static Budget | Memory Bridge Mode | JIT Instructions |
|----------|------|--------------|-------------------|-----------------|
| Claude Code | 1 | ~1,850 tokens | Compact (~200) | Full protocol |
| OpenCode | 2 | ~2,500 tokens | Medium (~600) | Partial protocol |
| Gemini CLI | 2 | ~2,500 tokens | Medium (~600) | Partial protocol |
| Cursor | 3 | ~3,500 tokens | Rich (~1,200) | Omit |
| Codex | 3 | ~3,500 tokens | Rich (~1,200) | Omit |
| Kimi | 3 | ~3,500 tokens | Rich (~1,200) | Omit |

### 3.4 Provider Detection at Injection Time

The CAAMP adapter already detects the active provider. The injection generator reads
this detection result and selects the appropriate config:

```typescript
// packages/core/src/injection.ts (extend existing)
const adapter = await AdapterManager.getActive();
const tier = getProviderTier(adapter.providerId);
const config = getInjectionConfig(adapter.providerId);
const bridge = await generateMemoryBridge(tier);
return buildInjectionContent(config, bridge);
```

If provider detection fails (CLEO_PROVIDER not set, no adapter registered), default to Tier 2
(medium static — safe middle ground).

---

## 4. Memory Bridge v2 Design

### 4.1 Design Goals

The memory bridge serves one purpose: give an agent starting a session just enough prior context
to orient without JIT calls for the first few minutes of work. It is NOT a memory dump. It is
a high-signal snapshot of the 3-5 most relevant pieces of knowledge for the likely next task.

Per ADR-032, Layer 1 (static bridge) must stay at 200-400 tokens. The current bridge at ~918
tokens already violates this budget. Memory Bridge v2 enforces it strictly.

### 4.2 Compact Mode (Tier 1 — Claude Code)

Target: ~200 tokens. Pure pointers — no inline content.

```markdown
# Memory Bridge (compact)

Active task: T549 — Memory Architecture v2 (status: pending)
Last session: ses_20260413000854 — v2026.4.31+4.32 shipped. 6 research reports complete.
Next suggested: T549 implementation

Top decisions (3):
- [D002] Revalidation proves system works (2026-04-13)
- [D001] T545 final decision — use storeDecision via engine-compat (2026-04-13)
- [D-mntpeeer] Use CLI-only dispatch for all CLEO operations (2026-04-11)

JIT: `cleo memory find "<topic>"` for deeper context. `cleo briefing` for full session resume.
```

Token estimate: ~180 tokens. Stays within ADR-032 Layer 1 budget.

### 4.3 Medium Mode (Tier 2 — OpenCode, Gemini CLI)

Target: ~600 tokens. Top-5 entries with truncated content.

```markdown
# Memory Bridge (medium)

## Active Context
- **Task**: T549 — Memory Architecture v2 (status: pending, priority: critical)
- **Last session**: v2026.4.31+4.32 shipped. PASS verdict achieved.
- **Next**: Begin CA3 JIT injection spec implementation

## Recent Decisions (top 5)
- [D002] Revalidation proves system works (2026-04-13) — system architecture validated
- [D001] T545 final decision — use storeDecision via engine-compat (2026-04-13)
- [D-mntpeeer] CLI-only dispatch for all CLEO operations — MCP fully removed (2026-04-11)
- [D-mnwf0gmn] Validation proves system works (2026-04-12) — test suite passing
- [D-mnwg2sz2] T545 test decision — confidence gate met (2026-04-13)

## Active Patterns (top 3)
- brain (12 completed tasks) — brain.db work is high-velocity, follow established patterns
- nexus (8 completed tasks) — code intelligence pipeline patterns apply
- pipeline (5 completed tasks) — RCASD-IVTR lifecycle working correctly

## Recent Observations (top 5)
- [O-mnwonr0a] Session note: v2026.4.31+4.32 shipped. 6 research reports complete.
- [O-mnwh5cru] T548 revalidation passed
- [O-mnwgdsvk] T545 final verification
- [O-mnwf75bg] Graph timing confirmed
- [O-mnwfxwp7] T545 quality verification

For deeper context: `cleo memory find "<topic>"` or `cleo briefing`.
```

Token estimate: ~580 tokens.

### 4.4 Rich Mode (Tier 3 — Cursor, Codex, Kimi)

Target: ~1,200 tokens. Pre-rendered content inline. No `@`-references (unverified for these providers).

```markdown
# Memory Bridge (rich)

## Active Context
- **Project**: cleocode — Node.js monorepo, TypeScript strict, pnpm
- **Task**: T549 — Memory Architecture v2 (status: pending, priority: critical)
  - Complete redesign: tiered memory, extraction pipeline, JIT injection
  - 6 research reports complete. Implementation phase beginning.
- **Last session**: v2026.4.31+4.32 shipped. PASS verdict. Owner approved deeper memory review.

## Recent Decisions (top 5, with rationale)
- [D002] System revalidation confirmed architecture is correct (2026-04-13)
  Full rationale: test suite passing, all gates green, system validated end-to-end.
- [D001] T545 — use storeDecision via engine-compat bridge (2026-04-13)
  Required compatible layer due to API version mismatch in graph node wiring.
- [D-mntpeeer] CLI-only dispatch — MCP fully removed (2026-04-11)
  All agent operations via `cleo` CLI. No MCP tool calls for CLEO operations.
- [D-mnwf0gmn] Validation proves system works (2026-04-12)
  Passed all 12 acceptance criteria for the wave.
- [D-mnwg2sz2] T545 test decision — confidence gate: 0.90 (2026-04-13)

## Key Learnings (top 5)
- T542-2: graph traversal CLI commands wired — `cleo memory trace` commands complete
- Wave I-1: Python + Go + Rust language providers implemented in nexus pipeline
- Wave H-1: Worker pool for parallel parsing + incremental re-indexing — ported from GitNexus
- Wave G-1: Community detection (Louvain) + process detection from GitNexus — ported
- Wave F-2: sqlite-vec installed + embedding pipeline activated

## Patterns to Follow
- brain (12 tasks): follow brain.db schema patterns, drizzle-orm v1 beta floor
- nexus (8 tasks): use GitNexus call graph patterns for code intelligence
- pipeline (5 tasks): RCASD spec → IVTR impl → contribution cycle
- wave-a (4 tasks): wave-based delivery with manifests + MANIFEST.jsonl

## Recent Observations
- v2026.4.31+4.32 shipped. All brain graph work complete. 6 T549 research reports done.
- T548 revalidation: PASS verdict — system architecture confirmed sound
- T545 final verification: graph node wiring complete, confidence threshold met
- Graph timing analysis: auto-populate hooks firing correctly at session boundaries
```

Token estimate: ~1,150 tokens.

### 4.5 Generation Changes Required

The memory bridge generator (`packages/core/src/memory/memory-bridge.ts`) must be extended to:

1. Accept a `mode: 'compact' | 'medium' | 'rich'` parameter (maps to provider tier)
2. Enforce token budgets per mode: compact ≤ 250, medium ≤ 700, rich ≤ 1,400
3. Use relevance scoring (hybridSearch against current task) when selecting which entries to include,
   not recency alone
4. The compact and medium modes must output within budget — truncate or omit entries to stay under
5. Fix the existing bug: `writeMemoryBridge()` (standard path) ignores `maxTokens` — apply character
   budget to ALL paths, not just `generateContextAwareContent()`

---

## 5. AGENTS.md Rewrite Proposal

### 5.1 Design Principles

The new AGENTS.md structure must:
- Stay under 1,125 tokens (all content excluding the CAAMP-injected blocks)
- Put high-attention content first (task-relevant) and low-attention content last
- Move GitNexus to a separate file, referenced only from Claude Code's CLAUDE.md
- Include the JIT retrieval protocol inline (always needed, small)
- Eliminate all redundancy with CLEO-INJECTION.md

### 5.2 Proposed AGENTS.md Structure

```markdown
<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
@.cleo/memory-bridge.md
<!-- CAAMP:END -->

# Code Quality Rules (MANDATORY)

> NON-NEGOTIABLE. Violations are grounds for rejecting all work.

## Before Writing Code
1. Read first — understand existing code and contracts
2. Check for existing — NEVER duplicate utilities or helpers
3. Use contracts — `packages/contracts/src/`. NEVER inline types

## Type Safety (ZERO TOLERANCE)
- NEVER `any` — find root cause, inspect interfaces, wire correctly
- NEVER `unknown` as a shortcut — define proper types
- NEVER `as unknown as X` casting chains — fix the actual type mismatch
- ALWAYS use contracts or build new ones if genuinely missing

## Architecture (DRY + SOLID)
- NEVER remove code — ALWAYS improve existing code
- ALWAYS check for existing functions before creating new ones
- ALWAYS centralize shared logic — no scattered one-off helpers
- ALWAYS follow existing patterns — match style, naming, structure

## Documentation
- ALWAYS add TSDoc (`/** ... */`) on ALL exported symbols
- ALWAYS update existing docs — NEVER create new ones unless required

## Quality Gates (MUST PASS IN ORDER)
```bash
pnpm biome check --write .  # 1. Format + lint
pnpm run build              # 2. Build
pnpm run test               # 3. Zero new failures
git diff --stat HEAD        # 4. Verify scope
```

## Anti-Patterns (INSTANT REJECTION)
- Claiming tests pass without running `pnpm run test`
- Using workarounds instead of fixing root causes
- `catch (err: unknown)` — use proper error types
- `console.log` in production code
- Modifying test expectations to match broken code

## Runtime Data Safety (ADR-013)
NEVER commit `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
or `.cleo/project-info.json`. Backup: `cleo backup add`. Restore: `cleo restore backup`.

---

# JIT Memory Protocol

When you need more context than the memory bridge provides, pull it on demand:

## Triggers and Commands

| Situation | Command |
|-----------|---------|
| Starting or resuming a task | `cleo context pull <id>` |
| Need prior decisions on a topic | `cleo memory find "<topic>" --type decision` |
| Need patterns for a domain | `cleo memory find "<domain>" --type pattern` |
| Need timeline context on a memory | `cleo memory timeline <id> --depth 2` |
| Full session resume | `cleo briefing` |
| Full entry details | `cleo memory fetch <id>` |

## Budget
- Layer 1 find: ~50-150 tokens — always do this first
- Layer 2 timeline: ~300 tokens — only if find returns relevant IDs
- Layer 3 fetch: ~500 tokens — only when timeline confirms relevance
- Maximum 3 JIT calls per task phase before continuing

---

<!-- NOTE: GitNexus instructions removed from cross-provider AGENTS.md.
     Claude Code: see CLAUDE.md for GitNexus injection.
     Other providers: load .claude/skills/gitnexus/ skill files when needed. -->
```

**Token estimate for new AGENTS.md** (excluding CAAMP-injected blocks): ~900 tokens
**Reduction from current**: 2,337 tokens → ~900 tokens — a 61% reduction

### 5.3 CLAUDE.md Update (Claude Code only)

```markdown
@AGENTS.md
@.claude/context/gitnexus.md  ← NEW: GitNexus block moved here, Claude Code only
# GitNexus — Code Intelligence

[GitNexus block content moved here — only loaded by Claude Code]
```

This ensures GitNexus (1,212 tokens) is present in Claude Code sessions (where MCP tools are
available) but absent from cross-provider AGENTS.md (where MCP is not available and the
instructions are irrelevant).

---

## 6. Attention-Optimal Placement Strategy

### 6.1 The Science Applied

From Liu et al. (2024): content at the **start** of context gets the highest accuracy (~75%),
content at the **end** gets secondary attention (~72%), and content in the **middle** gets
the lowest attention (~45-55%). For 20+ items, the middle blind spot causes 30%+ accuracy drops.

CLEO's injection chain currently places:
- Task protocol (CLEO-INJECTION.md) in the middle
- Memory bridge in the middle-to-end
- Task-specific content (from `cleo show <id>`) AFTER all 5,869 tokens of baseline

This is the opposite of optimal. Task-specific content — the most important information —
gets placed in the worst attention position.

### 6.2 Recommended Injection Order

**First position (primacy slot — highest attention):**

Position 1 is reserved for the information most critical to the current task. For a running
session, this means the current task context. For a new session, this means the work loop.

```
[1] Active task summary (from cleo context pull <id>) — 400 tokens
    Title + description + top-3 acceptance criteria + relevant prior decisions
    WHY FIRST: this is what the agent needs to answer for every decision it makes
```

**Second position (still high attention):**

```
[2] CLEO work loop (from CLEO-INJECTION.md) — 300 tokens
    Work loop + session commands + error handling
    WHY SECOND: procedural memory; agent references this frequently
```

**Third position (quality constraints — always active):**

```
[3] Code quality rules — 800 tokens
    Type safety, architecture rules, quality gates
    WHY THIRD: consulted before every code action; needs to be near primacy slot
```

**Middle position (lower attention — put reference material here):**

```
[4] Memory bridge compact header — 200 tokens
    Top-3 decisions + last session note + JIT commands
    WHY MIDDLE: background context; agent pulls specific items JIT if needed

[5] Project context (language, framework, patterns) — 347 tokens
    project-context.json content
    WHY MIDDLE: stable reference; accessed occasionally, not constantly
```

**Last position (recency slot — secondary attention):**

```
[6] JIT retrieval protocol — 150 tokens
    The table of triggers + commands + budget
    WHY LAST: agents consult this when they need more context — recency bias
              means it's freshest when the agent is considering pulling more
```

### 6.3 Injection Order vs. Current Chain

| Position | Current | Proposed | Attention Quality |
|----------|---------|----------|------------------|
| 1 | CLAUDE.md stub | Active task context (cleo context pull) | Primacy — highest |
| 2 | AGENTS.md (code quality + GitNexus) | CLEO work loop | High |
| 3 | CLEO-INJECTION.md | Code quality rules | High |
| 4 | project-context.json | Memory bridge compact | Medium |
| 5 | memory-bridge.md | Project context | Medium |
| 6 | [task loaded after baseline] | JIT protocol | Recency — secondary high |
| Middle | [task at worst position] | [reference material only] | Low — correct for reference |

### 6.4 Implementation: How to Achieve This Order

The `@`-reference chain in CLAUDE.md resolves top-to-bottom. The current chain:

```
CLAUDE.md → AGENTS.md → ~/.agents/AGENTS.md → CLEO-INJECTION.md
                      → project-context.json
                      → memory-bridge.md
```

The proposed chain for Claude Code:

```
CLAUDE.md:
  @.claude/context/task-primer.md    ← NEW: cleo context pull output, pre-rendered at session start
  @.claude/context/gitnexus.md       ← conditional: code-editing sessions only
  @AGENTS.md                         ← code quality rules + JIT protocol (rewritten)
    @~/.agents/AGENTS.md
      @CLEO-INJECTION.md             ← CLEO work loop
    @.cleo/project-context.json
    @.cleo/memory-bridge.md          ← compact mode for Tier 1
```

The `task-primer.md` file is a new concept: a pre-rendered file written by `cleo context pull`
at session start (triggered by a `SessionStart` hook). It contains the current task summary
and is placed first in the injection chain — at the primacy slot.

For providers without session start hooks, the task primer is written by the agent as its
first action: `cleo context pull <id> > .claude/context/task-primer.md`. The instruction
to do this is in the work loop.

---

## 7. Token Metrics to Track

### 7.1 Metrics Required for Context Window Management

The system cannot manage what it cannot measure. The following metrics must be instrumented:

| Metric | Source | How to Collect |
|--------|--------|----------------|
| `baseline_tokens` | Session start | Estimate from file sizes at injection time: `sum(fileSize / 4)` |
| `bridge_tokens` | Memory bridge generation | Count chars in output, divide by 4 |
| `jit_calls_per_session` | Memory operations | Increment counter on `memory.find`, `memory.fetch`, `memory.timeline` |
| `jit_tokens_per_call` | Memory operation results | `result.length / 4` per JIT call |
| `session_total_tokens` | Token telemetry | `cleo otel` or `cleo token` existing infrastructure |
| `bridge_mode` | Provider detection | `compact | medium | rich` per session |
| `provider_tier` | Adapter detection | `1 | 2 | 3` per session |
| `context_window_pct` | Context monitor | `(total_tokens / context_window_size) * 100` |

### 7.2 Alert Thresholds

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Baseline tokens exceed target | > 2,000 (Tier 1), > 3,000 (Tier 2) | Warn at session start |
| JIT calls exceed budget | > 3 per task phase | Log warning: task may be underspecified |
| Session total tokens | > 40K | Trigger `cleo safestop` pre-emptive handoff |
| Session total tokens | > 80K | Force safestop |
| Memory bridge oversize | > 400 tokens (compact), > 800 tokens (medium) | Log warning at generation time |

### 7.3 Existing Infrastructure to Extend

CLEO already has token telemetry infrastructure:

- `cleo otel` — lightweight token metrics from `.cleo/metrics/TOKEN_USAGE.jsonl`
- `cleo token` — provider-aware token telemetry from `tasks.db`
- `cleo context` — context window monitoring (existing safeguard system)

The new metrics integrate into these existing pipelines. No new storage layer required.

Specifically:
- `baseline_tokens` and `bridge_tokens` → write to `TOKEN_USAGE.jsonl` at session start
- `jit_calls_per_session` and `jit_tokens_per_call` → write to `TOKEN_USAGE.jsonl` per call
- `bridge_mode` and `provider_tier` → add to session record in `tasks.db` sessions table

### 7.4 Memory Bridge Token Budget Enforcement (Bug Fix)

Per the R5 audit, `writeMemoryBridge()` ignores `maxTokens`. This is a bug.

**Fix**: After assembling the bridge content string, apply a character budget check before writing:

```typescript
const charBudget = config.maxTokens * 4; // 4 chars per token estimate
if (content.length > charBudget) {
  content = trimToBudget(content, charBudget);
  // trimToBudget: removes sections from the end (lowest-priority content) until under budget
}
```

This fix applies to the standard `writeMemoryBridge()` path, not just `generateContextAwareContent()`.

---

## 8. Implementation Roadmap

This spec identifies the following implementation tasks (for decomposition into T549 subtasks):

| # | Task | Size | Priority |
|---|------|------|---------|
| 1 | Rewrite AGENTS.md to new structure (~900 tokens) | small | critical |
| 2 | Extract GitNexus block to `.claude/context/gitnexus.md`, update CLAUDE.md | small | critical |
| 3 | Fix `writeMemoryBridge()` — enforce `maxTokens` in standard path | small | critical |
| 4 | Add `mode: compact | medium | rich` to memory bridge generator | small | high |
| 5 | Add relevance scoring (hybridSearch) to memory bridge entry selection | medium | high |
| 6 | Implement `cleo context pull <task-id>` command | medium | high |
| 7 | Add provider tier detection to injection generator | small | high |
| 8 | Implement SessionStart hook: write task-primer.md for Claude Code | small | medium |
| 9 | Add baseline_tokens + bridge_tokens to TOKEN_USAGE.jsonl at session start | small | medium |
| 10 | Implement PreModel memory injection plugin for OpenCode | medium | medium |
| 11 | Implement BeforeAgent shell hook for Gemini CLI memory refresh | medium | medium |
| 12 | CAAMP conditional injection block syntax (`<!-- conditional:code-editing -->`) | large | low |

Tasks 1-3 are immediate wins — zero new commands, pure refactoring. They can ship in the
next release and immediately reduce the static baseline for all providers.

Tasks 4-6 are the core JIT architecture. They implement the dynamic retrieval capability.

Tasks 7-11 are provider-specific adaptations. Claude Code benefits from all of them;
other providers benefit from their tier-specific tasks.

Task 12 is a future capability that enables fully automated conditional injection.

---

## 9. Governance

### 9.1 ADR Required

This spec proposes a new ADR: **ADR-044-JIT-INJECTION**.

Key decisions to record:
- Static baseline target per tier (1,850 / 2,500 / 3,500 tokens)
- Three-tier provider classification (not the 5-tier CAAMP quality tiers — this is injection-specific)
- Memory bridge mode per tier (compact / medium / rich)
- JIT budget cap (2,000 tokens per trigger event)
- Task-primer.md as a new CAAMP-managed file at session start
- `cleo context pull` as the canonical task-resume command

### 9.2 Spec Constraints (from R6 audit)

These ADRs constrain this spec and must not be violated:

- **ADR-032**: Memory bridge is CLEO-owned. Adapters NEVER write to it directly. Layer 1 = 200-400 tokens. (This spec tightens this: compact mode = 200 tokens, enforced.)
- **ADR-021**: `memory` domain = cognitive only. 3-layer retrieval pattern is canonical: `find → timeline → fetch`. Single `find` verb — no `search`.
- **ADR-006**: SQLite only for runtime data. No new JSON files for memory content.
- **ADR-013**: brain.db backup rules. The task-primer.md is not memory content — it is an ephemeral session file and does not need backup.
- **ADR-011**: Three JSON config files at `.cleo/`. The task-primer.md is a session artifact at `.claude/context/` — outside the `.cleo/` config boundary. No ADR conflict.

---

## 10. Summary

| Dimension | Current State | Target State | Change |
|-----------|--------------|--------------|--------|
| Static baseline | ~5,869 tokens | ~1,850 tokens | -68% |
| Memory bridge | ~918 tokens (no budget enforcement) | ~200 tokens (compact, enforced) | -78% |
| GitNexus presence | All sessions | Claude Code code-editing only | Conditional |
| Task context position | After 5,869-token baseline | First position (primacy slot) | Inverted |
| JIT retrieval | Agent-discretionary (no protocol) | Formalized: trigger table, budgets, termination | Protocol |
| Provider adaptation | Uniform injection | 3 tiers, 3 bridge modes | Adaptive |
| Token budget enforcement | Memory bridge: unenforced (standard path) | Enforced all paths | Bug fixed |
| Task resume command | `cleo show` + `cleo briefing` (separate) | `cleo context pull <id>` (bundled) | New command |

The net result: agents begin each session with high-signal, task-relevant context in the
primacy attention slot, with a clear protocol for pulling more when needed, and a system that
does not waste attention budget on content that is irrelevant to the current task.

---

## Sources

- T549-R5: Context Rot & Token Budget Management Research (2026-04-13)
- T549-R3: CAAMP Multi-Harness Memory Audit (2026-04-11)
- T549-R1: CLEO Memory Architecture Deep Audit (2026-04-13)
- T549-R6: Existing Specs & ADRs Audit (2026-04-13)
- Liu et al. (2024) — "Lost in the Middle: How Language Models Use Long Contexts" — Stanford/TACL
- ADR-032: Provider-Agnostic Memory Bridge
- ADR-021: Memory Domain Refactor — Cognitive-Only Cutover
- ADR-013: Data Integrity & Checkpoint Architecture
- ADR-006: Canonical SQLite Storage Architecture
