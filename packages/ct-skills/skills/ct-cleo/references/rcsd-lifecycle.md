# RCSD-IVTR Lifecycle (Detailed)

Projects follow a structured lifecycle with gate enforcement.

## Pipeline Stages

```
RCSD PIPELINE (setup phase):
  Research -> Consensus -> Specification -> Decomposition
                              |
                              v
EXECUTION (core/polish):
  Implementation -> Contribution -> Release
```

Each stage has a **lifecycle gate**. Entering a later stage requires prior stages to be `completed` or `skipped`. Gate enforcement mode is configured in `.cleo/config.json` (`strict` | `advisory` | `off`).

## Conditional Protocols (9 Types)

| Protocol | Keywords | Use Case |
|----------|----------|----------|
| Research | research, investigate, explore | Information gathering |
| Consensus | vote, validate, decide | Multi-agent decisions |
| Specification | spec, rfc, design | Document creation |
| Decomposition | epic, plan, decompose | Task breakdown |
| Implementation | implement, build, create | Code execution |
| Contribution | PR, merge, shared | Work attribution |
| Release | release, version, publish | Version management |
| Artifact Publish | publish, artifact, package | Artifact distribution |
| Provenance | provenance, attestation, SLSA | Supply chain integrity |

## Lifecycle Gate Enforcement

CLEO enforces RCSD-IVTR lifecycle progression through automatic gate checks at spawn time.

```
research --+---> consensus --+---> specification --+---> decomposition
           |                 |                     |
           | GATE            | GATE                | GATE
           |                 |                     |
           +-----------------+---------------------+---> implementation ---> release
```

| Enforcement Mode | On Gate Failure | Default |
|------------------|-----------------|---------|
| `strict` | Blocks spawn with exit 75 | yes |
| `advisory` | Warns but proceeds | |
| `off` | Skips all checks | |

### Emergency Bypass

```bash
cleo config set lifecycleEnforcement.mode off
# ... emergency work ...
cleo config set lifecycleEnforcement.mode strict
```

## Architecture Overview

CLEO implements a **2-tier universal subagent architecture**:

```
Tier 0: ORCHESTRATOR (ct-orchestrator)
    |
    +-- Coordinates complex workflows
    +-- Spawns subagents via Task tool
    +-- Pre-resolves ALL tokens before spawn
    +-- Reads only manifest summaries (not full content)
    |
    v
Tier 1: CLEO-SUBAGENT (universal executor)
    |
    +-- Receives fully-resolved prompts
    +-- Loads skill via protocol injection
    +-- Executes delegated work
    +-- Outputs: file + manifest entry + summary
```

**Core Principle**: One universal subagent type (`cleo-subagent`) with context-specific protocols -- NOT skill-specific agents.

## Protocol Stack

Every spawn combines two layers:

```
+------------------------------------------+
| CONDITIONAL PROTOCOL (task-specific)     |
| - research.md, implementation.md, etc.   |
+------------------------------------------+
| BASE PROTOCOL (always loaded)            |
| - Lifecycle, output format, constraints  |
+------------------------------------------+
```

## Subagent (cleo-subagent)

### Constraints (BASE)

| ID | Rule | Enforcement |
|----|------|-------------|
| BASE-001 | MUST append ONE line to MANIFEST.jsonl | Required |
| BASE-002 | MUST NOT return content in response | Required |
| BASE-003 | MUST complete task via `cleo complete` | Required |
| BASE-004 | MUST write output file before manifest | Required |
| BASE-005 | MUST start a task before beginning work | Required |
| BASE-006 | MUST NOT fabricate information | Required |
| BASE-007 | SHOULD link research to task | Recommended |

### Subagent Lifecycle

```
SPAWN -> INJECT -> EXECUTE -> OUTPUT -> RETURN
```

1. **SPAWN**: Orchestrator invokes Task tool
2. **INJECT**: Subagent receives base protocol + conditional protocol
3. **EXECUTE**: Follow skill-specific instructions
4. **OUTPUT**: Write file + append manifest entry
5. **RETURN**: Completion signal only (no content)

### Return Messages

| Status | Message |
|--------|---------|
| Complete | `[Type] complete. See MANIFEST.jsonl for summary.` |
| Partial | `[Type] partial. See MANIFEST.jsonl for details.` |
| Blocked | `[Type] blocked. See MANIFEST.jsonl for blocker details.` |
