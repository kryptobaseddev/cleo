# RCSD Pipeline Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-23
**Last Updated**: 2025-12-23
**Implementation Report**: [RCSD-PIPELINE-IMPLEMENTATION-REPORT.md](RCSD-PIPELINE-IMPLEMENTATION-REPORT.md)

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Preamble

### Purpose

This specification defines the **Research-Consensus-Spec-Decompose (RCSD) Pipeline**, a unified workflow for transforming research topics into validated specifications and atomic executable tasks. The pipeline integrates multi-agent consensus validation, evidence-based research synthesis, and structured task decomposition into a cohesive, task-anchored workflow.

### Authority

This specification is **AUTHORITATIVE** for:
- RCSD pipeline architecture and stage definitions
- Directory structure under `.cleo/rcsd/`
- RCSD-INDEX.json schema and management
- Manifest schema (`_manifest.json`) per task directory
- Command integration (`ct research`, `ct consensus`, `ct spec`, `ct decompose`)
- Agent deployment and subagent_type mappings for pipeline stages
- Short-name derivation algorithm
- Pipeline-specific exit codes (30-39)

This specification **DEFERS TO**:
- [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) for document structure
- [CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md) for multi-agent consensus methodology
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards and error handling
- [TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md) for decomposition algorithms and atomicity criteria
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for task ID format
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) for phase assignment rules

### Supersedes

This specification supersedes the plugin-based approach explored in T204 and T215-T221. The RCSD Pipeline consolidates research, consensus, specification, and decomposition into a unified, CLI-integrated workflow rather than discrete plugins.

---

## Part 1: Executive Summary

### 1.1 Problem Statement

LLM agents face challenges when translating ambiguous requirements into executable work:

1. **Research fragmentation**: Multi-source research lacks structured synthesis
2. **Unvalidated claims**: Findings proceed without adversarial challenge
3. **Specification drift**: Specs lack formal structure and acceptance criteria
4. **Decomposition gaps**: Tasks lack atomicity verification and dependency validation

### 1.2 Solution Architecture

The RCSD Pipeline provides a 4-stage workflow with adversarial validation at each stage:

```
USER INPUT (Research Topic + Task ID)
       |
       v
+----------------------------------------------+
| STAGE 1: RESEARCH                            |
| Multi-source evidence collection             |
| Output: TXXX_[short-name]_research.json      |
+----------------------+-----------------------+
                       |
                       v
+----------------------------------------------+
| STAGE 2: CONSENSUS                           |
| 5-agent adversarial validation               |
| Output: TXXX_[short-name]_consensus-report.json |
+----------------------+-----------------------+
                       |
                       v
+----------------------------------------------+
| STAGE 3: SPEC                                |
| Structured specification generation          |
| Output: [SHORT-NAME]-SPEC.md                 |
+----------------------+-----------------------+
                       |
                       v
+----------------------------------------------+
| STAGE 4: DECOMPOSE                           |
| Atomic task generation with DAG              |
| Output: Tasks in todo.json with dependencies |
+----------------------------------------------+
```

### 1.3 Core Principles

| Principle | Requirement |
|-----------|-------------|
| **Task-Anchored** | All artifacts stored in task-specific directories |
| **Evidence-Based** | Every claim requires citation or reproducible proof |
| **Adversarial Validation** | Each stage undergoes multi-agent challenge |
| **Structured Output** | All artifacts follow defined schemas |
| **Traceable Lineage** | Research to tasks maintains full provenance |

---

## Part 2: Pipeline Architecture

### 2.1 Stage Overview

| Stage | Input | Output | Agents | Exit Gate |
|-------|-------|--------|--------|-----------|
| **RESEARCH** | Task ID + topic | Research JSON + sources | 1 Research Agent | Evidence threshold met |
| **CONSENSUS** | Research JSON | Consensus Report | 5 Workers + 1 Synthesis | Voting thresholds met |
| **SPEC** | Consensus Report | Spec Markdown | 1 Spec Agent | RFC 2119 compliance |
| **DECOMPOSE** | Spec Markdown | Task DAG | 1 Decompose Agent | Atomicity score >= 100 |

### 2.2 Pipeline Flow

