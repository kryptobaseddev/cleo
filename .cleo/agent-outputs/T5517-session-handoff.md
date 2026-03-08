# T5517 Session Handoff — 2026-03-08

**Epic**: EPIC: Rationalize CLEO API Operations (268→≤180)
**Session**: ses_20260307123617_280237
**Pipeline stage**: research (in_progress)

---

## Current State

- Registry: **268 ops** (153 query + 115 mutate). Grows unbounded — no admission gate since T5241 (was 201).
- AGENTS.md updated to reflect 268.
- **cleo-dev MCP broken**: `scandir /mnt/projects/claude-todo/drizzle` — drizzle path migrated to `migrations/drizzle-tasks/` but dev build not rebuilt. **Use production `cleo` MCP for all task mutations until fixed.**

---

## Confirmed Bugs (fix before or parallel with domain reviews)

### BUG 1 — T5656 (CRITICAL, BLOCKING T5563)
`~/.cleo/projects-registry.json` must be fully deleted. nexus.db is canonical but not properly wired.
Agents hit nexus tier-2 gate → fall back to reading JSON file directly from filesystem.
File has ~60+ garbage `cleo-upgrade-structure-test-*` entries under `~/.temp/`.
**Fix first** — T5563 (nexus inventory) depends on T5656.

### BUG 2 — T5607 (HIGH, start immediately)
`ct-cleo` SKILL.md references defunct domains `research` and `system`. These don't exist.
Correct routes: `research.*` → `pipeline.manifest.*`, `system.*` → `admin.*`.
This is live agent hallucination happening now. Fast audit — start it first session.

---

## Complete Task Map (T5517 children)

### Phase R — Research (parallel, all can run simultaneously)

| ID | Task | Blocks |
|----|------|--------|
| T5530 | Domain Review: tasks (→T5531/T5532/T5533) | T5609 |
| T5534 | Domain Review: session (→T5535/T5536/T5537) | T5609 |
| T5538 | Domain Review: memory (→T5539/T5540/T5541) | T5609 |
| T5542 | Domain Review: check (→T5543/T5544/T5545) | T5609 |
| T5546 | Domain Review: pipeline (→T5547/T5548/T5549) | T5609 |
| T5550 | Domain Review: orchestrate (→T5551/T5552/T5553) | T5609 |
| T5554 | Domain Review: tools (→T5555/T5556/T5557) | T5609 |
| T5558 | Domain Review: admin (→T5559/T5560/T5561) | T5609 |
| T5562 | Domain Review: nexus (→T5656→T5563/T5564/T5565) | T5609 |
| T5566 | Domain Review: sticky (→T5567/T5568/T5569) | T5609 |
| T5607 | R: Audit ct-cleo skill stale domain refs | T5613 |
| T5608 | R: Audit tier assignments + nexus gate UX | T5609 |

### Phase C — Consensus (sequential after all R tasks)

| ID | Task | Depends on |
|----|------|------------|
| T5609 | C: Synthesize 10 domain reviews → decision matrix | all R tasks |
| T5610 | C: Design canonical agent decision tree | T5609 |

### Phase A — Architecture

| ID | Task | Depends on |
|----|------|------------|
| T5611 | A: Write ADR for operation model rationalization | T5609 |

### Phase S — Specification

| ID | Task | Depends on |
|----|------|------------|
| T5612 | S: Update CLEO-OPERATION-CONSTITUTION.md | T5611 |

### Phase I — Implementation (T5613/T5614 can parallel)

| ID | Task | Depends on |
|----|------|------------|
| T5613 | I: Rewrite ct-cleo skill — decision tree + canon refs | T5607, T5610 |
| T5614 | I: Rewrite CLEO-INJECTION.md — MVI token-conservative | T5610 |
| T5615 | I: Per-domain code consolidation in registry.ts | T5609, T5611 |

### Phase V — Validation Gate

