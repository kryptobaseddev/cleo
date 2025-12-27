# RCSD-PIPELINE-SPEC Implementation Report

**Purpose**: Track implementation progress against RCSD-PIPELINE-SPEC
**Related Spec**: [RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md)
**Last Updated**: 2025-12-23

---

## Summary

| Metric | Value |
|--------|-------|
| Overall Progress | 0% |
| Components Complete | 0/12 |
| Current Phase | Planning |
| Status | NOT STARTED |

---

## Component Status

| Component | Status | Notes |
|-----------|--------|-------|
| RCSD directory structure | PENDING | `.cleo/rcsd/` path defined |
| RCSD-INDEX.json schema | PENDING | Schema designed |
| _manifest.json schema | PENDING | Schema designed |
| Research output schema | PENDING | Schema designed |
| Consensus report schema | PENDING | Schema designed |
| `ct research` task-aware mode | PENDING | Command integration needed |
| `ct consensus` command | PENDING | New command |
| `ct spec` command | PENDING | New command |
| `ct decompose --from-task` | PENDING | Flag addition |
| Agent prompt templates | PENDING | 9 agents defined |
| Task schema extensions | PENDING | shortName, workflow, associations |
| Phase integration | PENDING | Research->setup, Decomposed->core |

---

## Phase Tracking

### Phase 1: Foundation - PENDING

- [ ] Create `.cleo/rcsd/` directory handling
- [ ] Implement RCSD-INDEX.json read/write
- [ ] Implement _manifest.json handling
- [ ] Add shortName derivation algorithm
- [ ] Create schema validation functions

### Phase 2: Research Integration - PENDING

- [ ] Update `ct research` for task-aware mode
- [ ] Implement research output to RCSD directory
- [ ] Add research -> task linking
- [ ] Create research JSON output schema validation
- [ ] Integrate with WEB-AGGREGATION-PIPELINE-SPEC patterns

### Phase 3: Consensus Command - PENDING

- [ ] Create `scripts/consensus.sh`
- [ ] Implement Technical Validation Agent prompt
- [ ] Implement Design Philosophy Agent prompt
- [ ] Implement Documentation Agent prompt
- [ ] Implement Implementation Agent prompt
- [ ] Implement Challenge Agent (Red Team) prompt
- [ ] Implement Synthesis Agent prompt
- [ ] Create consensus report output
- [ ] Add HITL gate handling per CONSENSUS-FRAMEWORK-SPEC Part 10
- [ ] Implement voting matrix generation

### Phase 4: Spec Generation - PENDING

- [ ] Create `scripts/spec.sh`
- [ ] Implement spec generation from consensus report
- [ ] Add SPEC-BIBLE-GUIDELINES compliance validation
- [ ] Create spec frontmatter handling
- [ ] Implement RFC 2119 keyword enforcement
- [ ] Generate Related Specifications section
- [ ] Create automatic Implementation Report stub

### Phase 5: Decompose Integration - PENDING

- [ ] Add `--from-task` flag to decompose command
- [ ] Implement spec -> task DAG conversion
- [ ] Add atomicity validation per TASK-DECOMPOSITION-SPEC Part 4
- [ ] Create parent-child task relationships
- [ ] Implement phase assignment (Research->setup, Implementation->core)
- [ ] Add decomposition ID linking

---

## Schema Definitions