```
ct add "Research: [topic]" --type epic --phase setup
       |
       | (creates T500)
       v
ct research T500
       |
       | (produces .cleo/rcsd/T500_[short-name]/_research.json)
       v
ct consensus T500
       |
       | (produces _consensus-report.json)
       v
ct spec T500
       |
       | (produces [SHORT-NAME]-SPEC.md)
       v
ct decompose --from-task T500
       |
       | (creates T501-T510 in todo.json, updates DAG)
       v
Tasks ready for execution
```

### 2.3 Stage Dependencies

Each stage MUST complete successfully before the next stage begins:

| Stage | Requires | Validates |
|-------|----------|-----------|
| RESEARCH | Valid task ID | Task exists and has type `epic` |
| CONSENSUS | Research output exists | `_research.json` is complete |
| SPEC | Consensus report exists | Consensus verdict is `PROVEN` or `CONTESTED` |
| DECOMPOSE | Spec file exists | Spec has acceptance criteria |

### 2.4 Idempotency

Each stage SHOULD be idempotent:
- Re-running a stage with identical inputs produces identical outputs
- Re-running with modified inputs appends to history, does not overwrite
- Previous versions archived with timestamp suffix

---

## Part 3: Directory Structure

### 3.1 Root Directory

**Location**: `.cleo/rcsd/`

The RCSD directory MUST be created at project initialization or on first pipeline invocation.

```
.cleo/
  rcsd/
    RCSD-INDEX.json              # Master index of all RCSD workflows
    T500_auth-system/            # Task-anchored directory for T500
    T501_caching-strategy/       # Task-anchored directory for T501
    ...
```

### 3.2 Task Directory Structure

**Pattern**: `TXXX_[short-name]/`

Each task-anchored directory contains all artifacts for one RCSD workflow:

```
.cleo/rcsd/T500_auth-system/
  _manifest.json                         # Directory metadata and state
  T500_auth-system_research.json         # Stage 1: Research output
  T500_auth-system_research-sources.json # Stage 1: Source citations
  T500_auth-system_consensus-report.json # Stage 2: Consensus output
  T500_auth-system_voting-matrix.json    # Stage 2: Per-claim votes
  AUTH-SYSTEM-SPEC.md                    # Stage 3: Generated spec
  AUTH-SYSTEM-IMPLEMENTATION-REPORT.md   # Stage 3: Implementation tracker
  T500_auth-system_dag.json              # Stage 4: Task dependency graph
  history/                               # Archived previous versions
    T500_auth-system_research_2025-12-23T10-00-00Z.json
```

### 3.3 Short-Name Derivation Algorithm

The `[short-name]` component is derived from the task title:

```
FUNCTION derive_short_name(title: string) -> string:

    # Step 1: Extract topic (remove "Research: " prefix if present)
    topic = title.replace(/^Research:\s*/i, "")

    # Step 2: Lowercase and sanitize
    name = topic.toLowerCase()

    # Step 3: Replace non-alphanumeric with hyphens
    name = name.replace(/[^a-z0-9]+/g, "-")

    # Step 4: Remove leading/trailing hyphens
    name = name.replace(/^-+|-+$/g, "")

    # Step 5: Collapse multiple hyphens
    name = name.replace(/-+/g, "-")

    # Step 6: Truncate to 30 characters at word boundary
    IF name.length > 30:
        name = name.substring(0, 30)
        name = name.replace(/-[^-]*$/, "")  # Truncate at last hyphen

    # Step 7: Ensure minimum length
    IF name.length < 3:
        name = "topic-" + task_id.toLowerCase()

    RETURN name
```

**Examples**:

| Task Title | Short Name |
|------------|------------|
| "Research: OAuth Authentication Flow" | `oauth-authentication-flow` |
| "Research: LLM Agent Error Handling" | `llm-agent-error-handling` |
| "Implement caching strategy" | `implement-caching-strategy` |
| "X" | `topic-t500` |

### 3.4 Required Files

Each task directory MUST contain:

| File | Stage | Required |
|------|-------|----------|
| `_manifest.json` | All | **MUST** |
| `TXXX_[short-name]_research.json` | RESEARCH | **MUST** after Stage 1 |
| `TXXX_[short-name]_consensus-report.json` | CONSENSUS | **MUST** after Stage 2 |
| `[SHORT-NAME]-SPEC.md` | SPEC | **MUST** after Stage 3 |
| `[SHORT-NAME]-IMPLEMENTATION-REPORT.md` | SPEC | **SHOULD** after Stage 3 |
| `TXXX_[short-name]_dag.json` | DECOMPOSE | **MUST** after Stage 4 |