| ID | Task | Depends on |
|----|------|------------|
| T5616 | V: 4-layer gate (registry = Constitution = tests = skill canon) | T5612–T5615 |

---

## Domain Ceiling Targets (input for T5609)

| Domain | Current | Target | Key cuts |
|--------|---------|--------|----------|
| tasks | 32 | ≤22 | Merge unarchive/reopen→restore, remove label.show, merge relates.* |
| session | 19 | ≤16 | Remove chain.show, merge debrief.show into show |
| memory | 18 | ≤15 | Keep 4 core ops + decision/pattern/learning find+store; prune stats/contradictions/superseded |
| check | 19 | ≤13 | Merge protocol.* into protocol with type param; merge gate.verify into task |
| pipeline | 42 | ≤30 | Chain.* → plugin or tier 2; phase.* merge where possible |
| orchestrate | 19 | ≤16 | Merge tessera.* reduce; handoff is core |
| tools | 32 | ≤22 | skill.catalog.* → tier 2 only; merge skill.precedence.*; issue.* rationalize |
| admin | 44 | ≤30 | Export/import 6→2; health+doctor+fix→1; backup→1; adr.* reduce; sync.* rationalize |
| nexus | 31 | ≤20 | All tier 2 — justify or lower; many share.* ops can merge |
| sticky | 6 | ≤6 | Already lean |
| **Total** | **268** | **≤180** | |

**Tier 0 target: ≤90** (currently ~149). Tier 0 = cold-start minimum. Everything else discovered via `admin.help`.

---

## Tier Gate Design Principles (input for T5608 + T5611 ADR)

**The nexus tier-2 problem**: Agents hit the tier wall silently, then read the filesystem directly. This is the *opposite* of progressive disclosure intent. Resolution options:
1. Lower nexus basic ops (status, list, show) to tier 1
2. Make the escalation path explicit in the decision tree: "need cross-project? → call `admin.help {tier:2}` first"
3. **Never gate an op at tier 2 without a clear escalation path surfaced at tier 0**

This principle must become a new invariant in the Constitution (§11).

---

## Orphan Tasks (not under T5517, inform domain reviews)

- T5508: Review admin domain — consolidate 43→~28 (standalone analysis, import findings into T5558)
- T5509: Review pipeline domain — consolidate 37→~24 (import into T5546)
- T5510: Review nexus domain — consolidate 31→~23 (import into T5562)
- T5511: Review tools domain — consolidate 32→~26 (import into T5554)

These are older analysis tasks. Read their descriptions when starting the relevant domain review — they already have consolidation ideas that save work.

---

## Work Streams for Next Session

**Stream A — Immediate bugs (start first, no dependencies)**
→ T5656: Remove projects-registry.json, wire nexus.db
→ T5607: Audit ct-cleo skill staleness

**Stream B — Domain reviews (parallel agent team, all 10 simultaneously)**
→ T5530, T5534, T5538, T5542, T5546, T5550, T5554, T5558, T5562 (after T5656), T5566
→ Each agent: read relevant T5508-T5511 orphan for prior analysis, then do Inventory→Challenge→Decide

**Stream C — Cross-cutting research (parallel with Stream B)**
→ T5608: Tier audit — use ceiling targets table above as input

**Stream D — Synthesis (after B+C complete)**
→ T5609 → T5610 → T5611

**Stream E — Spec + Implementation (after D)**
→ T5612, T5613, T5614 (parallel) → T5615

**Stream F — Validation gate**
→ T5616

---

## Session Scope Summary

This session:
- Ended stale T4867 session, started T5517 session
- Recorded T5517 in research pipeline stage
- Added 10 new tasks: T5607-T5616 (full RCASD pipeline phases)
- Wired all task dependencies across phases
- Integrated nexus findings: T5656 (new bug task), T5563 dependency, T5608 title update
- Updated T5517 title to reflect 268 starting count
- Identified cleo-dev build breakage (drizzle scandir issue)
