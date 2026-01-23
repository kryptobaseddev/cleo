# RCSD Pipeline Specification

**Version**: 2.0.0
**Status**: DRAFT
**Created**: 2025-12-23
**Last Updated**: 2025-12-29
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

This specification defines the **Research-Consensus-Spec-Decompose (RCSD) Pipeline**, a unified workflow for transforming research topics into validated specifications and atomic executable tasks. The pipeline integrates multi-agent consensus validation, evidence-based research synthesis, structured task decomposition, and delta-based spec evolution into a cohesive, task-anchored workflow.

### Authority

This specification is **AUTHORITATIVE** for:

- RCSD pipeline architecture and stage definitions
- Directory structure under `.cleo/rcsd/`
- Spec and changes directory architecture (`.cleo/specs/`, `.cleo/changes/`)
- RCSD-INDEX.json schema and management
- Manifest schema (`_manifest.json`) per task directory
- Command integration (`ct research`, `ct consensus`, `ct spec`, `ct decompose`)
- Slash command patterns (`/ct:research`, `/ct:consensus`, `/ct:spec`, `/ct:decompose`)
- Agent deployment and subagent_type mappings for pipeline stages
- Delta format for spec evolution (ADDED/MODIFIED/REMOVED/RENAMED)
- HITL gate formalization and resolution records
- Evidence weighting model
- Short-name derivation algorithm
- Pipeline-specific exit codes (30-39)

This specification **DEFERS TO**:

- [SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md) for document structure
- [CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md) for multi-agent consensus methodology
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards and error handling
- [TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md) for decomposition algorithms and atomicity criteria
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for task ID format
- [PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md) for phase assignment rules

### What's New in v2.0.0

| Feature | Description |
|---------|-------------|
| **Python Implementation** | Agent orchestration via Anthropic Agent SDK (Python) |
| **Feedback Loops** | Explicit backward transitions between stages |
| **HITL Formalization** | Structured capture, timeouts, and audit logging |
| **Evidence Weighting** | Weighted scoring beyond simple votes |
| **Idempotency Correction** | Semantic equivalence or deterministic seeding |
| **Eager Execution** | Parallel stage execution with provisional marking |
| **Observability** | Metrics and quality signals |
| **Delta Format** | ADDED/MODIFIED/REMOVED/RENAMED for spec evolution |
| **AGENTS.md Convention** | Universal AI instructions for tool compatibility |
| **Slash Commands** | IDE-native command discovery |
| **Structural Validation** | Regex-based RFC 2119 detection |

### Supersedes

This specification supersedes v1.0.0 and the plugin-based bash approach explored in T204 and T215-T221. The RCSD Pipeline v2.0.0 implements the 9-agent architecture using Python and the Anthropic Agent SDK for proper agent orchestration.

### Legacy Cleanup (2026-01-23)

To reduce competing sources, the exploratory RCSD v1.1 research bundle in `claudedocs/RCSD-Pipeline-v1-1/` was removed on 2026-01-23. This specification remains the canonical reference for RCSD.

Removed artifacts:
- `RCSD-PIPELINE-SPEC-v1.1.md`
- `RCSD-Pipeline-v1-1-Improvements.md`
- `RCSD-PIPELINE-v1.1-CHANGELOG.md`
- `RCSD-OpenSpec-Research.md`
- `ct-research.md`
- `ct-consensus.md`
- `ct-spec.md`
- `ct-decompose.md`
- `OPENSPEC-ACTION-ITEMS.md`
- `PROMPT-RCSD-Pipeline-Design.txt`
- `AGENTS.md.template`
- `PROJECT-CONTEXT.md.template`

Cleanup commit: TBD

Note: `claudedocs/` is git-ignored in this repo. The cleanup commit records the decision but does not retain these files. Restore from external backups or another clone if recovery is needed.

---

## Part 1: Executive Summary

### 1.1 Problem Statement

LLM agents face challenges when translating ambiguous requirements into executable work:

1. **Research fragmentation**: Multi-source research lacks structured synthesis
2. **Unvalidated claims**: Findings proceed without adversarial challenge
3. **Specification drift**: Specs lack formal structure and acceptance criteria
4. **Decomposition gaps**: Tasks lack atomicity verification and dependency validation
5. **Evolution chaos**: Spec changes are not tracked systematically
6. **Tool lock-in**: Workflows are tied to specific AI assistants
7. **Orchestration limits**: Bash scripts cannot orchestrate 9 parallel AI agents

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
| Delta: .cleo/changes/[feature]/specs/[domain]/|
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
| **Delta-Tracked Evolution** | Spec changes use ADDED/MODIFIED/REMOVED format |
| **Tool-Agnostic** | AGENTS.md enables any AI assistant |

---

## Part 2: Implementation Architecture

### 2.1 Python Package Structure

The RCSD Pipeline is implemented as a Python package using the Anthropic Agent SDK:

```
lib/rcsd/
├── __init__.py                    # Package initialization
├── cli.py                         # Entry point: python -m rcsd.cli
├── agents/
│   ├── __init__.py
│   ├── base.py                    # BaseAgent abstract class
│   ├── research.py                # ResearchAgent
│   ├── consensus/
│   │   ├── __init__.py
│   │   ├── technical.py           # TechnicalValidatorAgent
│   │   ├── design.py              # DesignPhilosophyAgent
│   │   ├── documentation.py       # DocumentationAgent
│   │   ├── implementation.py      # ImplementationAgent
│   │   ├── challenge.py           # ChallengeAgent
│   │   └── synthesis.py           # SynthesisAgent
│   ├── spec.py                    # SpecAgent
│   └── decompose.py               # DecomposeAgent
├── models/
│   ├── __init__.py
│   ├── manifest.py                # ManifestModel (Pydantic)
│   ├── research.py                # ResearchOutput models
│   ├── consensus.py               # ConsensusReport models
│   ├── task.py                    # Task models
│   └── hitl.py                    # HITL Resolution models
├── orchestration/
│   ├── __init__.py
│   ├── pipeline.py                # RCSDPipeline orchestrator
│   ├── parallel.py                # Parallel agent execution
│   └── hitl.py                    # HITL gate handling
├── output/
│   ├── __init__.py
│   └── formatter.py               # LLM-AGENT-FIRST JSON formatter
├── validation/
│   ├── __init__.py
│   ├── schema.py                  # JSON Schema validation
│   └── spec.py                    # Spec format validation
└── utils/
    ├── __init__.py
    ├── shortname.py               # Short-name derivation
    └── files.py                   # File operations
```