---

## Part 4: Command Integration

### 4.1 Research Epic Creation

```bash
ct add "Research: [topic]" --type epic --phase setup
```

**Behavior**:
1. Creates task with type `epic` and phase `setup`
2. Adds label `rcsd-research`
3. Creates directory `.cleo/rcsd/TXXX_[short-name]/`
4. Initializes `_manifest.json` with state `created`

**Schema Extension** (task fields):
```json
{
  "shortName": "auth-system",
  "workflow": "rcsd",
  "associations": {
    "rcsdDirectory": ".cleo/rcsd/T500_auth-system/",
    "specFile": null,
    "decomposedTasks": []
  }
}
```

### 4.2 Research Command

```bash
ct research T500 [OPTIONS]
```

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--sources` | string[] | all | Sources: `context7`, `tavily`, `reddit`, `urls` |
| `--depth` | string | `basic` | Research depth: `basic`, `deep` |
| `--topic` | string | from title | Override research topic |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |

**Behavior**:
1. Validate task exists and is type `epic`
2. Derive short-name from task title
3. Invoke Research Agent (see Part 5)
4. Write outputs to task directory
5. Update `_manifest.json` state to `researched`
6. Log operation to todo-log.json

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Research completed |
| 4 | `EXIT_NOT_FOUND` | Task ID not found |
| 30 | `EXIT_RESEARCH_FAILED` | Research agent failed |
| 31 | `EXIT_INSUFFICIENT_SOURCES` | Minimum sources not met |

### 4.3 Consensus Command

```bash
ct consensus T500 [OPTIONS]
```

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--skip-challenge` | boolean | false | Skip Challenge Agent (NOT RECOMMENDED) |
| `--threshold` | integer | 4 | Minimum votes for PROVEN |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |

**Behavior**:
1. Validate `_research.json` exists in task directory
2. Invoke 5 Worker Agents in parallel (see Part 5)
3. Invoke Synthesis Agent to consolidate findings
4. Apply voting thresholds per CONSENSUS-FRAMEWORK-SPEC Part 6
5. Write `_consensus-report.json` to task directory
6. Update `_manifest.json` state to `validated`
7. Trigger HITL gate if verdict is `CONTESTED` or `INSUFFICIENT_EVIDENCE`

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Consensus completed |
| 4 | `EXIT_NOT_FOUND` | Research output not found |
| 32 | `EXIT_CONSENSUS_FAILED` | Consensus could not be reached |
| 33 | `EXIT_HITL_REQUIRED` | Human decision required |

### 4.4 Spec Command

```bash
ct spec T500 [OPTIONS]
```

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--template` | string | `default` | Spec template to use |
| `--output` | path | auto | Custom output path |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |

**Behavior**:
1. Validate `_consensus-report.json` exists
2. Validate consensus verdict is `PROVEN` or `CONTESTED` (with HITL resolution)
3. Invoke Spec Agent to generate specification
4. Validate output against SPEC-BIBLE-GUIDELINES
5. Write `[SHORT-NAME]-SPEC.md` to task directory
6. Write `[SHORT-NAME]-IMPLEMENTATION-REPORT.md` scaffold
7. Update `_manifest.json` state to `specified`

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Spec generated |
| 4 | `EXIT_NOT_FOUND` | Consensus report not found |
| 34 | `EXIT_SPEC_INVALID` | Generated spec fails validation |
| 33 | `EXIT_HITL_REQUIRED` | Contested claims need resolution |

### 4.5 Decompose Command

```bash
ct decompose --from-task T500 [OPTIONS]
```

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--from-task` | string | required | Source task ID with spec |
| `--phase` | string | `core` | Target phase for generated tasks |
| `--parent` | string | T500 | Parent for generated tasks |
| `--no-challenge` | boolean | false | Skip atomicity challenge |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |

**Behavior**:
1. Validate spec file exists in task directory
2. Parse spec for requirements and acceptance criteria
3. Invoke Decompose Agent per TASK-DECOMPOSITION-SPEC
4. Generate atomic tasks with dependencies
5. Write `_dag.json` to task directory
6. Create tasks in `todo.json` with `parentId` set to source task
7. Update source task `associations.decomposedTasks`
8. Update `_manifest.json` state to `decomposed`

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Decomposition completed |
| 4 | `EXIT_NOT_FOUND` | Spec file not found |
| 11 | `EXIT_DEPTH_EXCEEDED` | Would exceed hierarchy depth |
| 12 | `EXIT_SIBLING_LIMIT` | Would exceed sibling limit |
| 14 | `EXIT_CIRCULAR_REFERENCE` | DAG contains cycles |
| 35 | `EXIT_ATOMICITY_FAILED` | Tasks fail atomicity criteria |

---

## Part 5: Agent Deployment

### 5.1 Agent Architecture

The RCSD Pipeline deploys 9 guardrailed agents across 4 stages:

```
+-------------------------------------------------------------------+
| STAGE 1: RESEARCH                                                  |
|   1x Research Agent                                                |
+-------------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| STAGE 2: CONSENSUS                                                 |
|   5x Worker Agents (parallel)                                      |
|     - Technical Validator                                          |
|     - Design Philosophy                                            |
|     - Documentation Agent                                          |
|     - Implementation Agent                                         |
|     - Challenge Agent (Red Team)                                   |
|   1x Synthesis Agent                                               |
+-------------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| STAGE 3: SPEC                                                      |
|   1x Spec Agent                                                    |
+-------------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| STAGE 4: DECOMPOSE                                                 |
|   1x Decompose Agent                                               |
+-------------------------------------------------------------------+

TOTAL: 9 Agents (1 + 6 + 1 + 1)
```

### 5.2 Subagent Type Mappings

| Agent | `subagent_type` | Rationale |
|-------|-----------------|-----------|
| Research Agent | `researcher` | Deep investigation, source synthesis |
| Technical Validator | `backend-architect` | System reliability, performance |
| Design Philosophy | `frontend-architect` | UX, API design, ergonomics |
| Documentation Agent | `technical-writer` | Documentation clarity, accuracy |
| Implementation Agent | `refactoring-expert` | Code quality, feasibility |
| Challenge Agent | `requirements-analyst` | Adversarial analysis, edge cases |
| Synthesis Agent | `project-supervisor-orchestrator` | Cross-domain consolidation |
| Spec Agent | `technical-writer` | Formal specification writing |
| Decompose Agent | `requirements-analyst` | Task breakdown, atomicity |

### 5.3 Evidence Standards Per Agent

| Agent | Evidence Standard | Minimum Citations |
|-------|-------------------|-------------------|
| Research Agent | External sources with URLs | 3+ unique sources |
| Technical Validator | Reproducible test (3/3 runs) OR code analysis | file:line citations |
| Design Philosophy | Comparative analysis | Measurable advantage |
| Documentation Agent | Code contradiction proof | file:line evidence |
| Implementation Agent | Code search + doc search | Negative proof |
| Challenge Agent | Logical counter-argument OR counter-example | Reference to claim |
| Synthesis Agent | Citation of worker findings | Cross-reference |
| Spec Agent | RFC 2119 keywords properly applied | Normative requirements |
| Decompose Agent | Atomicity score calculation | 6-point criteria |

### 5.4 Anti-Hallucination Rules

All agents MUST adhere to:

1. **No Unverified Claims**: Every assertion requires citation or reproducible proof
2. **Explicit Uncertainty**: Use "INSUFFICIENT_EVIDENCE" when data is lacking
3. **Bounded Assertions**: No claims beyond source material scope
4. **Challenge Requirement**: Challenge Agent MUST provide substantive findings (minimum 2)
5. **Source Validation**: External URLs must be verified accessible
6. **Cross-Reference Required**: Claims spanning domains require multiple agent confirmation

---

## Part 6: Schema Requirements

### 6.1 Task Schema Additions

The following fields MUST be added to `todo.schema.json`:

```json
{
  "shortName": {
    "type": ["string", "null"],
    "pattern": "^[a-z][a-z0-9-]*$",
    "maxLength": 30,
    "description": "Derived short name for RCSD directory naming"
  },
  "workflow": {
    "type": ["string", "null"],
    "enum": ["rcsd", "standard", null],
    "default": null,
    "description": "Workflow type for this task"
  },
  "associations": {
    "type": ["object", "null"],
    "properties": {
      "rcsdDirectory": {
        "type": ["string", "null"],
        "description": "Path to RCSD directory relative to project root"
      },
      "specFile": {
        "type": ["string", "null"],
        "description": "Path to generated spec file"
      },
      "decomposedTasks": {
        "type": "array",
        "items": { "type": "string", "pattern": "^T\\d{3,}$" },
        "description": "Task IDs generated from this epic's spec"
      }
    }
  }
}
```

### 6.2 RCSD-INDEX.json Schema

**Location**: `.cleo/rcsd/RCSD-INDEX.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-index.schema.json",
  "version": "1.0.0",
  "lastUpdated": "2025-12-23T10:00:00Z",
  "workflows": [
    {
      "taskId": "T500",
      "shortName": "auth-system",
      "directory": ".cleo/rcsd/T500_auth-system/",
      "state": "decomposed",
      "stages": {
        "research": {
          "completedAt": "2025-12-23T10:05:00Z",
          "sourceCount": 8
        },
        "consensus": {
          "completedAt": "2025-12-23T10:15:00Z",
          "verdict": "PROVEN",
          "voteCount": { "proven": 4, "refuted": 0, "contested": 1 }
        },
        "spec": {
          "completedAt": "2025-12-23T10:20:00Z",
          "specFile": "AUTH-SYSTEM-SPEC.md"
        },
        "decompose": {
          "completedAt": "2025-12-23T10:25:00Z",
          "taskCount": 7,
          "taskIds": ["T501", "T502", "T503", "T504", "T505", "T506", "T507"]
        }
      },
      "createdAt": "2025-12-23T10:00:00Z"
    }
  ],
  "statistics": {
    "totalWorkflows": 1,
    "byState": {
      "created": 0,
      "researched": 0,
      "validated": 0,
      "specified": 0,
      "decomposed": 1
    }
  }
}
```

### 6.3 Manifest Schema (_manifest.json)

**Location**: `.cleo/rcsd/TXXX_[short-name]/_manifest.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-manifest.schema.json",
  "taskId": "T500",
  "shortName": "auth-system",
  "title": "Research: OAuth Authentication Flow",
  "state": "decomposed",
  "createdAt": "2025-12-23T10:00:00Z",
  "updatedAt": "2025-12-23T10:25:00Z",
  "stages": {
    "research": {
      "state": "completed",
      "startedAt": "2025-12-23T10:00:00Z",
      "completedAt": "2025-12-23T10:05:00Z",
      "agent": "researcher",
      "outputs": ["T500_auth-system_research.json"],
      "sourceCount": 8,
      "checksum": "sha256:abc123..."
    },
    "consensus": {
      "state": "completed",
      "startedAt": "2025-12-23T10:05:00Z",
      "completedAt": "2025-12-23T10:15:00Z",
      "agents": ["technical-validator", "design-philosophy", "docs", "impl", "challenge", "synthesis"],
      "outputs": ["T500_auth-system_consensus-report.json", "T500_auth-system_voting-matrix.json"],
      "verdict": "PROVEN",
      "votingMatrix": { "proven": 4, "refuted": 0, "contested": 1 },
      "checksum": "sha256:def456..."
    },
    "spec": {
      "state": "completed",
      "startedAt": "2025-12-23T10:15:00Z",
      "completedAt": "2025-12-23T10:20:00Z",
      "agent": "spec-writer",
      "outputs": ["AUTH-SYSTEM-SPEC.md", "AUTH-SYSTEM-IMPLEMENTATION-REPORT.md"],
      "requirementCount": 23,
      "checksum": "sha256:ghi789..."
    },
    "decompose": {
      "state": "completed",
      "startedAt": "2025-12-23T10:20:00Z",
      "completedAt": "2025-12-23T10:25:00Z",
      "agent": "decomposer",
      "outputs": ["T500_auth-system_dag.json"],
      "taskCount": 7,
      "taskIds": ["T501", "T502", "T503", "T504", "T505", "T506", "T507"],
      "checksum": "sha256:jkl012..."
    }
  },
  "history": [
    {
      "timestamp": "2025-12-23T10:00:00Z",
      "event": "created",
      "details": { "source": "ct add" }
    },
    {
      "timestamp": "2025-12-23T10:05:00Z",
      "event": "stage_completed",
      "details": { "stage": "research" }
    }
  ]
}
```

