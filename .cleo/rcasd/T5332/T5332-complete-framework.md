# T5332: The Tessera Pattern — Framework Quick Reference

**Epic**: T5332
**Status**: Specification Active
**Version**: 2.0.0
**Date**: 2026-03-04

---

## What Is The Tessera Pattern?

The Tessera Pattern is a reusable, project-agnostic multi-agent orchestration framework built on CLEO's MCP operations. It transforms complex EPICs into composable Wave sequences, coordinated through CLEO's dispatch layer, recorded as durable Tome artifacts.

**Key properties**:
- Project-agnostic: archetype profiles compose to any EPIC shape
- CLEO-native: all coordination via `cleo_query` / `cleo_mutate`; CLI is backup
- RFC 2119 compliant: hard constraints, not guidelines
- RCASD-gated: Research → Consensus → ADR → Specification → Decomposition before Wave 1

---

## Core Components

### 1. NEXUS Workshop Vocabulary

| Term | Meaning in Orchestration |
|------|--------------------------|
| **Thread** | One agent's atomic unit of work |
| **Loom** | The EPIC frame holding related Threads |
| **Tapestry** | Multiple Looms as one campaign |
| **Tessera** | This framework — a reusable pattern for generating Tapestries |
| **Cogs** | MCP operations — discrete callable mechanisms |
| **Click** | One MCP tool call invocation |
| **Cascade** | Live execution of a Tapestry through gates |
| **Tome** | The manifest record — durable output that survives the session |
| **Sticky Note** | Ephemeral pre-task capture before formal assignment |

### 2. The Circle of Ten: Archetype Capability Profiles

Archetypes are composable units assigned based on which MCP operation families a Wave requires:

| Archetype | Domain | When to Assign |
|-----------|--------|----------------|
| **The Smiths** | `tasks` | Task CRUD, hierarchy, completion work |
| **The Scribes** | `session` | Context management, decision recording |
| **The Archivists** | `memory` | BRAIN operations, research, knowledge capture |
| **The Wardens** | `check` | Validation gates, consensus, verification |
| **The Weavers** | `pipeline` | Lifecycle stages, manifest operations |
| **The Conductors** | `orchestrate` | Multi-agent coordination, spawning |
| **The Artificers** | `tools` | Skills, providers, tool integrations |
| **The Keepers** | `admin` | Config, backup, restoration |
| **The Wayfinders** | `nexus` | Cross-project path mapping, architecture |
| **The Envoys** | `nexus` | Export, import, sync, sharing |

### 3. Sacred Constraints (Non-Negotiable)

| # | Constraint | Rule |
|---|-----------|------|
| 1 | **NO INCOMPLETE WORK** | Every Thread MUST be 100% complete; `blocked` threads MUST write a partial Tome record |
| 2 | **NO DEAD REPRESENTATIONS** | Never comment out code; remove unused code or justify it with a decision record |
| 3 | **DRY PRINCIPLE** | Every piece of knowledge has one source; agents MUST read from the LOOM via `tasks.show`, not static copies |
| 4 | **MCP COORDINATION** | `cleo_query` / `cleo_mutate` only; no direct function calls; CLI is backup |
| 5 | **TOKEN PROTECTION** | Hard cap: `{AGENT_CONTEXT_LIMIT}` from config; handoff at `{CONTEXT_PERCENT_LIMIT}` (default 80%) |
| 6 | **MANIFEST DISCIPLINE** | One Tome record per Thread via `cleo_mutate pipeline.manifest.append` |

### 4. Pre-Condition: RCASD Gate

All five phases MUST be verified complete before Wave 1 is spawned:

```
R — Research       (memory + session Tome records present)
C — Consensus      (check.protocol.consensus record present)
A — Architecture   (ADR Tome record present)
S — Specification  (specification Tome record present)
D — Decomposition  (task hierarchy + DAG + Wave plan present)
```

Orchestrator verification:
```
cleo_query pipeline.manifest.list { phase: "specification", linkedEpic: "{EPIC_ID}" }
```

### 5. Wave Structure

Decompose any EPIC into 3–7 Waves following DCMP. Assign archetypes based on MCP operation families required:

```
LOOM ({EPIC_ID})
├── WAVE 1 ({TASK_ID}) — {Archetype} — [no deps — Round 1]
├── WAVE 2 ({TASK_ID}) — {Archetype} — [no deps — Round 1]
│   └── blocks WAVE 3
├── WAVE 3 ({TASK_ID}) — {Archetype} — [blocked by Waves 1+2 — Round 2]
└── WAVE N ({TASK_ID}) — {Archetype} — [CRITICAL PATH — start Round 1]
```

Token budgets per Wave are read from config at runtime (`orchestration.agentContextLimit`), not hardcoded.

---

## How to Apply the Tessera Pattern

### For Any New Multi-Agent EPIC

1. **Complete RCASD** — all five phases before decomposition
2. **Decompose** using DCMP (MECE, DAG, 6-point atomicity test)
3. **Assign Archetypes** from the Circle of Ten based on operation families required
4. **Group into Rounds** — parallel where DAG allows, sequential where blocked
5. **Identify Critical Path** — start critical-path Waves in Round 1
6. **Read token limits** from config via `cleo_query admin.config.show`
7. **Spawn Waves** using `cleo_mutate orchestrate.spawn`
8. **Track progress** via Tome records using `pipeline.manifest.append` and `pipeline.manifest.list`
9. **Handle handoffs** at `{CONTEXT_PERCENT_LIMIT}` of `{AGENT_CONTEXT_LIMIT}`