### RCSD-INDEX.json Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd/index.schema.json",
  "version": "1.0.0",
  "investigations": [
    {
      "id": "RCSD-YYYYMMDD-NNN",
      "shortName": "feature-name",
      "taskId": "T001",
      "status": "research|consensus|spec|decompose|complete",
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601",
      "path": "relative/path/to/investigation/"
    }
  ]
}
```

### _manifest.json Schema

```json
{
  "$schema": "https://cleo.dev/schemas/v1/rcsd/manifest.schema.json",
  "id": "RCSD-YYYYMMDD-NNN",
  "shortName": "feature-name",
  "taskId": "T001",
  "workflow": {
    "research": {
      "status": "pending|in-progress|complete",
      "output": "research-findings.md",
      "completedAt": "ISO8601"
    },
    "consensus": {
      "status": "pending|in-progress|complete",
      "agents": ["technical", "design", "docs", "impl", "challenge"],
      "report": "CONSENSUS-REPORT.md",
      "votingMatrix": "synthesis-voting-matrix.md",
      "completedAt": "ISO8601"
    },
    "spec": {
      "status": "pending|in-progress|complete",
      "output": "FEATURE-SPEC.md",
      "implementationReport": "FEATURE-SPEC-IMPLEMENTATION-REPORT.md",
      "completedAt": "ISO8601"
    },
    "decompose": {
      "status": "pending|in-progress|complete",
      "tasksCreated": ["T002", "T003", "T004"],
      "completedAt": "ISO8601"
    }
  }
}
```

---

## Agent Prompt Templates

### Required Agent Prompts (9 total)

| Agent | Prompt File | Subagent Type | Status |
|-------|-------------|---------------|--------|
| Technical Validator | `prompts/agent-technical.md` | backend-architect | PENDING |
| Design Philosophy | `prompts/agent-design.md` | frontend-architect | PENDING |
| Documentation | `prompts/agent-docs.md` | technical-writer | PENDING |
| Implementation | `prompts/agent-impl.md` | refactoring-expert | PENDING |
| Challenge (Red Team) | `prompts/agent-challenge.md` | requirements-analyst | PENDING |
| Synthesis | `prompts/agent-synthesis.md` | project-supervisor-orchestrator | PENDING |
| Spec Writer | `prompts/agent-spec-writer.md` | technical-writer | PENDING |
| Decomposition | `prompts/agent-decompose.md` | requirements-analyst | PENDING |
| HITL Formatter | `prompts/agent-hitl.md` | technical-writer | PENDING |

---

## Task Schema Extensions

### New Fields (todo.schema.json v2.5.0)

```json
{
  "shortName": {
    "type": "string",
    "pattern": "^[a-z0-9-]+$",
    "description": "URL-safe short identifier derived from title"
  },
  "workflow": {
    "type": "string",
    "enum": ["rcsd", "standard", "research-only"],
    "description": "Workflow type for this task"
  },
  "associations": {
    "type": "object",
    "properties": {
      "rcsdId": {
        "type": "string",
        "pattern": "^RCSD-\\d{8}-\\d{3}$"
      },
      "specPath": {
        "type": "string"
      },
      "researchPath": {
        "type": "string"
      }
    }
  }
}
```

---

## CLI Command Specifications

### `ct consensus` Command

```bash
Usage: cleo consensus <task-id> [OPTIONS]

Run multi-agent consensus investigation for a task.

Arguments:
  <task-id>           Task to investigate

Options:
  --agents AGENTS     Comma-separated agent list (default: all)
  --skip-challenge    Skip Challenge Agent (NOT RECOMMENDED)
  --output DIR        Output directory (default: .cleo/rcsd/{shortName}/)
  --dry-run           Preview without creating files
  -f, --format FMT    Output format (json|text|markdown)
  -h, --help          Show this help message

Exit Codes:
  0   Success - consensus reached
  30  HITL required (contested claims)
  31  Consensus rejected (insufficient evidence)
```

### `ct spec` Command

```bash
Usage: cleo spec <task-id> [OPTIONS]

Generate specification from consensus report.

Arguments:
  <task-id>           Task with completed consensus

Options:
  --consensus PATH    Path to consensus report (default: auto-detect)
  --template TMPL     Spec template (default: standard)
  --validate          Validate against SPEC-BIBLE-GUIDELINES
  --dry-run           Preview without creating files
  -f, --format FMT    Output format (json|text|markdown)
  -h, --help          Show this help message

Exit Codes:
  0   Success - spec generated
  4   Consensus report not found
  6   Validation failed (SPEC-BIBLE non-compliant)