### 6.4 Research Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-research.schema.json",
  "_meta": {
    "stage": "research",
    "version": "1.0.0",
    "timestamp": "2025-12-23T10:05:00Z",
    "taskId": "T500",
    "shortName": "auth-system"
  },
  "topic": "OAuth Authentication Flow",
  "sources": [
    {
      "id": "SRC-001",
      "type": "context7",
      "library": "/auth0/docs",
      "url": "https://auth0.com/docs/get-started/authentication-and-authorization-flow",
      "title": "Authentication and Authorization Flows",
      "relevance": 0.95,
      "extractedAt": "2025-12-23T10:01:00Z"
    }
  ],
  "findings": [
    {
      "id": "FND-001",
      "claim": "OAuth 2.0 authorization code flow is recommended for server-side applications",
      "evidence": "Auth0 documentation explicitly recommends authorization code flow for confidential clients",
      "sources": ["SRC-001"],
      "confidence": 0.95,
      "category": "best-practice"
    }
  ],
  "summary": {
    "topicCoverage": "comprehensive",
    "findingCount": 12,
    "sourceCount": 8,
    "categories": ["best-practice", "security", "implementation"]
  }
}
```

### 6.5 Consensus Report Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-consensus.schema.json",
  "_meta": {
    "stage": "consensus",
    "version": "1.0.0",
    "timestamp": "2025-12-23T10:15:00Z",
    "taskId": "T500",
    "framework": "CONSENSUS-FRAMEWORK-SPEC v2.0.0"
  },
  "methodology": {
    "agentCount": 6,
    "evidenceStandards": "per CONSENSUS-FRAMEWORK-SPEC Part 6.2",
    "votingThreshold": 4
  },
  "claims": [
    {
      "id": "CLM-001",
      "statement": "Authorization code flow is most secure for server-side apps",
      "sourceFindings": ["FND-001", "FND-003"],
      "votes": {
        "technicalValidator": "proven",
        "designPhilosophy": "proven",
        "documentationAgent": "proven",
        "implementationAgent": "proven",
        "challengeAgent": "contested"
      },
      "verdict": "PROVEN",
      "evidence": "4/5 agents agree with reproducible evidence from official documentation",
      "challengeFindings": [
        {
          "agent": "challenge",
          "finding": "PKCE extension should be mentioned for additional security",
          "severity": "minor",
          "addressed": true
        }
      ]
    }
  ],
  "overallVerdict": "PROVEN",
  "consensusMetrics": {
    "claimsAnalyzed": 12,
    "provenCount": 10,
    "refutedCount": 0,
    "contestedCount": 2,
    "insufficientEvidenceCount": 0
  },
  "recommendations": [
    {
      "type": "spec-requirement",
      "priority": "high",
      "text": "Specification MUST include PKCE extension requirement"
    }
  ],
  "hitlGates": []
}
```

### 6.6 Spec Frontmatter Schema

Specifications generated by the SPEC stage MUST include frontmatter:

```markdown
# [Topic] Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-23
**Last Updated**: 2025-12-23
**RCSD Source**: T500
**RCSD Directory**: .cleo/rcsd/T500_auth-system/
**Implementation Report**: [Topic]-IMPLEMENTATION-REPORT.md

---

## RFC 2119 Conformance

[Standard boilerplate per SPEC-BIBLE-GUIDELINES Part 3.2]

---
```

---

## Part 7: Phase Integration

### 7.1 Research Epics Phase Assignment

Research epics MUST be assigned to the `setup` phase:

```bash
ct add "Research: OAuth Authentication" --type epic --phase setup
```

**Rationale**: Research and specification work is foundational and precedes implementation.

### 7.2 Decomposed Tasks Phase Assignment

Tasks generated by decomposition SHOULD be assigned to the `core` phase by default:

```bash
ct decompose --from-task T500 --phase core
```

**Override**: Use `--phase` flag to assign to a different phase.

### 7.3 Cross-Phase Work

Cross-phase work is PERMITTED per PHASE-SYSTEM-SPEC Section 5.2:

- Agents MAY work on research tasks (setup phase) while the project is in `core` phase
- No blocking occurs for cross-phase operations
- Optional warning available via `validation.warnPhaseContext: true` config

### 7.4 Phase Transitions

