# Multi-Phase Consensus Research Framework

**Version**: 2.0.0
**Status**: ACTIVE
**Created**: 2025-12-14
**Last Updated**: 2025-12-19
**Implementation Report**: [CONSENSUS-FRAMEWORK-IMPLEMENTATION-REPORT.md](CONSENSUS-FRAMEWORK-IMPLEMENTATION-REPORT.md)

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines a multi-agent consensus framework for rigorous validation of contested claims through evidence-based analysis, adversarial challenge, and consensus protocols. The framework is designed for investigating technical claims about systems, validating feature requests, and resolving design disputes.

### 1.2 Authority

This specification is AUTHORITATIVE for:
- Multi-agent consensus methodology
- Evidence-based claim validation protocol
- Agent role definitions
- Voting thresholds and consensus rules
- HITL gate protocol
- Question collection and severity definitions

This specification DEFERS to:
- SPEC-BIBLE-GUIDELINES.md for document structure
- LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md for task ID format
- LLM-AGENT-FIRST-SPEC.md for agent behavior standards

---

## Part 2: RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 3: Executive Summary

This framework employs 5 specialist agents across 4 phases to rigorously validate contested claims through evidence-based analysis, adversarial challenge rounds, and consensus protocols.

**Architecture**: 1 Task Orchestrator + 5 Worker Agents + 1 Synthesis Agent = 7 total agents

**Phases**:
1. Evidence Collection (orchestrator solo)
2. Specialist Analysis (5 parallel worker agents)
3. Challenge & Consensus (synthesis agent + consensus voting)
4. Artifact Generation (synthesis agent continues)

---

## Part 4: Agent Architecture

### 4.1 Block Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│  TASK ORCHESTRATOR (spawns agents, monitors progress, no synthesis) │
│                                                                     │
│  5 Worker Agents (parallel)                                        │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│  │ Technical │ │  Design   │ │   Docs    │ │   Impl    │ │ Challenge │
│  │ Validator │ │Philosophy │ │   Agent   │ │   Agent   │ │ (Red Team)│
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
│        │             │             │             │             │
│        └─────────────┴──────┬──────┴─────────────┴─────────────┘
│                             ▼
│  ┌─────────────────────────────────────────────────────────────┐
│  │  SYNTHESIS AGENT (Consolidation Orchestrator)               │
│  │  - Reads all 5 worker outputs                               │
│  │  - Synthesizes findings into unified analysis               │
│  │  - Flags conflicts and unresolved questions                 │
│  │  - Writes consolidated output artifacts                     │
│  │  - Generates consensus report with voting tallies           │
│  └─────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Role Separation

| Role | SHALL Do | MUST NOT Do |
|------|----------|-------------|
| **Task Orchestrator** | Spawn agents, pass context, monitor progress | Perform analysis or synthesis |
| **Worker Agents (5)** | Domain-specific investigation | Cross-domain synthesis |
| **Synthesis Agent** | Consolidate findings, flag conflicts, write artifacts | Conduct original investigation |

### 4.3 Agent Flow

```
Phase 1: Task Orchestrator gathers evidence (solo)
    ↓
Phase 2: Task Orchestrator spawns 5 Worker Agents (parallel)
    ↓
Phase 3: Synthesis Agent reads worker outputs, facilitates consensus
    ↓
Phase 4: Synthesis Agent generates final artifacts
```

### 4.4 Agent Execution Requirements

1. Task Orchestrator SHALL launch subagents via Task tool
2. Task Orchestrator MUST NOT read subagent output files directly
3. Synthesis Agent MUST review all worker outputs before synthesis
4. Task Orchestrator SHALL read only final consolidated output from Synthesis Agent
5. This pattern protects Task Orchestrator context window
6. This pattern allows session to remain open longer

**Agent Count Per Phase**:
| Phase | Agent Type | Count | Cumulative |
|-------|------------|-------|------------|
| Phase 1 | Task Orchestrator (solo) | 1 | 1 |
| Phase 2 | Worker Agents | 5 | 6 |
| Phase 3 | Synthesis Agent | 1 | 7 |
| Phase 4 | Synthesis Agent (continues) | 0 | 7 |