```

### `ct decompose --from-task` Flag

```bash
Usage: cleo decompose --from-task <task-id> [OPTIONS]

Decompose from an existing task's spec.

Options:
  --from-task ID      Source task with associated spec
  --spec PATH         Override spec path
  --phase PHASE       Target phase for generated tasks
  --dry-run           Preview without creating tasks
```

---

## Superseded Tasks

The following tasks are SUPERSEDED by this implementation:

| Task ID | Title | Status | Superseded By |
|---------|-------|--------|---------------|
| T204 | Multi-Phase Consensus Research Framework Plugin | SUPERSEDED | RCSD-PIPELINE-SPEC Part 1-4 |
| T215 | Configuration Schema Design | SUPERSEDED | RCSD-PIPELINE-SPEC Part 5 |
| T216 | Parameterized Prompt Templates | SUPERSEDED | RCSD-PIPELINE-SPEC Part 4 |
| T217 | State Management Design | SUPERSEDED | _manifest.json + RCSD-INDEX.json |
| T218 | Output JSON Schemas | SUPERSEDED | RCSD schemas |
| T219 | Integration Points Specification | SUPERSEDED | RCSD-PIPELINE-SPEC Part 3 |
| T220 | Error Recovery Protocols | SUPERSEDED | RCSD-PIPELINE-SPEC Part 8 |
| T221 | Invocation Modes Specification | SUPERSEDED | RCSD-PIPELINE-SPEC Part 3 |

---

## Integration Points

### Dependency Specifications

| Spec | Required Version | Integration Point |
|------|------------------|-------------------|
| CONSENSUS-FRAMEWORK-SPEC | v2.0.0+ | Agent architecture, voting thresholds |
| TASK-DECOMPOSITION-SPEC | v1.0.0+ | Atomicity criteria, DAG construction |
| WEB-AGGREGATION-PIPELINE-SPEC | v1.0.0+ | Research stage, source handling |
| LLM-AGENT-FIRST-SPEC | v3.0.0+ | JSON output, exit codes, error handling |
| SPEC-BIBLE-GUIDELINES | v1.0.0 | Spec generation compliance |

### Phase System Integration

| RCSD Stage | Project Phase | Rationale |
|------------|---------------|-----------|
| Research | setup | Discovery and evidence gathering |
| Consensus | setup | Design validation before implementation |
| Spec | setup | Requirements finalization |
| Decompose | core | Implementation task creation |

---

## Directory Structure

```
.cleo/
└── rcsd/
    ├── RCSD-INDEX.json              # Master index of all investigations
    └── {shortName}/                 # Per-investigation directory
        ├── _manifest.json           # Investigation metadata
        ├── research/
        │   ├── research-findings.md
        │   └── sources.json
        ├── consensus/
        │   ├── agent-technical-findings.md
        │   ├── agent-design-findings.md
        │   ├── agent-docs-findings.md
        │   ├── agent-impl-findings.md
        │   ├── agent-challenge-findings.md
        │   ├── synthesis-voting-matrix.md
        │   └── CONSENSUS-REPORT.md
        └── spec/
            ├── FEATURE-SPEC.md
            └── FEATURE-SPEC-IMPLEMENTATION-REPORT.md