When all decomposed tasks are completed:
1. Source epic MAY be marked complete
2. Project phase MAY advance from `setup` to `core`
3. Phase history updated per PHASE-SYSTEM-SPEC Section 2.3

---

## Part 8: Output Artifacts

### 8.1 File Naming Conventions

| Artifact Type | Pattern | Example |
|---------------|---------|---------|
| Research output | `TXXX_[short-name]_research.json` | `T500_auth-system_research.json` |
| Research sources | `TXXX_[short-name]_research-sources.json` | `T500_auth-system_research-sources.json` |
| Consensus report | `TXXX_[short-name]_consensus-report.json` | `T500_auth-system_consensus-report.json` |
| Voting matrix | `TXXX_[short-name]_voting-matrix.json` | `T500_auth-system_voting-matrix.json` |
| Specification | `[SHORT-NAME]-SPEC.md` | `AUTH-SYSTEM-SPEC.md` |
| Implementation report | `[SHORT-NAME]-IMPLEMENTATION-REPORT.md` | `AUTH-SYSTEM-IMPLEMENTATION-REPORT.md` |
| Task DAG | `TXXX_[short-name]_dag.json` | `T500_auth-system_dag.json` |
| Manifest | `_manifest.json` | `_manifest.json` |

### 8.2 Specification Format

Generated specifications MUST comply with SPEC-BIBLE-GUIDELINES:

- RFC 2119 conformance section
- Numbered Parts for major topics
- Related Specifications section
- No status tracking (use Implementation Report)
- No checklists or progress indicators

### 8.3 Implementation Report Format

Generated implementation reports follow SPEC-BIBLE-GUIDELINES Part 8:

```markdown
# [Topic] Implementation Report

**Purpose**: Track implementation progress
**Related Spec**: [Topic]-SPEC.md
**Last Updated**: YYYY-MM-DD
**RCSD Source**: TXXX

---

## Summary

| Metric | Value |
|--------|-------|
| Overall Progress | 0% |
| Components Complete | 0/X |
| Current Phase | setup |

---

## Component Status

| Component | Status | Notes |
|-----------|--------|-------|
| [From spec] | PENDING | |

---

## Phase Tracking

### Phase 1: Foundation - PENDING

- [ ] Task 1
- [ ] Task 2

---
```

---

## Part 9: Error Codes

### 9.1 Pipeline Exit Codes (30-39)

| Code | Constant | Meaning | Recoverable |
|------|----------|---------|-------------|
| 30 | `EXIT_RESEARCH_FAILED` | Research agent failed to complete | Yes |
| 31 | `EXIT_INSUFFICIENT_SOURCES` | Minimum source threshold not met | Yes |
| 32 | `EXIT_CONSENSUS_FAILED` | Consensus could not be reached | Yes |
| 33 | `EXIT_HITL_REQUIRED` | Human decision required | Yes |
| 34 | `EXIT_SPEC_INVALID` | Generated spec fails validation | Yes |
| 35 | `EXIT_ATOMICITY_FAILED` | Decomposed tasks fail atomicity | Yes |
| 36 | `EXIT_MANIFEST_CORRUPT` | _manifest.json is invalid | Yes |
| 37 | `EXIT_STAGE_PREREQUISITE` | Previous stage not completed | Yes |
| 38 | `EXIT_INDEX_CORRUPT` | RCSD-INDEX.json is invalid | Yes |
| 39 | `EXIT_WORKFLOW_EXISTS` | RCSD workflow already exists for task | Yes |

### 9.2 Error Code Strings

| Exit Code | String Code | Description |
|-----------|-------------|-------------|
| 30 | `E_RESEARCH_FAILED` | Research agent failed |
| 31 | `E_INSUFFICIENT_SOURCES` | Source count below threshold |
| 32 | `E_CONSENSUS_FAILED` | No consensus reached |
| 33 | `E_HITL_REQUIRED` | Human input needed |
| 34 | `E_SPEC_INVALID` | Spec validation failed |
| 35 | `E_ATOMICITY_FAILED` | Atomicity criteria not met |
| 36 | `E_MANIFEST_CORRUPT` | Manifest file invalid |
| 37 | `E_STAGE_PREREQUISITE` | Stage dependency not met |
| 38 | `E_INDEX_CORRUPT` | Index file invalid |
| 39 | `E_WORKFLOW_EXISTS` | Duplicate workflow |