### 2.2 Anthropic Agent SDK Integration

Each RCSD agent is implemented using the Anthropic Agent SDK pattern:

```python
from anthropic import Anthropic

class BaseAgent:
    """Base class for all RCSD agents."""

    def __init__(self, subagent_type: str, model: str = "claude-sonnet-4-20250514"):
        self.client = Anthropic()
        self.subagent_type = subagent_type
        self.model = model

    async def run(self, prompt: str, context: dict) -> dict:
        """Execute agent with evidence-based validation."""
        response = self.client.messages.create(
            model=self.model,
            max_tokens=8096,
            system=self.get_system_prompt(),
            messages=[{"role": "user", "content": prompt}]
        )
        return self.validate_response(response)
```

### 2.3 Bash Wrapper Integration

The Python implementation is invoked via bash wrappers for CLI compatibility:

```bash
# scripts/research.sh
#!/usr/bin/env bash
python -m rcsd.cli research "$@"

# scripts/consensus.sh
#!/usr/bin/env bash
python -m rcsd.cli consensus "$@"
```

---

## Part 3: Pipeline Architecture

### 3.1 Stage Overview

| Stage | Input | Output | Agents | Exit Gate |
|-------|-------|--------|--------|-----------|
| **RESEARCH** | Task ID + topic | Research JSON + sources | 1 Research Agent | Evidence threshold met |
| **CONSENSUS** | Research JSON | Consensus Report | 5 Workers + 1 Synthesis | Voting thresholds met |
| **SPEC** | Consensus Report | Spec Markdown + Delta | 1 Spec Agent | RFC 2119 compliance |
| **DECOMPOSE** | Spec Markdown | Task DAG | 1 Decompose Agent | Atomicity score >= 100 |

### 3.2 Pipeline Flow

```
ct add "Research: [topic]" --type epic --phase setup
       |
       | (creates T500)
       v
ct research T500              # or /ct:research T500
       |
       | (produces .cleo/rcsd/T500_[short-name]/_research.json)
       v
ct consensus T500             # or /ct:consensus T500
       |
       | (produces _consensus-report.json)
       v
ct spec T500                  # or /ct:spec T500
       |
       | (produces [SHORT-NAME]-SPEC.md + delta in changes/)
       v
ct decompose --from-task T500 # or /ct:decompose T500
       |
       | (creates T501-T510 in todo.json, updates DAG)
       v
Tasks ready for execution
```

### 3.3 Stage Dependencies

Each stage MUST complete successfully before the next stage begins (unless eager execution is enabled):

| Stage | Requires | Validates |
|-------|----------|-----------|
| RESEARCH | Valid task ID | Task exists and has type `epic` |
| CONSENSUS | Research output exists | `_research.json` is complete |
| SPEC | Consensus report exists | Consensus verdict is `PROVEN` or `CONTESTED` |
| DECOMPOSE | Spec file exists | Spec has acceptance criteria |

### 3.4 State Machine

#### 3.4.1 Allowed States

```
created
    |
    v
researched
    |
    v
validated
    |
    v
specified
    |
    v
decomposed
```

#### 3.4.2 Revision Loop States

A workflow state `revision_required` represents a blocking need for revision before progression:

```
specified --> revision_required --> researched
decomposed --> revision_required --> specified
```

After successful completion of the revision target stage, the pipeline resumes forward progression.

### 3.5 Idempotency

#### 3.5.1 Semantic Equivalence Model (Default)

Re-running a stage with identical inputs SHOULD produce semantically equivalent outputs.

Semantic equivalence SHOULD be validated by:

- Stable requirement IDs
- Stable claim IDs
- Similarity thresholds for summaries
- Invariant counts for required fields

#### 3.5.2 Deterministic Seeding Model (Optional)

Implementations MAY support deterministic outputs by requiring:

- Fixed model version
- Fixed temperature and sampling parameters
- Fixed random seed
- Fixed tool outputs (including web results and timestamps)

If deterministic mode is enabled, the implementation MUST store all determinism parameters in stage attempt metadata.

---

## Part 4: Directory Structure

### 4.1 Root Directory

**Location**: `.cleo/rcsd/`

The RCSD directory MUST be created at project initialization or on first pipeline invocation.

```
.cleo/
├── rcsd/
│   ├── RCSD-INDEX.json              # Master index of all RCSD workflows
│   ├── T500_auth-system/            # Task-anchored directory for T500
│   ├── T501_caching-strategy/       # Task-anchored directory for T501
│   └── ...
├── specs/                           # SOURCE OF TRUTH (stable specs)
│   └── [domain]/
│       └── [SHORT-NAME]-SPEC.md
├── changes/                         # PROPOSALS (active work)
│   └── [feature-name]/
│       ├── proposal.md
│       ├── tasks.md
│       └── specs/[domain]/          # DELTA specs
│           └── [SHORT-NAME]-SPEC.md
├── AGENTS.md                        # Universal AI instructions
└── PROJECT-CONTEXT.md               # Project context for AI
```

### 4.2 Task Directory Structure

**Pattern**: `TXXX_[short-name]/`

Each task-anchored directory contains all artifacts for one RCSD workflow:

```
.cleo/rcsd/T500_auth-system/
├── _manifest.json                           # Directory metadata and state
├── T500_auth-system_research.json           # Stage 1: Research output
├── T500_auth-system_research-sources.json   # Stage 1: Source citations
├── T500_auth-system_consensus-report.json   # Stage 2: Consensus output
├── T500_auth-system_voting-matrix.json      # Stage 2: Per-claim votes
├── AUTH-SYSTEM-SPEC.md                      # Stage 3: Generated spec
├── AUTH-SYSTEM-IMPLEMENTATION-REPORT.md     # Stage 3: Implementation tracker
├── T500_auth-system_dag.json                # Stage 4: Task dependency graph
├── hitl/                                    # HITL Resolution Records
│   └── HITL-RESOLUTION-HR-001.json
├── metrics/                                 # Observability artifacts
│   └── RCSD-METRICS.json
└── history/                                 # Archived previous versions
    └── T500_auth-system_research_2025-12-23T10-00-00Z.json
```

### 4.3 Specs Directory (Source of Truth)

**Location**: `.cleo/specs/`

This directory contains the **stable, approved specifications**. Specs here are the canonical truth for the project.

```
.cleo/specs/
├── auth/
│   └── AUTH-SYSTEM-SPEC.md
├── cache/
│   └── CACHING-STRATEGY-SPEC.md
└── api/
    └── API-GATEWAY-SPEC.md
```

### 4.4 Changes Directory (Proposals)

**Location**: `.cleo/changes/`

This directory contains **proposed changes** that have not yet been merged into the source of truth.

```
.cleo/changes/
├── add-oauth-flow/
│   ├── proposal.md                  # Change proposal description
│   ├── tasks.md                     # Implementation tasks
│   └── specs/auth/
│       └── AUTH-SYSTEM-SPEC.md      # DELTA spec (not full spec)
├── archive/                         # Merged/closed proposals
│   └── 2025-12-23-session-tokens/
└── ...
```

### 4.5 Short-Name Derivation Algorithm

The `[short-name]` component is derived from the task title:

```python
def derive_short_name(title: str, task_id: str) -> str:
    """Derive short name from task title."""
    import re

    # Step 1: Extract topic (remove "Research: " prefix if present)
    topic = re.sub(r'^Research:\s*', '', title, flags=re.IGNORECASE)

    # Step 2: Lowercase and sanitize
    name = topic.lower()

    # Step 3: Replace non-alphanumeric with hyphens
    name = re.sub(r'[^a-z0-9]+', '-', name)

    # Step 4: Remove leading/trailing hyphens
    name = name.strip('-')

    # Step 5: Collapse multiple hyphens
    name = re.sub(r'-+', '-', name)

    # Step 6: Truncate to 30 characters at word boundary
    if len(name) > 30:
        name = name[:30]
        name = re.sub(r'-[^-]*$', '', name)  # Truncate at last hyphen

    # Step 7: Ensure minimum length
    if len(name) < 3:
        name = f"topic-{task_id.lower()}"

    return name
```

**Examples**:

| Task Title | Short Name |
|------------|------------|
| "Research: OAuth Authentication Flow" | `oauth-authentication-flow` |
| "Research: LLM Agent Error Handling" | `llm-agent-error-handling` |
| "Implement caching strategy" | `implement-caching-strategy` |
| "X" | `topic-t500` |

### 4.6 Required Files

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

## Part 5: Delta Format for Spec Evolution

### 5.1 Overview

Spec evolution MUST use the delta format to track changes cleanly. Delta files contain only the differences, not the complete spec.

### 5.2 Delta Sections

```markdown
# Delta for [SPEC-NAME]

## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST require a second factor during login.

#### Scenario: OTP Required
- WHEN a user submits valid credentials
- THEN an OTP challenge is required

## MODIFIED Requirements

### Requirement: User Authentication
[Complete updated requirement with scenarios - wholesale replacement]

## REMOVED Requirements

### Requirement: Legacy Password Authentication
[Optional rationale for removal]

## RENAMED Requirements

### Requirement: Session Token (from: Access Token)
```

### 5.3 Delta Merge Algorithm

Delta operations MUST be applied in this order:

1. **RENAMED** - Updates requirement names only
2. **REMOVED** - Marks sections for deletion
3. **MODIFIED** - Wholesale replacement of entire requirement
4. **ADDED** - Introduces new capabilities

**Critical**: MODIFIED sections require the COMPLETE updated requirement block-not a diff or partial update.

### 5.4 Delta Location

Delta specs MUST be stored in the changes directory:

```
.cleo/changes/[feature-name]/specs/[domain]/[SPEC-NAME]-SPEC.md
```

### 5.5 Archive Process

When a change is merged:

1. Validate all deltas
2. Apply operations in order: RENAMED -> REMOVED -> MODIFIED -> ADDED
3. Merge deltas into `.cleo/specs/`
4. Move change folder to `.cleo/changes/archive/YYYY-MM-DD-{name}/`

---

## Part 6: Command Integration

### 6.1 Research Epic Creation

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

### 6.2 Research Command

```bash
ct research T500 [OPTIONS]
```

**Slash Command**: `/ct:research T500`

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
3. Invoke Research Agent (Python: `rcsd.agents.research.ResearchAgent`)
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

### 6.3 Consensus Command

```bash
ct consensus T500 [OPTIONS]
```

**Slash Command**: `/ct:consensus T500`

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--skip-challenge` | boolean | false | Skip Challenge Agent (NOT RECOMMENDED) |
| `--threshold` | integer | 4 | Minimum votes for PROVEN |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |

**Behavior**:

1. Validate `_research.json` exists in task directory
2. Invoke 5 Worker Agents in parallel (Python: `asyncio.gather()`)
3. Invoke Synthesis Agent to consolidate findings
4. Apply voting thresholds and evidence weighting
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

### 6.4 Spec Command

```bash
ct spec T500 [OPTIONS]
```

**Slash Command**: `/ct:spec T500`

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--template` | string | `default` | Spec template to use |
| `--output` | path | auto | Custom output path |
| `--delta` | boolean | true | Generate delta file |
| `--domain` | string | auto | Target domain folder |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |
| `--eager-execution` | boolean | false | Start before consensus finalizes |

**Behavior**:

1. Validate `_consensus-report.json` exists
2. Validate consensus verdict is `PROVEN` or `CONTESTED` (with HITL resolution)
3. Invoke Spec Agent to generate specification
4. Validate output against RFC 2119 patterns
5. Write `[SHORT-NAME]-SPEC.md` to task directory
6. Write delta to `.cleo/changes/[feature]/specs/[domain]/`
7. Write `[SHORT-NAME]-IMPLEMENTATION-REPORT.md` scaffold
8. Update `_manifest.json` state to `specified`

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Spec generated |
| 4 | `EXIT_NOT_FOUND` | Consensus report not found |
| 34 | `EXIT_SPEC_INVALID` | Generated spec fails validation |
| 33 | `EXIT_HITL_REQUIRED` | Contested claims need resolution |

### 6.5 Decompose Command

```bash
ct decompose --from-task T500 [OPTIONS]
```

**Slash Command**: `/ct:decompose T500`

**Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--from-task` | string | required | Source task ID with spec |
| `--phase` | string | `core` | Target phase for generated tasks |
| `--parent` | string | T500 | Parent for generated tasks |
| `--no-challenge` | boolean | false | Skip atomicity challenge |
| `--format` | string | auto | Output format |
| `--dry-run` | boolean | false | Preview without executing |
| `--eager-execution` | boolean | false | Start on stable spec sections |

**Behavior**:

1. Validate spec file exists in task directory
2. Parse spec for requirements and acceptance criteria
3. Invoke Decompose Agent
4. Generate atomic tasks with dependencies
5. Validate atomicity score >= 100
6. Write `_dag.json` to task directory
7. Create tasks in `todo.json` with `parentId` set to source task
8. Update source task `associations.decomposedTasks`
9. Update `_manifest.json` state to `decomposed`

**Exit Codes**:

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Decomposition completed |
| 4 | `EXIT_NOT_FOUND` | Spec file not found |
| 11 | `EXIT_DEPTH_EXCEEDED` | Would exceed hierarchy depth |
| 12 | `EXIT_SIBLING_LIMIT` | Would exceed sibling limit |
| 14 | `EXIT_CIRCULAR_REFERENCE` | DAG contains cycles |
| 35 | `EXIT_ATOMICITY_FAILED` | Tasks fail atomicity criteria |

### 6.6 Archive Command

```bash
ct archive [change-name] [OPTIONS]
```

**Slash Command**: `/ct:archive [change-name]`

**Behavior**:

1. Validate all deltas in the change folder
2. Apply delta merge algorithm
3. Update source specs in `.cleo/specs/`
4. Move change folder to `.cleo/changes/archive/YYYY-MM-DD-{name}/`
5. Log operation

---

## Part 7: Slash Commands and AI Integration

### 7.1 Slash Command Registry

RCSD provides IDE-native slash commands for discovery across 20+ AI tools:

| Command | Stage | Purpose |
|---------|-------|---------|
| `/ct:research [TASK_ID]` | 1 | Execute research stage |
| `/ct:consensus [TASK_ID]` | 2 | Execute consensus stage |
| `/ct:spec [TASK_ID]` | 3 | Generate specification |
| `/ct:decompose [TASK_ID]` | 4 | Decompose into tasks |
| `/ct:archive [CHANGE_NAME]` | - | Merge deltas to source |
| `/ct:validate [SPEC_PATH]` | - | Validate spec format |

### 7.2 Tool Configuration Paths

Native slash command support:

```
.cleo/commands/             # Claude Code
.cursor/commands/           # Cursor
.github/prompts/            # GitHub Copilot
.roo/commands/              # RooCode
.windsurf/workflows/        # Windsurf
.clinerules/workflows/      # Cline
```

### 7.3 AGENTS.md Convention

**Location**: `.cleo/AGENTS.md`

This file provides universal AI instructions that work with any AI assistant:

```markdown
# AGENTS.md - AI Instructions for [Project Name]

## Overview
This project uses the RCSD Pipeline for spec-driven development.

## Available Commands
- `/ct:research T###` - Research a topic and gather evidence
- `/ct:consensus T###` - Run multi-agent consensus validation
- `/ct:spec T###` - Generate RFC 2119 compliant specification
- `/ct:decompose T###` - Decompose spec into atomic tasks

## Directory Structure
- `.cleo/specs/` - Source of truth specifications
- `.cleo/changes/` - Proposed changes (deltas)
- `.cleo/rcsd/` - RCSD workflow artifacts

## Spec Format Requirements
1. Use RFC 2119 keywords (MUST, SHALL, SHOULD, MAY)
2. Include scenarios with WHEN/THEN format
3. Provide acceptance criteria for each requirement

## Delta Format
When modifying specs, use:
- `## ADDED Requirements` - New capabilities
- `## MODIFIED Requirements` - Updated requirements (full replacement)
- `## REMOVED Requirements` - Deprecated requirements
- `## RENAMED Requirements` - Name changes only

## Evidence Standards
- Every claim requires citation or reproducible proof
- Minimum 3 unique sources per research topic
- Source quality tiers: A (official), B (reputable), C (community), D (unverified)
```

### 7.4 PROJECT-CONTEXT.md

**Location**: `.cleo/PROJECT-CONTEXT.md`

Provides project context without reading the entire codebase:

```markdown
# Project Context

## Overview
[Brief project description]

## Tech Stack
- Framework: [e.g., SvelteKit, Next.js]
- Database: [e.g., PostgreSQL with Drizzle ORM]
- Auth: [e.g., Better-Auth]

## Architecture
[Key architectural decisions]

## Active Work
[Current focus areas]