**Total Agents**: 7 (1 orchestrator + 5 workers + 1 synthesis)

---

## Part 5: Agent Roles

### 5.1 Technical Validation Agent

**Expertise**: Bash scripting, jq, JSON processing, performance analysis

**Responsibilities**:
- Technical bug claims investigation
- Scaling projections with data models
- Overhead calculations

**Evidence Standard**: Reproducible tests (3/3 runs) OR code analysis with file:line citations

### 5.2 Design Philosophy Agent

**Expertise**: UX design, cognitive load, API design, task management systems

**Responsibilities**:
- Command set analysis
- Alternative comparisons
- Feature gap identification

**Evidence Standard**: Comparative analysis with measurable advantage

### 5.3 Documentation Agent

**Expertise**: Technical writing, consistency analysis, LLM instruction design

**Responsibilities**:
- Cross-reference audits
- Anti-hallucination evaluation
- Documentation accuracy verification

**Evidence Standard**: Code contradiction proof (file:line evidence)

### 5.4 Implementation Agent

**Expertise**: Code archaeology, dependency analysis, Bash internals

**Responsibilities**:
- Feature existence verification
- Implementation gap detection

**Evidence Standard**: Code search + doc search yielding no results

### 5.5 Challenge Agent (Red Team)

**Expertise**: Critical analysis, logical fallacies, edge case discovery

**Responsibilities**:
- Attack all findings from other agents
- Identify hidden assumptions
- Propose counter-examples
- Adversarial testing of consensus

**Evidence Standard**: Logical counter-argument OR reproducing counter-example

**Role Constraint**: Challenge Agent MUST NOT perform original investigation; only critique existing findings.

### 5.6 Synthesis Agent (Consolidation Orchestrator)

**Expertise**: Cross-domain synthesis, conflict resolution, technical writing

**Inputs**: All 5 worker agent outputs

**Outputs**:
- Unified findings document
- Conflict flags with resolution recommendations
- Consensus voting matrix (per-claim, per-agent)
- Final verdict per claim (PROVEN/REFUTED/CONTESTED/INSUFFICIENT_EVIDENCE)

**Evidence Standard**: MUST cite specific worker agent findings; MUST NOT conduct original investigation

**Bias Prevention**: MUST have fresh agent context with no prior involvement in Phase 1-2

---

## Part 6: Consensus Protocol

### 6.1 Voting Thresholds

| Verdict | Threshold | Evidence Requirement |
|---------|-----------|---------------------|
| **PROVEN** | 4/5 agents agree | Reproducible evidence MUST exist |
| **REFUTED** | Counter-evidence invalidates claim OR ≤2/5 agree | Counter-evidence OR minority consensus |
| **CONTESTED** | 3/5 split after 2 challenge rounds | Document both sides with evidence |
| **INSUFFICIENT_EVIDENCE** | Cannot reach verdict with available data | Request additional investigation |

### 6.2 Evidence Standards by Claim Type

| Claim Type | Required Evidence | Acceptance Criteria |
|------------|-------------------|---------------------|
| Technical Bug | Reproducible test case | Same result in 3/3 runs |
| Scaling Projection | Growth model with data | R² > 0.9 OR bounded analysis |
| Feature Missing | Code + doc search | No implementation found |
| Doc Inaccuracy | Code contradiction | Code does X, doc claims Y (file:line proof) |
| Design Flaw | Comparative analysis | Alternative has measurable advantage |

### 6.3 Evidence Weighting

Evidence SHALL be weighted according to the following hierarchy:

1. **Code behavior > Documentation** (implementation truth wins)
2. **Reproducible test > Theoretical analysis** (empiricism over speculation)
3. **Multiple sources > Single source** (corroboration required)

### 6.4 Anti-Consensus Protocol

When agents agree unanimously within fewer than 2 exchanges:

1. Synthesis Agent MUST flag as `SUSPICIOUS_CONSENSUS`
2. Synthesis Agent MUST provide explicit evidence justifying why agreement is valid
3. If evidence is insufficient, Synthesis Agent MUST escalate to HITL
4. Synthesis Agent MUST document reasoning, not just conclusion