### 9.3 Error Recovery Protocols

| Error | Recovery Action |
|-------|-----------------|
| `E_RESEARCH_FAILED` | Retry with `--depth deep` or alternative sources |
| `E_INSUFFICIENT_SOURCES` | Add sources manually or lower threshold |
| `E_CONSENSUS_FAILED` | Review findings, trigger HITL gate |
| `E_HITL_REQUIRED` | Present options to user, await decision |
| `E_SPEC_INVALID` | Review spec, fix RFC 2119 compliance |
| `E_ATOMICITY_FAILED` | Further decompose non-atomic tasks |
| `E_MANIFEST_CORRUPT` | Run `ct validate --fix` to repair |
| `E_STAGE_PREREQUISITE` | Complete required previous stage |
| `E_INDEX_CORRUPT` | Rebuild index from manifest files |
| `E_WORKFLOW_EXISTS` | Use existing workflow or `--force` to restart |

---

## Part 10: Conformance

### 10.1 Conformance Classes

A conforming implementation MUST:
- Implement all 4 pipeline stages (RESEARCH, CONSENSUS, SPEC, DECOMPOSE)
- Create task-anchored directories per Part 3.2
- Maintain RCSD-INDEX.json per Part 6.2
- Deploy agents with specified subagent_types per Part 5.2
- Apply evidence standards per Part 5.3
- Support all exit codes defined in Part 9.1
- Source required libraries per LLM-AGENT-FIRST-SPEC Part 4

A conforming implementation SHOULD:
- Implement HITL gates per CONSENSUS-FRAMEWORK-SPEC Part 10
- Generate Implementation Reports alongside Specs
- Archive previous versions in `history/` subdirectory
- Meet latency targets per TASK-DECOMPOSITION-SPEC Part 14.1

A conforming implementation MAY:
- Use alternative agent subagent_types with documented rationale
- Extend manifest schema with additional metadata
- Add custom stages between SPEC and DECOMPOSE

---

## Part 11: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification structure and RFC 2119 usage |
| **[CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md)** | **AUTHORITATIVE** for multi-agent consensus methodology, voting thresholds, evidence standards |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE** for JSON output standards, error handling, exit codes 0-29 |
| **[TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md)** | **AUTHORITATIVE** for decomposition algorithms, atomicity criteria, DAG construction |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **AUTHORITATIVE** for task ID format (TXXX pattern) |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **Related**: Phase assignment for research epics and decomposed tasks |
| **[RCSD-PIPELINE-IMPLEMENTATION-REPORT.md](RCSD-PIPELINE-IMPLEMENTATION-REPORT.md)** | Tracks implementation status for this specification |

---

## Appendix A: Quick Reference

### Pipeline Commands

```bash
# Create research epic
ct add "Research: [topic]" --type epic --phase setup

# Run research stage
ct research T500

# Run consensus stage
ct consensus T500

# Generate specification
ct spec T500

# Decompose into tasks
ct decompose --from-task T500 --phase core
```

### Directory Structure

```
.cleo/rcsd/
  RCSD-INDEX.json
  T500_auth-system/
    _manifest.json
    T500_auth-system_research.json
    T500_auth-system_consensus-report.json
    AUTH-SYSTEM-SPEC.md
    AUTH-SYSTEM-IMPLEMENTATION-REPORT.md
    T500_auth-system_dag.json
```

### State Transitions

```
created --> researched --> validated --> specified --> decomposed
   |            |             |             |              |
   |            |             |             |              +-- Stage 4 complete
   |            |             |             +-- Stage 3 complete
   |            |             +-- Stage 2 complete
   |            +-- Stage 1 complete
   +-- Task created, directory initialized
```

---

## Appendix B: Changelog

### Version 1.0.0 (2025-12-23)
- Initial specification
- 4-stage pipeline architecture (RESEARCH, CONSENSUS, SPEC, DECOMPOSE)
- Task-anchored directory structure (`.cleo/rcsd/TXXX_[short-name]/`)
- 9-agent deployment model
- RCSD-INDEX.json master index
- Manifest schema (_manifest.json)
- Short-name derivation algorithm
- Pipeline-specific exit codes (30-39)
- Integration with existing specifications

---

*End of Specification*