### Agent Work Loop (Each Wave)

```
1. cleo_query tasks.show { id: "{WAVE_TASK_ID}" }
   → Read acceptance criteria from LOOM (canonical checklist)

2. Do the work using CLEO MCP operations appropriate to the archetype

3. cleo_mutate session.record.decision { ... }
   → Record key decisions at milestones

4. Verify all acceptance criteria from step 1 are met

5. cleo_mutate pipeline.manifest.append { ... }
   → Write Tome record (status: complete or partial)

6. cleo_mutate orchestrate.spawn { ... }  [if successor needed]
   → Spawn next Wave or signal completion
```

### EPIC Template

```markdown
# LOOM {EPIC_ID}: {Epic Name}

## Archetype Mix
{List which Circle of Ten archetypes appear in this EPIC and why}

## RCASD Gate Status
- [ ] Research Tome record: {id or pending}
- [ ] Consensus record: {id or pending}
- [ ] ADR Tome record: {id or pending}
- [ ] Specification Tome record: {id or pending}
- [ ] Decomposition complete: {id or pending}

## Wave Plan

| Wave | Task | Archetype | Mission | Depends On | Round |
|------|------|-----------|---------|-----------|-------|
| 1 | T#### | {Archetype} | {Mission} | none | 1 |
| 2 | T#### | {Archetype} | {Mission} | Wave 1 | 2 |
| N | T#### | {Archetype} | {Mission — CRITICAL} | none | 1 |

## Critical Path
{Identify the longest dependency chain}

## Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| {risk} | {H/M/L} | {mitigation} |
```

---

## Coordination: Key MCP Operations

| Action | Operation | Gateway |
|--------|-----------|---------|
| Read Wave acceptance criteria | `tasks.show` | `cleo_query` |
| Record a decision | `session.record.decision` | `cleo_mutate` |
| Record an assumption | `session.record.assumption` | `cleo_mutate` |
| Write Tome record | `pipeline.manifest.append` | `cleo_mutate` |
| Find existing Tome records | `pipeline.manifest.list` | `cleo_query` |
| List phases | `pipeline.phase.list` | `cleo_query` |
| Start phase | `pipeline.phase.start` | `cleo_mutate` |
| Complete phase | `pipeline.phase.complete` | `cleo_mutate` |
| Advance phase | `pipeline.phase.advance` | `cleo_mutate` |
| Inject handoff context | `session.context.inject` | `cleo_mutate` |
| Spawn next Wave | `orchestrate.spawn` | `cleo_mutate` |
| Validate orchestration | `orchestrate.validate` | `cleo_mutate` |
| Read config (token limits) | `admin.config.show` | `cleo_query` |
| Add BRAIN observation | `memory.observe` | `cleo_mutate` |

### Framework Action Mapping (Registry SSoT)

| Framework Action | Domain.Operation | Gateway |
|------------------|------------------|---------|
| Read Wave acceptance criteria | `tasks.show` | `cleo_query` |
| Record implementation decision | `session.record.decision` | `cleo_mutate` |
| Record implementation assumption | `session.record.assumption` | `cleo_mutate` |
| Write Tome record | `pipeline.manifest.append` | `cleo_mutate` |
| List Tome records for RCASD/Wave checks | `pipeline.manifest.list` | `cleo_query` |
| Read phase catalog | `pipeline.phase.list` | `cleo_query` |
| Start active phase work | `pipeline.phase.start` | `cleo_mutate` |
| Complete current phase | `pipeline.phase.complete` | `cleo_mutate` |
| Advance to next phase | `pipeline.phase.advance` | `cleo_mutate` |
| Inject handoff context | `session.context.inject` | `cleo_mutate` |
| Spawn successor Wave | `orchestrate.spawn` | `cleo_mutate` |
| Validate orchestration envelope | `orchestrate.validate` | `cleo_mutate` |
| Check ready Waves | `orchestrate.ready` | `cleo_query` |
| Read configuration limits | `admin.config.show` | `cleo_query` |

---

## Integration Points

| Integration | Reference |
|-------------|-----------|
| Decomposition rules | [decomposition.md](src/protocols/decomposition.md) — DCMP v2.0.0 |
| Agent lifecycle | [cleo-subagent.md](.claude/agents/cleo-subagent.md) |
| MCP operations registry | [CLEO-OPERATION-CONSTITUTION.md](docs/specs/CLEO-OPERATION-CONSTITUTION.md) |
| Workshop vocabulary | [NEXUS-CORE-ASPECTS.md](docs/concepts/NEXUS-CORE-ASPECTS.md) |
| Archetype canon | [CLEO-MANIFESTO.md](docs/concepts/CLEO-MANIFESTO.md) §VII |
| Config schema | `schemas/config.schema.json` |

---

## Full Specification

See [orchestration-protocol.md](orchestration-protocol.md) for:
- Complete RFC 2119 constraint definitions
- Full archetype MCP operation family listings
- Handoff Protocol with operation sequences
- Validation checklists (dynamic from LOOM)
- Risk mitigation table
- Reference implementation: T5323 (Appendix A)

---

## Reference Implementation

The pattern was prototyped on **T5323 (The Great Binding — CLI Dispatch Migration)**:
- 7 Waves, 4 execution Rounds, 205k total tokens across 7 agents
- All T5323-specific details (command names, TypeScript templates, registry patterns) are in Appendix A of the full specification — not part of the reusable framework

---

*The Tessera Pattern is part of the CLEO canon. Version 2.0.0.*
