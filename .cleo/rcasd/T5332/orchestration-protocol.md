# The Tessera Pattern: Multi-Agent Orchestration Framework

**Status**: Specification Active
**Version**: 2.0.0
**Epic**: T5332
**Date**: 2026-03-04
**Prototype**: T5323 (The Great Binding — CLI Migration)
**Supersedes**: orchestration-protocol.md v1.0

---

## Executive Summary

The Tessera Pattern is a reusable, project-agnostic multi-agent orchestration framework built on CLEO's MCP/CLI domain operations. It defines how complex initiatives (EPICs) are decomposed into composable agent Waves, coordinated through CLEO's dispatch layer, and recorded as durable Tome artifacts.

This framework:
- Uses CLEO's MCP operations (`cleo_query`, `cleo_mutate`) as the exclusive coordination mechanism; CLI is the backup interface
- Draws identity and vocabulary from NEXUS-CORE-ASPECTS canon
- Enforces RFC 2119-compliant hard constraints on agent behavior
- Is project-agnostic: archetype capability profiles compose to any EPIC shape
- Requires RCASD completion as a mandatory pre-condition gate before any Wave decomposition begins

---

## I. Vocabulary (NEXUS Canon)

From [NEXUS-CORE-ASPECTS.md](docs/concepts/NEXUS-CORE-ASPECTS.md), the unit language of orchestrated work:

| Term | Definition |
|------|------------|
| **Thread** | A single atomic task strand — one agent's coherent unit of work |
| **Loom** | The EPIC frame: a bounded body of related Threads under tension |
| **Tapestry** | Multiple Looms viewed as one intentional campaign |
| **Tessera** | A reusable composition pattern that can generate a Tapestry from inputs |
| **Cogs** | Discrete MCP operations — the callable mechanisms of the system |
| **Click** | One invocation of a Cog — a single MCP tool call |
| **Cascade** | The live motion of a Tapestry through execution gates |
| **Tome** | Durable, illuminated output — the manifest record that survives the session |
| **Sticky Note** | Ephemeral pre-task capture; becomes a Thread, Session Note, or BRAIN observation |

---

## II. Pre-Condition: The RCASD Gate

Before any Wave decomposition begins, all RCASD phases MUST be complete. These phases are not optional steps — they are the gate through which an EPIC must pass before agents are spawned.

| Phase | Abbrev | Primary Domain | Required Artifact |
|-------|--------|---------------|-------------------|
| Research | R | `memory`, `session` | BRAIN observations, research Tome records |
| Consensus | C | `check` | `check.protocol.consensus` record |
| Architecture Decision | A | `pipeline`, `memory` | ADR document, Tome record |
| Specification | S | `pipeline` | Specification document, Tome record |
| Decomposition | D | `tasks`, `pipeline` | Task hierarchy, dependency DAG, Wave plan |

**RCASD Validation (MUST)**:

The orchestrator MUST verify the gate before spawning Wave 1:

```
cleo_query pipeline.manifest.list {
  phase: "specification",
  linkedEpic: "{EPIC_ID}"
}
```

If any required phase artifact is absent, the orchestrator MUST halt, record a `blocked` Sticky Note identifying the missing phase, and NOT proceed to decomposition.

---

## III. The Circle of Ten: Composable Agent Archetypes

Archetypes are capability profiles — composable units that describe what domain work an agent performs. Archetypes are assigned based on which MCP operation families a Wave's tasks require. The same archetype MAY appear in multiple Waves of the same EPIC.