## Conventions
[Coding standards, naming conventions]
```

---

## Part 8: Agent Deployment

### 8.1 Agent Architecture

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
|   5x Worker Agents (parallel via asyncio)                          |
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

### 8.2 Subagent Type Mappings

| Agent | `subagent_type` | Python Class | Rationale |
|-------|-----------------|--------------|-----------|
| Research Agent | `researcher` | `ResearchAgent` | Deep investigation, source synthesis |
| Technical Validator | `backend-architect` | `TechnicalValidatorAgent` | System reliability, performance |
| Design Philosophy | `frontend-architect` | `DesignPhilosophyAgent` | UX, API design, ergonomics |
| Documentation Agent | `technical-writer` | `DocumentationAgent` | Documentation clarity, accuracy |
| Implementation Agent | `refactoring-expert` | `ImplementationAgent` | Code quality, feasibility |
| Challenge Agent | `requirements-analyst` | `ChallengeAgent` | Adversarial analysis, edge cases |
| Synthesis Agent | `project-supervisor-orchestrator` | `SynthesisAgent` | Cross-domain consolidation |
| Spec Agent | `technical-writer` | `SpecAgent` | Formal specification writing |
| Decompose Agent | `requirements-analyst` | `DecomposeAgent` | Task breakdown, atomicity |

### 8.3 Evidence Standards Per Agent

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

### 8.4 Anti-Hallucination Rules

All agents MUST adhere to:

1. **No Unverified Claims**: Every assertion requires citation or reproducible proof
2. **Explicit Uncertainty**: Use "INSUFFICIENT_EVIDENCE" when data is lacking
3. **Bounded Assertions**: No claims beyond source material scope
4. **Challenge Requirement**: Challenge Agent MUST provide substantive findings (minimum 2)
5. **Source Validation**: External URLs must be verified accessible
6. **Cross-Reference Required**: Claims spanning domains require multiple agent confirmation

---

## Part 9: Explicit Iteration Paths and Feedback Loops

### 9.1 Motivation

Real systems require explicit backward transitions when validation fails or new evidence is needed.

### 9.2 Explicit Backward Transitions

The following backward transitions MUST be supported and logged:

#### 9.2.1 SPEC -> RESEARCH

**Trigger**: Spec validation failure or new sources required

**Examples**:
- Missing citations
- Contested claims unresolved
- Requirements unsupported by evidence

#### 9.2.2 DECOMPOSE -> SPEC

**Trigger**: Atomicity failure indicates requirements are too coarse

**Examples**:
- Tasks cannot be made atomic without splitting requirements
- DAG cycles due to ambiguous requirements

### 9.3 Transition Rules

- Backward transitions MUST set `_manifest.json.state` to `revision_required`
- Backward transitions MUST create a `revision` record under `_manifest.json.revisions[]`
- Backward transitions MUST NOT delete artifacts
- Backward transitions SHOULD append new artifacts with timestamp suffixes and update pointers to latest artifacts

### 9.4 Revision Source Schema

When `state` is `revision_required`, the manifest MUST include `revisionSource`:

```json
{
  "revisionSource": {
    "fromStage": "spec",
    "toStage": "research",
    "reasonCode": "E_SPEC_VALIDATION_FAILED",
    "reasonText": "Spec lacks sufficient evidence for 3 requirements.",
    "triggeredBy": "spec-validator",
    "timestamp": "2025-12-24T18:00:00Z",
    "relatedArtifacts": [
      "AUTH-SYSTEM-SPEC.md",
      "spec-validation-report.json"
    ]
  }
}
```

**Reason Codes**:

| Code | Meaning |
|------|---------|
| `E_SPEC_VALIDATION_FAILED` | Spec failed format or content validation |
| `E_ATOMICITY_FAILED` | Tasks fail atomicity criteria |
| `E_INSUFFICIENT_EVIDENCE` | Not enough evidence for claims |
| `E_HITL_REQUIRED` | Human decision needed |
| `E_CONSENSUS_CONTESTED_BLOCKING` | Contested claims block progression |

---

## Part 10: HITL Gates Formalization

### 10.1 Capture Mechanisms

Implementations MUST support at least one of:

- CLI prompt workflow
- UI workflow

Implementations SHOULD support both.

#### 10.1.1 CLI Prompt Capture

The CLI MUST:

1. Present the blocking issue
2. Present decision options
3. Capture a selected option
4. Capture optional justification text
5. Write a HITL Resolution Record artifact

#### 10.1.2 UI Capture

If UI exists, it SHOULD:

1. Display the claim, evidence summary, and competing viewpoints
2. Provide decision options with tooltips
3. Require authentication of the reviewer
4. Persist decision as a HITL Resolution Record

### 10.2 Timeout Behavior

HITL gates MUST support timeouts.

Default behavior SHOULD be:

- After timeout, set pipeline state to `revision_required`
- Emit reasonCode `E_HITL_TIMEOUT`
- Preserve partial stage outputs
- Do not advance stages

**Timeout Settings**:

| Stage | Default Timeout |
|-------|-----------------|
| consensus | 86400 seconds (24h) |
| spec | 86400 seconds (24h) |
| decompose | 43200 seconds (12h) |

**Timeout Actions**:

- `pause` - Hold state until human intervention
- `rollback_to_stage` - Return to specified stage

### 10.3 Audit Logging Requirements

Every HITL decision MUST be logged with:

- Reviewer identity
- Timestamp
- Decision option selected
- Justification text (if provided)
- Impacted claim IDs
- Resulting action taken

### 10.4 HITL Resolution Record Schema

**Location**: `.cleo/rcsd/TXXX_[short-name]/hitl/HITL-RESOLUTION-<id>.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-hitl-resolution.schema.json",
  "hitlResolutionId": "HR-001",
  "taskId": "T500",
  "shortName": "auth-system",
  "stage": "consensus",
  "trigger": {
    "reasonCode": "E_HITL_REQUIRED",
    "reasonText": "Claim CLM-004 remains contested with security implications.",
    "claimIds": ["CLM-004"],
    "recommendations": [
      {
        "type": "spec-requirement",
        "priority": "high",
        "text": "Include PKCE requirement for public clients."
      }
    ]
  },
  "decision": {
    "selectedOptionId": "OPT-2",
    "selectedOptionText": "Accept recommendation and update spec requirements.",
    "justification": "Align with security best practices.",
    "requiresFollowupStage": "spec"
  },
  "reviewer": {
    "id": "user:keaton",
    "displayName": "Keaton",
    "authProvider": "local"
  },
  "timestamps": {
    "createdAt": "2025-12-24T18:30:00Z",
    "decidedAt": "2025-12-24T18:35:00Z"
  },
  "effects": {
    "pipelineAction": "resume",
    "updates": [
      {
        "target": "_manifest.json",
        "path": "stages.consensus.hitlResolutionId",
        "value": "HR-001"
      }
    ],
    "artifactLinks": [
      "T500_auth-system_consensus-report.json",
      "AUTH-SYSTEM-SPEC.md"
    ]
  }
}
```

---

## Part 11: Evidence Weighting Model

### 11.1 Motivation

Votes alone can be misleading. Evidence quality and recency should influence verdicts.

### 11.2 Source Quality Signals

Add per-source signals in research output:

```json
{
  "sources": [
    {
      "id": "SRC-001",
      "url": "https://example.com",
      "title": "Example Documentation",
      "relevance": 0.95,
      "qualitySignals": {
        "authorityTier": "A",
        "recencyDays": 12,
        "primarySource": true,
        "peerReviewed": false,
        "officialDocs": true
      }
    }
  ]
}
```

**Authority Tiers**:

| Tier | Description |
|------|-------------|
| A | Official docs, standards bodies, primary vendor docs |
| B | Reputable engineering blogs, major industry publications |
| C | Community content, forums |
| D | Unverified or low quality sources |

### 11.3 Claim Scoring

Each claim SHOULD compute:

```json
{
  "id": "CLM-001",
  "voteScore": 0.8,
  "evidenceScore": 0.9,
  "confidenceScore": 0.85,
  "overallScore": 0.86,
  "verdict": "PROVEN",
  "weights": {
    "vote": 0.4,
    "evidence": 0.4,
    "confidence": 0.2
  }
}
```

**Formula**: `overallScore = (voteScore * 0.4) + (evidenceScore * 0.4) + (confidenceScore * 0.2)`

### 11.4 Agent Confidence Standard

Consensus workers SHOULD emit confidence per claim on a 0 to 1 scale. The synthesis agent MUST preserve these values in the consensus report.

---

## Part 12: Eager Execution Mode

### 12.1 Motivation

Strict sequential dependencies can slow throughput. Some work can start early when inputs are stable.

### 12.2 Enabling Eager Execution

Add a pipeline mode via config or CLI flag:

```bash
ct spec T500 --eager-execution
ct decompose --from-task T500 --eager-execution
```

### 12.3 Permitted Overlaps

When `eager_execution` is enabled:

#### 12.3.1 SPEC May Begin During CONSENSUS

**Constraints**:
- Spec MUST mark contested sections as provisional
- Final spec MUST NOT pass validation until contested claims are resolved or HITL decides

#### 12.3.2 DECOMPOSE May Begin on Stable Spec Sections

**Constraints**:
- Tasks generated from provisional spec sections MUST be tagged as `provisional: true`
- Provisional tasks MUST NOT be scheduled for execution unless confirmed by later spec finalization

### 12.4 Provisional Labeling

Generated artifacts MUST support provisional markers:

**Spec**:
```markdown
> PROVISIONAL: This requirement is pending consensus resolution.