**Rationale**: Easy agreement is suspicious. Hard-won consensus is valuable. Frameworks SHOULD fight for consensus, not accept agreement by default.

### 6.5 External Validation Requirements

For PROVEN verdicts on critical claims, implementations SHOULD include:
1. At least one external validation source (human expert, different LLM, empirical test)
2. Reproducible test script (not just agent assertion)
3. Challenge Agent MUST provide substantive attack (not pro forma acceptance)

---

## Part 7: Question Collection Protocol

### 7.1 Question Format

Questions MUST be collected in structured YAML format:

```yaml
questions:
  - id: Q-P{phase}-{sequence}
    phase: {1-4}
    domain: {technical|design|documentation|implementation|scope}
    severity: {blocking|important|nice-to-have}
    question: "{question text}"
    context: |
      {background information}
    options:
      - option: "{option description}"
        pros: ["{advantage 1}", "{advantage 2}"]
        cons: ["{disadvantage 1}", "{disadvantage 2}"]
        advocate: "{agent role}"
    arbiter_recommendation: {null|recommendation text}
    documents: ["{file:line references}"]
    status: {pending|resolved|escalated}
    resolution: {null|resolution text}
```

### 7.2 Severity Definitions

| Severity | Definition | Action |
|----------|------------|--------|
| `blocking` | Cannot proceed without resolution | Immediate HITL gate |
| `important` | SHOULD resolve, MAY assume for now | Batch for HITL gate |
| `nice-to-have` | Defer without impact | Collect, decide later |

### 7.3 Domain Categories

| Category | Scope |
|----------|-------|
| `technical` | Bugs, performance, scaling |
| `design` | UX, command structure, metaphor |
| `documentation` | Accuracy, completeness, clarity |
| `implementation` | Missing features, code gaps |
| `scope` | What's in/out of investigation |

---

## Part 8: Output Artifacts

### 8.1 Consensus Report

Synthesis Agent MUST produce a Consensus Report containing:

```markdown
# Consensus Report

## Methodology
{Framework used, agents deployed, evidence standards}

## Proven Claims
### {Claim Title}
- Evidence: {citations}
- Consensus: X/5 agents
- Recommendation: {action item}

## Refuted Claims
### {Claim Title}
- Counter-evidence: {why false}
- Correction: {accurate statement}

## Contested Claims
### {Claim Title}
- Position A: {arguments}
- Position B: {counter-arguments}
- Next Steps: {investigation needed}

## Insufficient Evidence
### {Claim Title}
- Current Evidence: {what exists}
- Missing: {what's needed}
- Recommendation: {additional investigation or defer}
```

### 8.2 Feature Specifications (for PROVEN gaps)

For claims proven to identify missing features, Synthesis Agent SHOULD produce:

```markdown
# Feature: {Name}

## Justification
{Evidence from consensus}

## Command Syntax
{Proposed syntax}

## Behavior
{Expected behavior description}

## Acceptance Criteria
{Testable conditions}
```

### 8.3 Documentation Corrections

For claims proven to identify documentation errors, Synthesis Agent SHOULD produce:

```diff
# {File Name}

- Original text
+ Corrected text

Rationale: {why change needed}
```

### 8.4 Evidence Dossiers (per-claim)

For each claim investigated, Synthesis Agent MAY produce:

```markdown
# Evidence: {Claim}

## Claim Statement
{Original claim}

## Investigation Method
{How investigated}

## Test Results
{Commands run, outputs}

## Verdict
{PROVEN/REFUTED/CONTESTED/INSUFFICIENT_EVIDENCE}

## Recommendation
{Action to take}
```

---

## Part 9: Failure Modes & Mitigations

| Failure Mode | Risk | Mitigation |
|--------------|------|------------|
| Agent Bias | Agents become invested in hypothesis | Challenge Agent veto, MUST require 2+ sources |
| Scope Creep | Investigation expands beyond claims | Strict claim freeze after Phase 1 |
| Context Exhaustion | Orchestrator hits token limit | Phase handoffs, external evidence storage |
| Consensus Deadlock | 3/5 split persists | Time-box challenges, user escalation (HITL) |
| Doc-Code Contradiction | Docs claim X, code does Y | Code wins (implementation truth principle) |
| Cascading Failure | False premise propagates through agents | Challenge Agent MUST verify cross-dependencies |
| Evidence Fabrication | Agent claims untested results | Require reproducible scripts, third-party verification RECOMMENDED |