| Archetype | Domain | MCP Operation Families | Tome `agent_type` |
|-----------|--------|----------------------|-------------------|
| **The Smiths** | `tasks` | `tasks.add`, `tasks.update`, `tasks.complete`, `tasks.find`, `tasks.show` | `implementation` |
| **The Scribes** | `session` | `session.start`, `session.record.assumption`, `session.record.decision`, `session.context.inject` | `coordination` |
| **The Archivists** | `memory` | `memory.observe`, `memory.find`, `memory.fetch`, `memory.timeline` | `research` |
| **The Wardens** | `check` | `check.protocol`, `check.protocol.consensus`, `check.gate.verify`, `check.task` | `validation` |
| **The Weavers** | `pipeline` | `pipeline.phase.list`, `pipeline.phase.start`, `pipeline.phase.complete`, `pipeline.phase.advance`, `pipeline.manifest.append` | `pipeline` |
| **The Conductors** | `orchestrate` | `orchestrate.start`, `orchestrate.ready`, `orchestrate.spawn`, `orchestrate.validate` | `orchestration` |
| **The Artificers** | `tools` | `tools.skill.list`, `tools.provider.inject`, `tools.issue.add.feature`, `tools.issue.add.bug` | `implementation` |
| **The Keepers** | `admin` | `admin.config.show`, `admin.backup`, `admin.restore` | `maintenance` |
| **The Wayfinders** | `nexus` | `nexus.sync`, `nexus.graph`, `nexus.deps` | `architecture` |
| **The Envoys** | `nexus` | `nexus.share.snapshot.export`, `nexus.share.snapshot.import`, `nexus.share.push`, `nexus.share.pull` | `portability` |

**Archetype Assignment Rules**:
1. Waves MUST be assigned archetypes based on which MCP operation families their tasks primarily invoke
2. A Wave MUST NOT be assigned an archetype whose operations are not required by the Wave's tasks
3. When a Wave spans two domains, the primary archetype governs; a secondary archetype MAY be noted
4. Archetype assignments are inputs derived from decomposition, not outputs of the archetype definitions

---

## IV. Wave Structure

A Loom (EPIC) MUST be decomposed into 3–7 Waves following DCMP. Each Wave is a coherent Thread cluster assigned to one archetype.

**General Pattern**:
```
LOOM ({EPIC_ID})
├── WAVE {N} ({TASK_ID}) — {Archetype} — {Mission} — {token_budget}
├── WAVE {N} ({TASK_ID}) — {Archetype} — {Mission}
│   └── [blocked by Wave {N-1}]
└── WAVE {N} ({TASK_ID}) — {Archetype} — {Mission [CRITICAL PATH]} — {token_budget}
```

**Wave Decomposition Rules**:
- Waves MUST form a valid DAG (no circular references)
- Waves with no unmet dependencies MAY execute in parallel within the same Round
- The critical path MUST be identified at decomposition time and started in Round 1
- All Waves MUST satisfy the DCMP 6-point atomicity test before spawning
- `maxDepth` and `maxSiblings` are governed exclusively by the configured `hierarchy.enforcementProfile` in `config.json` — this document does not set those values

**Round Grouping**:
```
Round N:    All Waves with no remaining blocked dependencies
Round N+1:  All Waves whose dependencies are satisfied after Round N completes
```

---

## V. Sacred Constraints (Hard Invariants)

These constraints apply to every agent in every Wave. An agent that violates any constraint MUST be considered failed. Its Tome record MUST NOT be accepted as `complete`.

### 1. NO INCOMPLETE WORK

Every Thread MUST be 100% complete before its Tome record is written. Agents MUST NOT use placeholder markers (`TODO`, `FIXME`, `// implement later`, or equivalent) in any output. If work cannot be completed, the Thread MUST be recorded as `blocked` in the Tome record with explicit `blocked_by` entries.

### 2. NO DEAD REPRESENTATIONS

Agents MUST NOT comment out code, logic, or operations to make a check pass. Any inactive code path MUST either be removed or justified with a decision record. Unused imports, dependencies, or references MUST be deleted.

### 3. DRY PRINCIPLE (DON'T REPEAT YOURSELF)

Every piece of knowledge MUST have a single authoritative source. All other representations MUST reference it — never duplicate it.

- Agents MUST read task definitions, acceptance criteria, and validation rules from the LOOM via `cleo_query tasks.show {TASK_ID}` — not from static copies embedded in prompts or protocol documents
- Configuration values (token limits, hierarchy limits, enforcement profiles) MUST be read from the project `config.json` via `cleo_query admin.config.show` — never hardcoded in protocol documents or agent instructions
- When duplication is detected, the canonical source MUST be designated, all duplicates MUST be removed, and all consumers MUST be updated to reference the canonical source