### Requirement: Two-Factor Authentication
...
```

**Tasks**:
```json
{
  "id": "T501",
  "provisional": true,
  "provisionReason": "Pending consensus on CLM-004"
}
```

**DAG**:
- Mark edges originating from provisional nodes

---

## Part 13: Structural Validation

### 13.1 RFC 2119 Detection

Specs MUST be validated for proper RFC 2119 keyword usage:

```python
import re

RFC_2119_PATTERN = re.compile(
    r'\b(MUST|MUST NOT|SHALL|SHALL NOT|SHOULD|SHOULD NOT|REQUIRED|RECOMMENDED|MAY|OPTIONAL)\b'
)

def validate_requirement(text: str) -> bool:
    """Validate each requirement contains RFC 2119 keywords."""
    return bool(RFC_2119_PATTERN.search(text))
```

### 13.2 Scenario Format Validation

Scenarios MUST follow WHEN/THEN format:

```python
SCENARIO_PATTERN = re.compile(r'^####\s+Scenario:\s+.+$', re.MULTILINE)
WHEN_PATTERN = re.compile(r'^\s*-\s+WHEN\s+.+$', re.MULTILINE)
THEN_PATTERN = re.compile(r'^\s*-\s+THEN\s+.+$', re.MULTILINE)
```

### 13.3 Duplicate Detection

Requirement names MUST be unique within a spec:

```python
def detect_duplicates(requirements: list) -> dict:
    """Detect duplicate requirement names."""
    names = set()
    for req in requirements:
        normalized = req['name'].strip()
        if normalized in names:
            return {"error": f"Duplicate requirement: {normalized}"}
        names.add(normalized)
    return {"valid": True}