---

## Part 10: HITL Gate Protocol

### 10.1 Gate Trigger Conditions

Synthesis Agent MUST initiate Human-In-The-Loop gates when:

| Condition | Gate Required | Action |
|-----------|---------------|--------|
| All claims unanimous (5/5 or 0/5) | No | Proceed automatically |
| Any claim contested (3/5 split) | Yes | Present conflict, request user decision |
| Critical claim refuted (contradicts user belief) | Yes | Escalate with evidence |
| Insufficient evidence for verdict | Yes | Request additional investigation |
| Agent outputs contain contradictions | Yes | Flag and request resolution |
| Suspicious consensus flagged | Yes | Require evidence justification |

### 10.2 Gate Request Format

HITL gate requests MUST follow this structure:

```markdown
## HITL Gate {N} Required

### When
{Phase and trigger condition}

### Input Documents
- {List of files to review}

### Decision Points
1. {Question 1}
2. {Question 2}
3. {Question 3}

### Options
| Option | Implications |
|--------|--------------|
| A | {What happens if chosen} |
| B | {What happens if chosen} |
| Investigate further | {Additional work needed} |

### Synthesis Agent Recommendation
{Recommended path with rationale}

### Response Needed By
{blocking|time estimate}
```

---

## Part 11: Subagent Type Mappings

| Worker Agent | `subagent_type` | Rationale |
|--------------|-----------------|-----------|
| Technical Validator | `backend-architect` | System reliability, performance, fault tolerance |
| Design Philosophy | `frontend-architect` | UX, accessibility, user experience focus |
| Documentation | `technical-writer` | Documentation clarity, audience targeting |
| Implementation | `refactoring-expert` | Code quality, technical debt, clean code |
| Challenge (Red Team) | `requirements-analyst` | Systematic discovery, ambiguity detection, edge cases |
| Synthesis Agent | `project-supervisor-orchestrator` | Workflow coordination, intelligent routing, validation |

---

## Part 12: Output Handoff Convention

### 12.1 Standardized Paths

All worker agents MUST write findings to standardized paths:

```
{output-dir}/
├── phase1-evidence.md           # Task Orchestrator Phase 1 output
├── agent-technical-findings.md  # Technical Validator output
├── agent-design-findings.md     # Design Philosophy output
├── agent-docs-findings.md       # Documentation Agent output
├── agent-impl-findings.md       # Implementation Agent output
├── agent-challenge-findings.md  # Challenge Agent output
├── synthesis-conflicts.md       # Synthesis Agent conflict flags
├── synthesis-voting-matrix.md   # Per-claim, per-agent votes
└── CONSENSUS-REPORT.md          # Final consolidated output
```

### 12.2 Evidence Passing: Phase 1 → Phase 2