### 4. MCP COORDINATION (CLEO-NATIVE)

Agents MUST communicate via CLEO's dispatch layer using `cleo_query` for reads and `cleo_mutate` for writes. CLI invocations (`cleo ...`) are the backup interface only.

- Agents MUST NOT call internal module functions, import library code, or access the filesystem directly for coordination
- All state operations MUST go through the dispatch layer
- All MCP tool call results MUST be validated for `success: true`; non-zero exit codes MUST trigger the agent's error handling path before any subsequent action is taken

### 5. TOKEN PROTECTION

- The hard context cap per agent is `{AGENT_CONTEXT_LIMIT}`, resolved at runtime via `cleo_query admin.config.show` (key: `orchestration.agentContextLimit`; default: `{MODEL_CONTEXT_LIMIT}` — the model's native context window)
- The handoff threshold is `{CONTEXT_PERCENT_LIMIT}` of `{AGENT_CONTEXT_LIMIT}` (key: `orchestration.contextPercentLimit`; default: `0.80`)
- When the threshold is reached, the agent MUST complete its current atomic task, write its Tome record, and invoke the Handoff Protocol before terminating
- Agents MUST NOT begin a new atomic task they cannot complete within the remaining context budget

### 6. MANIFEST DISCIPLINE (TOME RECORD)

Each agent Thread MUST produce exactly one Tome record upon completion.

- Tome records MUST be written via `cleo_mutate pipeline.manifest.append`
- CLI fallback (only when MCP gateway is unavailable): `cleo research add ...`
- The Tome record is the canonical output artifact; downstream agents MUST reference it by record ID, never raw session state or agent output
- Partial completion MUST be recorded as `status: "partial"` with explicit `blocked_by` entries — never silently dropped
- Required fields: `id`, `status`, `file`, `date`, `agent_type`, `archetype`, `topics`, `key_findings`, `actionable`, `needs_followup`, `linked_tasks`

---

## VI. Coordination Protocol

Agents coordinate exclusively through CLEO MCP operations. No direct function calls, no shared memory, no out-of-band communication.

### Read Wave Acceptance Criteria from the LOOM

Before any work begins, the agent MUST read its Thread's acceptance criteria from the LOOM:

```
cleo_query tasks.show { id: "{WAVE_TASK_ID}" }
```

The `acceptanceCriteria` field in the response is the authoritative checklist for this Wave. Static checklists embedded in documents or prompts are superseded by the LOOM.

### Record Progress Decisions

```
cleo_mutate session.record.decision {
  taskId: "{WAVE_TASK_ID}",
  decision: "{what was decided or completed}",
  rationale: "{why}"
}
```

### Write Tome Record (Manifest Entry)

Upon Wave completion:

```
cleo_mutate pipeline.manifest.append {
  id: "{TASK_ID}-{slug}",
  file: ".cleo/agent-outputs/{TASK_ID}-{slug}.md",
  title: "{Wave title}",
  date: "{ISO_DATE}",
  status: "complete",
  agent_type: "{archetype_tome_type}",
  archetype: "{Circle of Ten name}",
  topics: ["{topic1}", "{topic2}"],
  key_findings: ["{finding1}", "{finding2}"],
  actionable: true,
  needs_followup: [],
  linked_tasks: ["{EPIC_TASK_ID}", "{DEPENDENT_WAVE_TASK_ID}"]
}
```

### Spawn Successor Wave

```
cleo_mutate orchestrate.spawn {
  taskId: "{NEXT_WAVE_TASK_ID}",
  agentType: "{archetype}",
  context: "{handoff_summary_or_tome_record_id}"
}
```

---

## VII. Handoff Protocol

### Trigger Conditions

A handoff MUST be initiated when any of the following occur:
- Token usage reaches `{CONTEXT_PERCENT_LIMIT}` of `{AGENT_CONTEXT_LIMIT}`
- A blocking dependency is discovered that prevents forward progress within this agent's scope
- The current Wave's remaining scope is determined to exceed this agent's remaining context budget

### Handoff Sequence

1. Complete the current atomic task — do not abandon mid-task
2. Write the Tome record via `cleo_mutate pipeline.manifest.append` with current `status`
3. Inject handoff context:

```
cleo_mutate session.context.inject {
  protocolType: "handoff",
  context: {
    waveId: "{WAVE_TASK_ID}",
    completed: ["{item1}", "{item2}"],
    inProgress: ["{item}"],
    blocked: [],
    tokenUsage: "{CURRENT_TOKENS}/{AGENT_CONTEXT_LIMIT}",
    keyDecisions: ["{decision}"],
    nextAgent: "{archetype}",
    tomeRecordId: "{TOME_RECORD_ID}"
  }
}
```

4. Spawn successor:

```
cleo_mutate orchestrate.spawn {
  taskId: "{CONTINUATION_TASK_ID}",
  agentType: "{archetype}",
  context: "Handoff from {archetype}. See Tome record {TOME_RECORD_ID} and session context."
}
```

### Handoff Message Format

```
[{ARCHETYPE}] Wave {N} {STATUS} — Handing off to [{NEXT_ARCHETYPE}]

Completed: {list}
In Progress: {list}
Blocked: {list}

Token Usage: {X}/{AGENT_CONTEXT_LIMIT}
Key Decisions: {list}

Tome Record: {TOME_RECORD_ID}
Next Task: {NEXT_WAVE_TASK_ID}
```

---

## VIII. Validation

### Per-Thread Validation

The Wave agent MUST verify the following before writing its Tome record. The primary checklist MUST be read dynamically from the LOOM, not from a static document:

```
cleo_query tasks.show { id: "{WAVE_TASK_ID}" }
# acceptanceCriteria field is the authoritative checklist for this Wave
```

Additionally, the following MUST always pass regardless of project-specific criteria:

- [ ] All `acceptanceCriteria` from `tasks.show` are met
- [ ] No incomplete work markers (`TODO`, `FIXME`, placeholder text) in any output
- [ ] No commented-out or dead code introduced
- [ ] All MCP tool calls returned `success: true`
- [ ] Token usage is within `{AGENT_CONTEXT_LIMIT}`
- [ ] Tome record written via `cleo_mutate pipeline.manifest.append`

### Per-Wave Validation (Orchestrator)

Before launching the next Round, the orchestrator MUST verify:

- [ ] All Waves in the completed Round have Tome records with `status: complete`
- [ ] All dependency DAG constraints are satisfied
- [ ] No `needs_followup` entries block the next Wave's critical path

### EPIC Completion Validation

- [ ] All Waves have Tome records (`status: complete` or `status: partial` with documented rationale)
- [ ] RCASD artifacts (all five phases) are present in the pipeline manifest
- [ ] No open `needs_followup` entries blocking delivery

---

## IX. Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Token limit exceeded mid-task | HIGH | Handoff at `{CONTEXT_PERCENT_LIMIT}`; never begin a task that cannot complete within remaining budget |
| Circular Wave dependencies | MEDIUM | DAG validation via DCMP before spawning any Wave |
| Non-atomic task in Wave | HIGH | DCMP 6-point atomicity test gates spawn; failed test blocks Wave |
| RCASD gate skipped | HIGH | Orchestrator MUST verify specification Tome record exists before Wave 1 |
| Agent drops context | MEDIUM | Tome record is canonical; successor reads Tome record, not session state |
| Critical path delayed | HIGH | Identify critical path at decomposition; spawn critical-path Waves in Round 1 |
| Acceptance criteria drift | MEDIUM | Always read from LOOM via `tasks.show`; never from static copies |

---

## X. Integration Points

### CLEO Domains Required

| Domain | Operations Used |
|--------|-----------------|
| `tasks` | `tasks.show`, `tasks.update`, `tasks.complete`, `tasks.find` |
| `pipeline` | `pipeline.manifest.append`, `pipeline.manifest.list`, `pipeline.phase.list`, `pipeline.phase.start`, `pipeline.phase.complete`, `pipeline.phase.advance` |
| `session` | `session.start`, `session.record.decision`, `session.record.assumption`, `session.context.inject` |
| `orchestrate` | `orchestrate.start`, `orchestrate.ready`, `orchestrate.spawn`, `orchestrate.validate` |
| `check` | `check.protocol`, `check.protocol.consensus`, `check.gate.verify` |
| `memory` | `memory.observe`, `memory.find` |
| `admin` | `admin.config.show` |

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

### Protocols Referenced

| Protocol | Role |
|----------|------|
| DCMP v2.0.0 | Task hierarchy, atomicity, DAG validation, MECE enforcement |
| CLEO Subagent Protocol | Agent lifecycle, output format, base behavior |
| LAFS | Response envelope format, error handling |

### Configuration Keys (from `config.json`)

| Key | Default | Purpose |
|-----|---------|---------|
| `orchestration.agentContextLimit` | `{MODEL_CONTEXT_LIMIT}` | Hard cap per agent thread |
| `orchestration.contextPercentLimit` | `0.80` | Handoff trigger threshold |
| `hierarchy.enforcementProfile` | `llm-agent-first` | DCMP sibling/depth limits |
| `hierarchy.maxDepth` | `3` | Read from config; governed by DCMP |

---

## XI. References

### NEXUS Canon

- [NEXUS-CORE-ASPECTS.md](docs/concepts/NEXUS-CORE-ASPECTS.md) — Workshop vocabulary (authoritative)
- [CLEO-MANIFESTO.md](docs/concepts/CLEO-MANIFESTO.md) — Circle of Ten archetypes §VII
- [CLEO-OPERATION-CONSTITUTION.md](docs/specs/CLEO-OPERATION-CONSTITUTION.md) — MCP operation registry
- [CLEO-SYSTEM-FLOW-ATLAS.md](docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md) — Dispatch request flow

### Protocols

- [Decomposition Protocol](src/protocols/decomposition.md) — DCMP v2.0.0
- [CLEO Subagent Protocol](.claude/agents/cleo-subagent.md) — Agent lifecycle base

### Specifications

- [MCP-SERVER-SPECIFICATION.md](docs/specs/MCP-SERVER-SPECIFICATION.md) — MCP contract
- [VERB-STANDARDS.md](docs/specs/VERB-STANDARDS.md) — Canonical verb standards

---

## Appendix A: Reference Implementation — T5323 (The Great Binding)

T5323 (CLI Dispatch Migration) is the prototype Tessera execution. The following documents how the pattern was applied — it is **illustrative, not prescriptive**. Domain-specific details (TypeScript imports, specific command names, CLEO-internal registry patterns) belong to the T5323 EPIC documentation.

### Archetype Assignments (T5323)

| Wave | Task | Archetype | Mission | Budget |
|------|------|-----------|---------|--------|
| 1 | T5324 | Smiths | Quick wins — establish dispatch pattern | 15k |
| 2 | T5325 | Artificers | Wire existing operations to dispatch | 35k |
| 3 | T5326 | Weavers | Create new pipeline dispatch operations | 25k |
| 4 | T5327 | Wardens | Protocol validation architecture | 40k |
| 5 | T5328 | Envoys | Cross-project data portability | 45k |
| 6 | T5329 | Keepers | Complex restoration logic | 20k |
| 7 | T5330 | Wayfinders | Architecture decision — CRITICAL PATH | 25k |

### Execution Rounds (T5323)

```
Round 1 (Parallel): Wave 1 (Smiths), Wave 2 (Artificers), Wave 7 (Wayfinders — CRITICAL)
Round 2 (After 1+2): Wave 3 (Weavers)
Round 3 (After 3):   Wave 4 (Wardens), Wave 5 (Envoys — unblocked after Wave 7)
Round 4 (After 4+5): Wave 6 (Keepers)
```

Budget totals: 205k across 7 agents. All within `{AGENT_CONTEXT_LIMIT}` per agent.

---

*The Tessera Pattern is part of the CLEO canon.*
*Version 2.0.0 — Epic T5332 — Specification Active*