```

---

## Part 14: Metrics and Observability

### 14.1 Required Metrics

Implementations SHOULD track:

1. **Stage latency tracking**
   - startedAt
   - completedAt
   - durationMs

2. **Agent confidence scores**
   - Per claim confidence
   - Per agent overall confidence

3. **Research source quality signals**
   - authorityTier distribution
   - Average recencyDays
   - Primary source ratio

### 14.2 Metrics Artifact

**Location**: `.cleo/rcsd/TXXX_[short-name]/metrics/RCSD-METRICS.json`

```json
{
  "taskId": "T500",
  "shortName": "auth-system",
  "runId": "RUN-2025-12-24T18-00-00Z",
  "stageMetrics": {
    "research": {
      "durationMs": 360000,
      "sourceCount": 10,
      "attempts": 1
    },
    "consensus": {
      "durationMs": 600000,
      "claimCount": 14,
      "hitlTriggered": false
    },
    "spec": {
      "durationMs": 240000,
      "requirementCount": 28,
      "rfc2119Keywords": 45
    },
    "decompose": {
      "durationMs": 180000,
      "taskCount": 9,
      "cycleDetected": false,
      "atomicityScore": 108
    }
  },
  "qualityMetrics": {
    "avgAgentConfidence": 0.84,
    "lowestClaimConfidence": 0.62,
    "sourceAuthorityMix": { "A": 6, "B": 3, "C": 1, "D": 0 },
    "avgSourceRecencyDays": 45
  },
  "costMetrics": {
    "totalTokens": 45000,
    "estimatedCostUSD": 0.45
  }
}
```

---

## Part 15: Schema Definitions

### 15.1 Task Schema Additions

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
  "provisional": {
    "type": "boolean",
    "default": false,
    "description": "Task generated from provisional spec section"
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

### 15.2 RCSD-INDEX.json Schema

**Location**: `.cleo/rcsd/RCSD-INDEX.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-index.schema.json",
  "version": "2.0.0",
  "lastUpdated": "2025-12-24T10:00:00Z",
  "workflows": [
    {
      "taskId": "T500",
      "shortName": "auth-system",
      "directory": ".cleo/rcsd/T500_auth-system/",
      "state": "decomposed",
      "stages": {
        "research": {
          "completedAt": "2025-12-24T10:05:00Z",
          "sourceCount": 8,
          "attempts": 1
        },
        "consensus": {
          "completedAt": "2025-12-24T10:15:00Z",
          "verdict": "PROVEN",
          "voteCount": { "proven": 4, "refuted": 0, "contested": 1 }
        },
        "spec": {
          "completedAt": "2025-12-24T10:20:00Z",
          "specFile": "AUTH-SYSTEM-SPEC.md",
          "deltaFile": ".cleo/changes/auth-oauth/specs/auth/AUTH-SYSTEM-SPEC.md"
        },
        "decompose": {
          "completedAt": "2025-12-24T10:25:00Z",
          "taskCount": 7,
          "taskIds": ["T501", "T502", "T503", "T504", "T505", "T506", "T507"]
        }
      },
      "createdAt": "2025-12-24T10:00:00Z"
    }
  ],
  "statistics": {
    "totalWorkflows": 1,
    "byState": {
      "created": 0,
      "researched": 0,
      "validated": 0,
      "specified": 0,
      "decomposed": 1,
      "revision_required": 0
    }
  }
}
```

### 15.3 Manifest Schema (_manifest.json)

**Location**: `.cleo/rcsd/TXXX_[short-name]/_manifest.json`

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-manifest.schema.json",
  "taskId": "T500",
  "shortName": "auth-system",
  "title": "Research: OAuth Authentication Flow",
  "state": "decomposed",
  "createdAt": "2025-12-24T10:00:00Z",
  "updatedAt": "2025-12-24T10:25:00Z",
  "determinism": {
    "mode": "semantic",
    "seed": null,
    "temperature": 0.2,
    "model": "claude-sonnet-4-20250514",
    "toolingFrozen": false
  },
  "stages": {
    "research": {
      "state": "completed",
      "attempts": [
        {
          "attemptId": "ATT-001",
          "startedAt": "2025-12-24T10:00:00Z",
          "completedAt": "2025-12-24T10:05:00Z",
          "inputs": {
            "topic": "OAuth Authentication Flow",
            "sources": ["urls", "context7"],
            "depth": "deep"
          },
          "outputs": ["T500_auth-system_research.json"],
          "result": "success"
        }
      ],
      "agent": "researcher",
      "outputs": ["T500_auth-system_research.json"],
      "sourceCount": 8,
      "checksum": "sha256:abc123..."
    },
    "consensus": {
      "state": "completed",
      "startedAt": "2025-12-24T10:05:00Z",
      "completedAt": "2025-12-24T10:15:00Z",
      "agents": ["technical-validator", "design-philosophy", "docs", "impl", "challenge", "synthesis"],
      "outputs": ["T500_auth-system_consensus-report.json", "T500_auth-system_voting-matrix.json"],
      "verdict": "PROVEN",
      "votingMatrix": { "proven": 4, "refuted": 0, "contested": 1 },
      "hitl": {
        "required": false,
        "hitlResolutionId": null,
        "status": null
      },
      "checksum": "sha256:def456..."
    },
    "spec": {
      "state": "completed",
      "startedAt": "2025-12-24T10:15:00Z",
      "completedAt": "2025-12-24T10:20:00Z",
      "agent": "spec-writer",
      "outputs": ["AUTH-SYSTEM-SPEC.md", "AUTH-SYSTEM-IMPLEMENTATION-REPORT.md"],
      "deltaFile": ".cleo/changes/auth-oauth/specs/auth/AUTH-SYSTEM-SPEC.md",
      "requirementCount": 23,
      "checksum": "sha256:ghi789..."
    },
    "decompose": {
      "state": "completed",
      "startedAt": "2025-12-24T10:20:00Z",
      "completedAt": "2025-12-24T10:25:00Z",
      "agent": "decomposer",
      "outputs": ["T500_auth-system_dag.json"],
      "taskCount": 7,
      "taskIds": ["T501", "T502", "T503", "T504", "T505", "T506", "T507"],
      "atomicityScore": 108,
      "checksum": "sha256:jkl012..."
    }
  },
  "revisions": [],
  "history": [
    {
      "timestamp": "2025-12-24T10:00:00Z",
      "event": "created",
      "details": { "source": "ct add" }
    },
    {
      "timestamp": "2025-12-24T10:05:00Z",
      "event": "stage_completed",
      "details": { "stage": "research" }
    }
  ]
}
```