Task Orchestrator MUST include in each worker agent prompt:
1. Inline evidence summary (key findings relevant to agent's domain)
2. File references (paths to full evidence documents)
3. Claim assignments (which claims this agent owns)

### 12.3 Evidence Passing: Phase 2 → Phase 3

Synthesis Agent MUST receive:
1. Paths to all 5 worker finding files
2. Original claim list
3. Evidence standards from this specification

---

## Part 13: Completion Criteria

### 13.1 Phase 1 Complete When

- Phase 1 evidence document exists
- All evidence collection subtasks documented
- No ambiguities in evidence baseline

### 13.2 Phase 2 Complete When

- All 5 worker agent findings documents exist
- Each claim addressed by at least one agent
- Challenge Agent has reviewed all other agent findings

### 13.3 Phase 3 Complete When

- Voting matrix shows all votes
- All HITL gates resolved
- No unaddressed conflicts

### 13.4 Phase 4 Complete When

Consensus Report contains:
- Verdict for each claim (PROVEN/REFUTED/CONTESTED/INSUFFICIENT_EVIDENCE)
- Evidence citations
- Recommendations
- No ambiguities

---

## Part 14: Framework Limitations

This framework has known limitations that users MUST understand:

1. **Agent Consensus Is Not Proof**: All agents share the same LLM training, biases, and knowledge gaps. 5/5 consensus can still be wrong. External validation is RECOMMENDED for critical decisions.

2. **Self-Validation Is Circular**: This framework cannot fully validate itself. Meta-validation REQUIRES external review.

3. **Challenge Agent May Be Compromised**: LLM helpfulness training may undermine adversarial behavior. Monitor for weak challenges; require minimum adversarial findings.

4. **Evidence Can Be Misinterpreted**: File:line citations do not guarantee correct interpretation. Cross-verification is RECOMMENDED.

5. **Static Analysis Has Limits**: Concurrency issues, race conditions, and timing-dependent bugs may not be detectable through document analysis alone. Empirical testing SHOULD supplement static analysis.

---

## Part 15: Security Considerations

Implementations of this framework MUST address:

1. **Hallucination Prevention**: Agents MUST NOT present unverified claims as evidence
2. **Evidence Integrity**: Evidence files SHOULD NOT be modified after creation
3. **Context Injection**: Agent prompts MUST NOT include unvalidated external input
4. **Code Execution**: Agents MUST NOT execute arbitrary code from investigated claims without sandboxing

Evidence files SHOULD be checksummed for integrity verification.

---

## Part 16: Conformance

### 16.1 Conformance Classes

A conforming implementation MUST:
- Deploy exactly 5 worker agents in Phase 2
- Use the Synthesis Agent for all cross-domain consolidation
- Apply Anti-Consensus Protocol for unanimous agreement in fewer than 2 exchanges
- Follow evidence standards defined in Part 6.2
- Produce output artifacts defined in Part 8

A conforming implementation MAY:
- Use alternative `subagent_type` mappings (Part 11)
- Customize severity thresholds for questions (Part 7.2)
- Extend Question Collection Protocol format (Part 7.1)
- Add additional verdict categories beyond those in Part 6.1

---

## Part 17: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification structure and standards. This spec MUST follow the guidelines defined there. |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **Related**: Shares agent-first philosophy. Agents deployed by this framework SHOULD follow LLM-Agent-First design principles. |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **Defers to** for task ID format. Task IDs used in implementation MUST follow the ID contract defined there. |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **Related**: Framework defines internal phases (Phase 1-4) that parallel cleo's phase system. |
| **[RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md)** | **Used By**: RCSD consensus stage (Part 3) deploys this framework for multi-agent validation. |
| **[CONSENSUS-FRAMEWORK-IMPLEMENTATION-REPORT.md](CONSENSUS-FRAMEWORK-IMPLEMENTATION-REPORT.md)** | Tracks implementation status for this specification. |

---

## Appendix A: Changelog

### Version 2.0.0 (2025-12-19)
- **BREAKING**: Removed all task tracking (T184-T214) to Implementation Report
- **BREAKING**: Removed all bash command examples to Implementation Report
- **BREAKING**: Changed Status from "Design Complete | Tasks Logged" to "ACTIVE"
- Added RFC 2119 Conformance section (Part 2)
- Added Related Specifications section (Part 17)
- Added Preamble section (Part 1)
- Added Framework Limitations section (Part 14)
- Added Security Considerations section (Part 15)
- Added Conformance section (Part 16)
- Added INSUFFICIENT_EVIDENCE verdict category
- Converted informal requirements to RFC 2119 keywords
- Added Part numbering for precise cross-references
- Formalized all MUST/SHALL/SHOULD/MAY requirements
- Reduced specification from 935 lines to 562 lines (40% reduction)

### Version 1.3.0 (2025-12-14)
- Added Round-Robin Protocol for complex investigations
- Added extended risk mitigation table
- Added future plugin design section

### Version 1.2.0 (2025-12-14)
- Added per-phase agent count table
- Clarified agent execution model

### Version 1.1.0 (2025-12-14)
- Added Question Collection Protocol
- Defined HITL gate trigger conditions

### Version 1.0.0 (2025-12-14)
- Initial specification
- 7-agent, 4-phase model
- Consensus voting thresholds
- Evidence standards

---

*End of Specification*