```

---

## Blockers

| Issue | Impact | Mitigation |
|-------|--------|------------|
| None currently | - | - |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LLM API rate limits during consensus | Medium | High | Implement backoff, sequential agent execution |
| Agent agreement without substantive challenge | High | Medium | Rubber-stamp detection per CONSENSUS-FRAMEWORK-SPEC |
| Spec generation violates SPEC-BIBLE | Medium | High | Validation step before output |
| Schema migration complexity | Low | High | Backward compatibility via optional fields |

---

## Success Criteria

### Phase 1 Complete When
- [ ] RCSD directory created on first investigation
- [ ] RCSD-INDEX.json passes schema validation
- [ ] _manifest.json created for each investigation
- [ ] shortName derivation produces valid identifiers

### Phase 2 Complete When
- [ ] `ct research --task T001` links output to RCSD directory
- [ ] Research findings stored in correct path
- [ ] Sources tracked with reliability tiers

### Phase 3 Complete When
- [ ] `ct consensus T001` spawns 5 worker agents + synthesis
- [ ] All agent findings files created
- [ ] Voting matrix generated with per-claim verdicts
- [ ] HITL gates triggered for contested claims

### Phase 4 Complete When
- [ ] `ct spec T001` generates compliant specification
- [ ] RFC 2119 keywords properly capitalized
- [ ] Implementation Report stub created
- [ ] Related Specifications section populated

### Phase 5 Complete When
- [ ] `ct decompose --from-task T001` creates atomic tasks
- [ ] Tasks linked via associations.rcsdId
- [ ] Phase assignments match RCSD stage
- [ ] Parent-child relationships respect depth limits

---

## Pending Spec Cross-References

The following specifications need updates to add RCSD pipeline cross-references:

### CONSENSUS-FRAMEWORK-SPEC.md (v2.0.0 → v2.1.0)

**Location**: Related Specifications section (Part 17)
**Change**: Added RCSD-PIPELINE-SPEC.md as "Used By"

**Status**: ✅ APPLIED (2025-12-23)

---

### WEB-AGGREGATION-PIPELINE-SPEC.md (v1.0.0 → v1.1.0)

**Location**: Related Specifications section
**Change**: Added RCSD-PIPELINE-SPEC.md as "Stage: RESEARCH"

**Status**: ✅ APPLIED (2025-12-23)

---

### TASK-DECOMPOSITION-SPEC.md (v1.0.0 → v1.1.0)

**Location**: Related Specifications section (Part 17)
**Change**: Added RCSD-PIPELINE-SPEC.md as "Stage: DECOMPOSE"

**Status**: ✅ APPLIED (2025-12-23)

---

### PHASE-SYSTEM-SPEC.md (v2.2.0 → v2.3.0)

**Location**: Related Specifications section
**Change**: Added RCSD-PIPELINE-SPEC.md with phase context (Research→setup, Decompose→core)

**Note**: Part 14 (RCSD Phase Assignment) not added - phase mapping documented in RCSD-PIPELINE-SPEC Part 7 instead.

**Status**: ✅ APPLIED (2025-12-23)

---

### LLM-AGENT-FIRST-SPEC.md (v3.1 → v3.2.0)

**Location**: Related Specifications section
**Change**: Added RCSD-PIPELINE-SPEC.md as "Uses" relationship

**Note**: Command Inventory (Part 1) and Compliance Matrix (Part 9) updates for consensus, spec, decompose commands deferred until implementation. Cross-reference link added.

**Status**: ✅ PARTIAL (2025-12-23) - Cross-reference added; command inventory update pending implementation

---

## Changelog

### 2025-12-23 - Cross-Reference Updates
- Applied cross-references to 5 related specifications:
  - CONSENSUS-FRAMEWORK-SPEC.md: Added RCSD "Used By" reference
  - WEB-AGGREGATION-PIPELINE-SPEC.md: Added RCSD "RESEARCH stage" reference
  - TASK-DECOMPOSITION-SPEC.md: Added RCSD "DECOMPOSE stage" reference
  - PHASE-SYSTEM-SPEC.md: Added RCSD phase context reference
  - LLM-AGENT-FIRST-SPEC.md: Added RCSD "Uses" reference (command inventory update pending)
- Updated SPEC-INDEX.json with RCSD-PIPELINE-SPEC and dependencies

### 2025-12-23 - Initial Report
- Created implementation report with 5 phases, 12 components
- Defined RCSD-INDEX.json and _manifest.json schemas
- Listed 9 required agent prompt templates
- Documented task schema extensions (shortName, workflow, associations)
- Specified CLI commands (consensus, spec, decompose --from-task)
- Identified 8 superseded tasks
- Documented integration points with dependent specifications

---

*End of Implementation Report*