### 15.4 Research Output Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-research.schema.json",
  "_meta": {
    "stage": "research",
    "version": "2.0.0",
    "timestamp": "2025-12-24T10:05:00Z",
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
      "extractedAt": "2025-12-24T10:01:00Z",
      "qualitySignals": {
        "authorityTier": "A",
        "recencyDays": 12,
        "primarySource": true,
        "peerReviewed": false,
        "officialDocs": true
      }
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

### 15.5 Consensus Report Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd-consensus.schema.json",
  "_meta": {
    "stage": "consensus",
    "version": "2.0.0",
    "timestamp": "2025-12-24T10:15:00Z",
    "taskId": "T500"
  },
  "methodology": {
    "agentCount": 6,
    "evidenceStandards": "per RCSD-PIPELINE-SPEC Part 8.3",
    "votingThreshold": 4,
    "scoringWeights": {
      "vote": 0.4,
      "evidence": 0.4,
      "confidence": 0.2
    }
  },
  "claims": [
    {
      "id": "CLM-001",
      "statement": "Authorization code flow is most secure for server-side apps",
      "sourceFindings": ["FND-001", "FND-003"],
      "votes": {
        "technicalValidator": { "vote": "proven", "confidence": 0.92 },
        "designPhilosophy": { "vote": "proven", "confidence": 0.88 },
        "documentationAgent": { "vote": "proven", "confidence": 0.90 },
        "implementationAgent": { "vote": "proven", "confidence": 0.85 },
        "challengeAgent": { "vote": "contested", "confidence": 0.78 }
      },
      "voteScore": 0.8,
      "evidenceScore": 0.9,
      "confidenceScore": 0.87,
      "overallScore": 0.86,
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

### 15.6 Spec Frontmatter Schema

Specifications generated by the SPEC stage MUST include frontmatter:

```markdown
# [Topic] Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-24
**Last Updated**: 2025-12-24
**RCSD Source**: T500
**RCSD Directory**: .cleo/rcsd/T500_auth-system/
**Implementation Report**: [Topic]-IMPLEMENTATION-REPORT.md

---

## RFC 2119 Conformance

[Standard boilerplate]

---
```

---

## Part 16: Error Codes

### 16.1 Pipeline Exit Codes (30-39)

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

### 16.2 Error Code Strings

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

### 16.3 Error Recovery Protocols

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
| `E_HITL_TIMEOUT` | Resume when human available or lower timeout |

---

## Part 17: Conformance

### 17.1 Conformance Classes

A conforming implementation MUST:

- Implement all 4 pipeline stages (RESEARCH, CONSENSUS, SPEC, DECOMPOSE)
- Create task-anchored directories per Part 4.2
- Maintain RCSD-INDEX.json per Part 15.2
- Deploy agents with specified subagent_types per Part 8.2
- Apply evidence standards per Part 8.3
- Support all exit codes defined in Part 16.1
- Support backward transitions per Part 9
- Implement HITL capture mechanism per Part 10
- Generate valid RFC 2119 specs per Part 13

A conforming implementation SHOULD:

- Implement delta format per Part 5
- Support eager execution mode per Part 12
- Track metrics per Part 14
- Provide AGENTS.md template per Part 7.3
- Support slash commands per Part 7.1
- Meet latency targets for production use

A conforming implementation MAY:

- Use alternative agent subagent_types with documented rationale
- Extend manifest schema with additional metadata
- Add custom stages between SPEC and DECOMPOSE
- Support additional AI tools beyond the listed 20+

---

## Part 18: Related Specifications

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

# Archive merged changes
ct archive add-oauth-flow

# Validate spec format
ct validate .cleo/specs/auth/AUTH-SYSTEM-SPEC.md
```

### Slash Commands

```
/ct:research T500
/ct:consensus T500
/ct:spec T500
/ct:decompose T500
/ct:archive add-oauth-flow
/ct:validate AUTH-SYSTEM-SPEC.md
```

### Directory Structure

```
.cleo/
├── rcsd/
│   ├── RCSD-INDEX.json
│   └── T500_auth-system/
│       ├── _manifest.json
│       ├── T500_auth-system_research.json
│       ├── T500_auth-system_consensus-report.json
│       ├── AUTH-SYSTEM-SPEC.md
│       ├── AUTH-SYSTEM-IMPLEMENTATION-REPORT.md
│       ├── T500_auth-system_dag.json
│       ├── hitl/
│       └── metrics/
├── specs/                    # Source of truth
│   └── auth/
│       └── AUTH-SYSTEM-SPEC.md
├── changes/                  # Proposals
│   └── add-oauth-flow/
│       ├── proposal.md
│       ├── tasks.md
│       └── specs/auth/
│           └── AUTH-SYSTEM-SPEC.md  # DELTA
├── AGENTS.md
└── PROJECT-CONTEXT.md
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

Revision loops:
  specified --> revision_required --> researched
  decomposed --> revision_required --> specified
```

### Delta Format Quick Reference

```markdown
# Delta for [SPEC-NAME]

## ADDED Requirements
### Requirement: [Name]
The system MUST [action].

## MODIFIED Requirements
### Requirement: [Name]
[Complete replacement text]

## REMOVED Requirements
### Requirement: [Name]
[Optional rationale]

## RENAMED Requirements
### Requirement: [New Name] (from: [Old Name])
```

---

## Appendix B: Atomicity Criteria

Tasks are scored on 6 criteria (each 0-20 points, minimum total 100):

| Criterion | Description | Max Score |
|-----------|-------------|-----------|
| Single Responsibility | One clear outcome | 20 |
| Testable | Verifiable completion | 20 |
| Time-Bounded | Estimable duration | 20 |
| No Hidden Dependencies | All deps explicit in DAG | 20 |
| Reversible | Can be undone/rolled back | 10 |
| Documentable | Clear, concise description | 10 |

**Minimum Score**: 100 (out of 100)

---

## Appendix C: Version History

### Version 2.0.0 (2025-12-29)

- **Python Implementation**: Agent orchestration via Anthropic Agent SDK
- Incorporated all v1.1 features:
  - Feedback loops and revision_required state
  - HITL gate formalization with timeouts
  - Evidence weighting model
  - Semantic equivalence idempotency
  - Eager execution mode
  - Delta format for spec evolution
  - AGENTS.md and PROJECT-CONTEXT.md templates
  - Slash command integration
  - Structural validation
  - Metrics and observability
- Updated directory structure for three-folder architecture
- Added 6-point atomicity scoring criteria
- Enhanced manifest schema with attempts, revisions, determinism blocks

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
