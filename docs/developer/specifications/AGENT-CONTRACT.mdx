# Deterministic Agent Contract Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2026-01-23
**Author**: Requirements Analyst Subagent
**Epic**: Agent Contract Design

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

This specification defines the formal contract between an orchestrator and its subagents. The core philosophy:

> "The question is not CAN agents do everything, but SHOULD they? Continuity of understanding is the real constraint. Hallucination probability correlates with scope - atomic decomposition produces deterministic outputs."

### Authority

This specification is **AUTHORITATIVE** for:

- Agent input/output contracts (what agents receive and produce)
- Provenance chain from Epic to Changelog
- Determinism criteria for agent outputs
- Anti-hallucination constraints
- Scope limits for single agent passes
- Context injection requirements
- Application to greenfield vs. brownfield scenarios

This specification **DEFERS TO**:

- [ORCHESTRATOR-PROTOCOL-SPEC.md](ORCHESTRATOR-PROTOCOL-SPEC.md) for orchestrator behavior rules
- [TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md) for atomicity criteria
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards
- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for 7-agent pipeline

### Scope

This contract governs:
1. **Agent startup** - What context agents receive before work begins
2. **Agent execution** - What agents track during execution
3. **Agent completion** - What agents produce on completion
4. **Provenance chain** - Traceability from epic to changelog
5. **Determinism** - Properties that make outputs predictable

---

## Part 1: Philosophy and Rationale

### 1.1 The Determinism Principle

Agent outputs are "deterministic" when:

1. **Same inputs yield same outputs** (modulo timestamps)
2. **Outputs are traceable** to requirements
3. **Outputs are verifiable** against acceptance criteria
4. **Scope is atomic** (single concern)

### 1.2 The Hallucination-Scope Correlation

| Scope Size | Hallucination Risk | Recommendation |
|------------|-------------------|----------------|
| Single file, single function | Low (5-10%) | Direct execution |
| Single file, multiple functions | Medium (15-25%) | Decompose to functions |
| Multiple files, single concern | Medium-High (25-40%) | Careful scope definition |
| Multiple files, multiple concerns | High (40-60%) | MUST decompose |
| Cross-module changes | Very High (60-80%) | Orchestrator coordination |
| Architectural decisions | Critical (80%+) | HITL gate required |

### 1.3 Continuity of Understanding

The true constraint is not capability but context:

- Agents can perform any individual task given sufficient context
- Context windows are finite; scope must fit
- Cross-agent handoffs lose nuance without explicit contracts
- Manifests and structured outputs preserve understanding

---

## Part 2: Agent Contract Schema

### 2.1 Agent Input Contract (Start of Work)

An agent MUST receive the following before beginning work:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/agent-contract/input.schema.json",
  "contract": {
    "version": "1.0.0",
    "agentId": "string",
    "agentType": "enum",
    "sessionId": "string",
    "epicId": "string | null"
  },
  "task": {
    "id": "TXXX",
    "title": "string",
    "description": "string",
    "acceptance": ["AC-001: Criterion 1", "AC-002: Criterion 2"],
    "files": ["path/to/file.ts"],
    "phase": "string",
    "depends": ["TYYY"],
    "parentId": "TZZZ | null"
  },
  "context": {
    "projectRoot": "string",
    "relevantFiles": ["path/to/relevant.ts"],
    "manifestSummary": {},
    "priorResearch": ["research-id-1"]
  },
  "constraints": {
    "maxFiles": 3,
    "maxLinesPerFile": 500,
    "outputFormat": "json",
    "timeoutSeconds": 300
  }
}
```

#### 2.1.1 Required Input Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contract.version` | string | MUST | Contract version for compatibility |
| `contract.agentId` | string | MUST | Unique agent identifier |
| `contract.agentType` | enum | MUST | Agent role (coder, tester, etc.) |
| `task.id` | string | MUST | CLEO task ID (`TXXX` format) |
| `task.title` | string | MUST | Task title (max 120 chars) |
| `task.description` | string | MUST | Detailed task description |
| `task.acceptance` | array | MUST | Testable acceptance criteria |
| `context.projectRoot` | string | MUST | Absolute path to project |
| `constraints.outputFormat` | string | MUST | Expected output format |

#### 2.1.2 Optional Input Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `task.files` | array | `[]` | Expected files to modify |
| `task.depends` | array | `[]` | Blocking dependencies |
| `context.relevantFiles` | array | `[]` | Files for context |
| `context.manifestSummary` | object | `{}` | Research manifest summary |
| `constraints.maxFiles` | integer | 3 | Max files to modify |
| `constraints.timeoutSeconds` | integer | 300 | Execution timeout |

### 2.2 Agent Execution Tracking

During execution, an agent MUST track:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/agent-contract/execution.schema.json",
  "execution": {
    "startedAt": "ISO-8601",
    "status": "in_progress | blocked | complete | failed",
    "filesRead": ["path/to/file.ts"],
    "filesModified": ["path/to/modified.ts"],
    "toolsUsed": [
      {"tool": "Read", "count": 5},
      {"tool": "Edit", "count": 3}
    ],
    "decisions": [
      {
        "id": "DEC-001",
        "question": "Which validation library?",
        "options": ["zod", "yup"],
        "chosen": "zod",
        "rationale": "Existing project pattern"
      }
    ],
    "blockers": []
  }
}
```

#### 2.2.1 Tracking Requirements

| Metric | Rule Level | Purpose |
|--------|------------|---------|
| Files read | MUST track | Audit trail, dependency analysis |
| Files modified | MUST track | Changeset construction |
| Tools used | SHOULD track | Performance analysis |
| Decisions made | MUST track | Provenance, reproducibility |
| Time spent | MAY track | Performance optimization |

### 2.3 Agent Output Contract (End of Work)

An agent MUST produce the following on completion:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/agent-contract/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "1.0.0",
    "agentId": "agent-xyz",
    "agentType": "coder",
    "timestamp": "ISO-8601"
  },
  "task": {
    "id": "T1234",
    "status": "complete | partial | blocked | failed",
    "completedAt": "ISO-8601 | null"
  },
  "provenance": {
    "epicId": "T1200",
    "taskId": "T1234",
    "specRequirements": ["REQ-001", "REQ-002"],
    "acceptanceCriteriaMet": ["AC-001", "AC-002"]
  },
  "changeset": {
    "id": "CS-20260123-001",
    "filesModified": [
      {
        "path": "src/auth.ts",
        "action": "modified",
        "linesAdded": 45,
        "linesRemoved": 12,
        "functions": ["validateToken", "refreshToken"]
      }
    ],
    "commits": [
      {
        "hash": "abc123",
        "message": "feat(auth): add JWT validation",
        "taskRef": "T1234"
      }
    ]
  },
  "verification": {
    "testsRun": true,
    "testsPassed": true,
    "coveragePercent": 87.5,
    "lintPassed": true
  },
  "handoff": {
    "nextAgent": "testing | qa | null",
    "context": "Implementation complete, ready for testing",
    "needsFollowup": ["T1235"]
  }
}
```

#### 2.3.1 Required Output Fields

| Field | Rule Level | Description |
|-------|------------|-------------|
| `_meta.*` | MUST | Standard metadata envelope |
| `task.id` | MUST | Task identifier |
| `task.status` | MUST | Final task status |
| `provenance.epicId` | SHOULD | Parent epic reference |
| `provenance.taskId` | MUST | Task reference |
| `changeset.filesModified` | MUST | Files changed during execution |
| `handoff.nextAgent` | SHOULD | Next agent in pipeline (null if final) |

---

## Part 3: Provenance Chain Definition

### 3.1 Complete Provenance Chain

```
Epic (T1200)
    |
    +--> Task (T1234)
              |
              +--> Code (JSDoc: @task T1234, @epic T1200)
                        |
                        +--> Commit (feat(core-T1234): description)
                                    |
                                    +--> Changeset (CS-20260123-001)
                                                  |
                                                  +--> Changelog Entry
```

### 3.2 Transition Data Requirements

#### 3.2.1 Epic to Task

| Data Element | Location | Format | Example |
|--------------|----------|--------|---------|
| Epic ID | task.parentId | `TXXX` | `T1200` |
| Epic Title | task notes | string | "Authentication Epic" |
| Phase | task.phase | string | `core` |
| Priority | task.priority | enum | `high` |

#### 3.2.2 Task to Code (JSDoc Provenance)

Every code change MUST include JSDoc provenance:

```typescript
/**
 * Validates JWT token and returns decoded payload.
 *
 * @task T1234
 * @epic T1200
 * @why Enable stateless authentication for API endpoints
 * @what Implements RS256 signature verification with expiry check
 * @acceptance AC-001, AC-002
 */
export function validateToken(token: string): TokenPayload {
  // implementation
}
```

**Required JSDoc Tags:**

| Tag | Rule Level | Description |
|-----|------------|-------------|
| `@task` | MUST | Task ID that introduced this code |
| `@epic` | SHOULD | Parent epic ID (if exists) |
| `@why` | MUST | Business rationale (1 sentence) |
| `@what` | MUST | Technical summary (1 sentence) |
| `@acceptance` | SHOULD | Acceptance criteria IDs satisfied |

#### 3.2.3 Code to Commit (Conventional Commit)

Commits MUST follow the pattern:

```
{type}({phase}-{task}): {description}

{optional body with details}

Refs: #{task-id}
Epic: #{epic-id}

Co-Authored-By: Claude <agent>
```

**Type values:**

| Type | Use Case |
|------|----------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructure |
| `test` | Test addition/modification |
| `docs` | Documentation |
| `chore` | Maintenance |

**Examples:**

```
feat(core-T1234): add JWT token validation

Implements RS256 signature verification with configurable expiry.
Includes error handling for malformed and expired tokens.

Refs: #T1234
Epic: #T1200

Co-Authored-By: Claude Sonnet <noreply@anthropic.com>
```

#### 3.2.4 Commit to Changeset

Changesets are auto-captured on task completion:

```json
{
  "id": "CS-20260123-001",
  "taskId": "T1234",
  "epicId": "T1200",
  "phase": "core",
  "commits": ["abc123", "def456"],
  "files": [
    {"path": "src/auth.ts", "action": "modified"},
    {"path": "src/auth.test.ts", "action": "added"}
  ],
  "summary": "Add JWT validation with RS256 signing",
  "capturedAt": "2026-01-23T10:30:00Z"
}
```

#### 3.2.5 Changeset to Changelog

Changelog entries MUST reference the changeset:

```markdown
## [Unreleased]

### Added
- JWT token validation with RS256 signing ([T1234], [CS-20260123-001])
  - Configurable token expiry
  - Error handling for malformed tokens
```

### 3.3 Traceability Matrix

| Artifact | Links To | Linked By | Validation |
|----------|----------|-----------|------------|
| Epic | Tasks | Release | `ct show T1200 --children` |
| Task | Epic, Commits | Code (JSDoc) | `ct show T1234` |
| Code | Task (JSDoc) | Commit | `grep @task *.ts` |
| Commit | Task (message) | Changeset | `git log --grep T1234` |
| Changeset | Task, Commits | Changelog | Changeset file exists |
| Changelog | Changeset | Release notes | Changeset ID in entry |

---

## Part 4: Determinism Criteria

### 4.1 Determinism Definition

An agent output is **deterministic** if it satisfies ALL of the following:

| Criterion | Test | Validation Method |
|-----------|------|-------------------|
| **Reproducible** | Same inputs yield same outputs | Hash comparison (excluding timestamps) |
| **Traceable** | Links to requirements | Provenance fields populated |
| **Verifiable** | Testable against criteria | Acceptance criteria mapped |
| **Atomic** | Single concern | Atomicity score = 100 |
| **Complete** | No missing pieces | All required fields present |
| **Bounded** | Within constraints | File/line limits respected |

### 4.2 Determinism Score Calculation

```
FUNCTION calculate_determinism_score(output: AgentOutput) -> float:

    score = 0
    max_score = 6

    # Criterion 1: Reproducible (same structure)
    IF output.changeset.filesModified == expected_files:
        score += 1

    # Criterion 2: Traceable
    IF output.provenance.taskId IS NOT null:
        score += 0.5
    IF output.provenance.epicId IS NOT null:
        score += 0.5

    # Criterion 3: Verifiable
    IF output.provenance.acceptanceCriteriaMet.length > 0:
        acceptance_coverage = met_criteria / total_criteria
        score += acceptance_coverage

    # Criterion 4: Atomic
    IF output.changeset.filesModified.length <= 3:
        score += 1

    # Criterion 5: Complete
    IF all_required_fields_present(output):
        score += 1

    # Criterion 6: Bounded
    IF within_constraints(output):
        score += 1

    RETURN score / max_score * 100
```

### 4.3 Determinism Thresholds

| Score | Classification | Action |
|-------|---------------|--------|
| 95-100% | Deterministic | Accept output |
| 80-94% | Mostly deterministic | Review and accept |
| 60-79% | Partially deterministic | Requires HITL review |
| <60% | Non-deterministic | Reject, re-execute |

### 4.4 Determinism Checklist

Before marking a task complete, verify:

- [ ] All acceptance criteria mapped to output
- [ ] Provenance chain complete (Task -> Code -> Commit)
- [ ] File changes within scope limits
- [ ] JSDoc provenance tags present
- [ ] Commit message follows convention
- [ ] Changeset auto-captured
- [ ] No hidden sub-decisions remaining
- [ ] Tests pass (if applicable)

---

## Part 5: Anti-Hallucination Constraints

### 5.1 Maximum Scope for Single Agent Pass

| Scope Dimension | Limit | Rationale |
|-----------------|-------|-----------|
| Files modified | 3 | Beyond 3, cross-file reasoning degrades |
| Lines per file | 500 | Context window efficiency |
| Functions per task | 5 | Cognitive load boundary |
| Dependencies added | 3 | Minimize ripple effects |
| Architectural decisions | 0 | MUST be pre-decided |

### 5.2 Required Context Injection

Agents MUST receive manifest summaries, NOT full file contents:

```json
{
  "context": {
    "manifestSummary": {
      "research": [
        {
          "id": "auth-2026-01-23",
          "title": "JWT Best Practices Research",
          "keyFindings": [
            "RS256 preferred for asymmetric signing",
            "Token expiry should be configurable",
            "Refresh tokens require secure storage"
          ]
        }
      ],
      "priorDecisions": [
        {
          "id": "DEC-001",
          "decision": "Use RS256 for JWT signing",
          "rationale": "Asymmetric allows key rotation"
        }
      ]
    },
    "relevantFiles": [
      {
        "path": "src/config.ts",
        "exports": ["jwtSecret", "tokenExpiry"],
        "lineCount": 45
      }
    ]
  }
}
```

### 5.3 Explicit Output Format Requirements

Agents MUST produce structured JSON, NOT prose:

| Output Type | Format | Schema |
|-------------|--------|--------|
| Task completion | JSON | `agent-contract/output.schema.json` |
| Research findings | JSON | `research-output.schema.json` |
| Changeset | JSON | `changeset.schema.json` |
| Handoff message | JSON | `handoff.schema.json` |

**Prohibited Output Patterns:**

```
# BAD: Prose response
"I've completed the implementation. The changes include..."

# GOOD: Structured JSON
{
  "task": {"id": "T1234", "status": "complete"},
  "changeset": {"filesModified": [...]}
}
```

### 5.4 Verification Gates Before Completion

Before an agent marks a task complete, it MUST verify:

| Gate | Validation | Exit Code on Failure |
|------|------------|---------------------|
| Files exist | `test -f` for all modified files | 3 |
| Tests pass | `npm test` / `pytest` | 6 |
| Lint passes | `eslint` / `ruff` | 6 |
| Provenance tags | JSDoc `@task` present | 6 |
| Schema validation | JSON schema check | 6 |
| Changeset captured | CS file exists | 3 |

### 5.5 Hallucination Detection Heuristics

| Signal | Likelihood | Action |
|--------|------------|--------|
| References non-existent files | High | Reject, provide file list |
| Invents API not in codebase | High | Reject, provide API summary |
| Claims tests pass without running | Medium | Force test execution |
| Skips required provenance tags | Medium | Fail validation |
| Output exceeds scope limits | Medium | Decompose or reject |
| Conflicting statements in output | High | HITL review |

---

## Part 6: Universal Application

### 6.1 Greenfield (No Existing Code)

For new projects without existing code:

#### 6.1.1 Adjusted Contract

| Field | Greenfield Behavior |
|-------|---------------------|
| `context.relevantFiles` | Empty (no existing files) |
| `context.manifestSummary` | Research and spec summaries |
| `constraints.maxFiles` | May be relaxed (5-7) for initial scaffolding |
| `task.acceptance` | MUST be explicit (no "match existing pattern") |

#### 6.1.2 Greenfield-Specific Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Architecture decisions | Pre-specified in spec | Prevent runtime architectural drift |
| Dependency choices | Pre-specified in spec | Deterministic package selection |
| Directory structure | Template-based | Consistent project layout |
| Naming conventions | Explicit in task | No implicit pattern matching |

#### 6.1.3 Greenfield Provenance Chain

```
Spec (FEATURE-SPEC.md)
    |
    +--> Epic (T001: Implement Feature)
              |
              +--> Task (T002: Create schema)
                        |
                        +--> Code (new file with @task T002)
                                    |
                                    +--> Commit (feat(setup-T002): ...)
```

### 6.2 Brownfield (Existing Codebase)

For projects with existing code:

#### 6.2.1 Adjusted Contract

| Field | Brownfield Behavior |
|-------|---------------------|
| `context.relevantFiles` | Populated with existing patterns |
| `context.manifestSummary` | Include prior decisions |
| `constraints.maxFiles` | Strict (3) to prevent cascade |
| `task.acceptance` | May reference existing behavior |

#### 6.2.2 Brownfield-Specific Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Match existing patterns | MUST | Consistency with codebase |
| Preserve backwards compatibility | SHOULD | Minimize breaking changes |
| Reference existing tests | MUST | Maintain test coverage |
| Update existing docs | SHOULD | Keep docs in sync |

#### 6.2.3 Brownfield Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing behavior | Comprehensive test suite required |
| Inconsistent patterns | Provide pattern examples in context |
| Missing dependencies | Explicit dependency list in task |
| Scope creep | Strict file limit enforcement |

### 6.3 Research Tasks vs. Implementation Tasks

#### 6.3.1 Research Task Contract

Research tasks produce information, not code:

```json
{
  "taskType": "research",
  "output": {
    "type": "research",
    "findings": [],
    "recommendations": [],
    "sources": []
  },
  "changeset": null,
  "handoff": {
    "nextStage": "consensus",
    "manifestEntry": "research-id"
  }
}
```

**Research Task Constraints:**

| Constraint | Value |
|------------|-------|
| Files modified | 0 (research docs only) |
| Code generation | Prohibited |
| Commits | 0 |
| Output format | Research manifest entry |

#### 6.3.2 Implementation Task Contract

Implementation tasks produce code changes:

```json
{
  "taskType": "implementation",
  "output": {
    "type": "changeset",
    "filesModified": [],
    "commits": []
  },
  "changeset": {},
  "handoff": {
    "nextAgent": "testing",
    "context": "Ready for testing"
  }
}
```

**Implementation Task Constraints:**

| Constraint | Value |
|------------|-------|
| Files modified | 1-3 |
| Research | Prohibited (use prior research) |
| Commits | 1+ per task |
| Output format | Changeset JSON |

#### 6.3.3 Task Type Decision Matrix

| Scenario | Task Type | Rationale |
|----------|-----------|-----------|
| "Evaluate library options" | Research | Information gathering |
| "Add validation function" | Implementation | Code change |
| "Design API structure" | Research | Architectural exploration |
| "Implement API endpoint" | Implementation | Code change |
| "Review security practices" | Research | Information gathering |
| "Fix security vulnerability" | Implementation | Code change |

---

## Part 7: Verification Protocol

### 7.1 Pre-Execution Verification

Before an agent begins work:

```
FUNCTION verify_input_contract(input: AgentInput) -> Result:

    errors = []

    # Required fields
    IF input.task.id IS null:
        errors.append("E_MISSING_TASK_ID")

    IF input.task.acceptance.length == 0:
        errors.append("E_NO_ACCEPTANCE_CRITERIA")

    IF input.context.projectRoot IS null:
        errors.append("E_NO_PROJECT_ROOT")

    # Constraint validation
    IF input.constraints.maxFiles > 10:
        errors.append("E_SCOPE_TOO_LARGE")

    IF errors.length > 0:
        RETURN Error(errors)

    RETURN Success
```

### 7.2 In-Execution Verification

During agent execution:

| Checkpoint | Frequency | Action on Failure |
|------------|-----------|-------------------|
| File count | Per write | Warn, then halt |
| Decisions logged | Per decision | Auto-log |
| Context window | Every 1000 tokens | Compact or halt |
| Timeout | Continuous | Halt with partial output |

### 7.3 Post-Execution Verification

After agent completes work:

```
FUNCTION verify_output_contract(output: AgentOutput) -> Result:

    score = calculate_determinism_score(output)

    IF score < 60:
        RETURN Reject("Determinism score too low: {score}%")

    IF score < 80:
        RETURN RequiresHITL("Determinism score marginal: {score}%")

    # Provenance verification
    IF NOT verify_provenance_chain(output):
        RETURN Reject("Provenance chain broken")

    # Changeset verification
    IF output.changeset IS NOT null:
        IF NOT verify_changeset(output.changeset):
            RETURN Reject("Changeset invalid")

    RETURN Accept(score)
```

---

## Part 8: Compliance Checklist

### 8.1 Agent Startup Compliance

- [ ] Agent receives complete input contract
- [ ] Task ID is valid CLEO format
- [ ] Acceptance criteria are testable
- [ ] Context includes relevant file summaries
- [ ] Constraints are specified
- [ ] Scope is within limits

### 8.2 Agent Execution Compliance

- [ ] Files read are tracked
- [ ] Files modified are tracked
- [ ] Decisions are logged with rationale
- [ ] Scope limits are respected
- [ ] No architectural decisions made runtime

### 8.3 Agent Completion Compliance

- [ ] Output follows schema
- [ ] Provenance chain is complete
- [ ] Task -> Code (JSDoc) link exists
- [ ] Code -> Commit link exists
- [ ] Changeset is captured
- [ ] Determinism score >= 80%
- [ ] Handoff context is provided

### 8.4 Provenance Compliance

- [ ] JSDoc includes `@task` tag
- [ ] JSDoc includes `@why` and `@what`
- [ ] Commit follows `{type}({phase}-{task})` format
- [ ] Commit references task ID
- [ ] Changeset references commit hashes
- [ ] Changelog references changeset ID

---

## Part 9: Exit Codes and Error Codes

### 9.1 Agent Contract Exit Codes (60-69)

| Code | Constant | Meaning |
|------|----------|---------|
| 60 | `EXIT_CONTRACT_INVALID` | Input contract validation failed |
| 61 | `EXIT_SCOPE_EXCEEDED` | Agent exceeded scope limits |
| 62 | `EXIT_PROVENANCE_BROKEN` | Provenance chain incomplete |
| 63 | `EXIT_DETERMINISM_LOW` | Determinism score below threshold |
| 64 | `EXIT_CHANGESET_FAILED` | Changeset capture failed |
| 65 | `EXIT_HANDOFF_FAILED` | Handoff to next agent failed |
| 66 | `EXIT_VERIFICATION_FAILED` | Post-execution verification failed |

### 9.2 Error Codes

| Code | Exit Code | Description |
|------|-----------|-------------|
| `E_CONTRACT_MISSING_TASK` | 60 | Task ID not provided |
| `E_CONTRACT_NO_ACCEPTANCE` | 60 | No acceptance criteria |
| `E_CONTRACT_SCOPE_EXCEEDED` | 61 | Files modified > limit |
| `E_PROVENANCE_NO_JSDOC` | 62 | JSDoc @task tag missing |
| `E_PROVENANCE_BAD_COMMIT` | 62 | Commit format incorrect |
| `E_DETERMINISM_FAILED` | 63 | Determinism score < 60% |
| `E_CHANGESET_WRITE_FAILED` | 64 | Could not write changeset |
| `E_HANDOFF_NO_CONTEXT` | 65 | Handoff context missing |

---

## Part 10: Related Specifications

| Document | Relationship |
|----------|--------------|
| [ORCHESTRATOR-PROTOCOL-SPEC.md](ORCHESTRATOR-PROTOCOL-SPEC.md) | Orchestrator behavioral constraints |
| [TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md) | Atomicity criteria definition |
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | JSON output standards |
| [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) | 7-agent pipeline |
| [ORCHESTRATOR-SPEC.md](ORCHESTRATOR-SPEC.md) | tmux-based orchestration |
| [RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md) | Research-to-task pipeline |

---

## Appendix A: Quick Reference

### A.1 Input Contract Summary

```
Agent MUST receive:
- task.id (TXXX format)
- task.acceptance[] (testable criteria)
- context.projectRoot (absolute path)
- constraints.outputFormat (json)
```

### A.2 Output Contract Summary

```
Agent MUST produce:
- task.status (complete|partial|blocked|failed)
- provenance.taskId (matches input)
- changeset.filesModified[] (for implementation tasks)
- handoff.nextAgent (or null if final)
```

### A.3 Provenance Tags Summary

```typescript
/**
 * @task TXXX - Required
 * @epic TYYY - Recommended
 * @why Business rationale - Required
 * @what Technical summary - Required
 * @acceptance AC-001, AC-002 - Recommended
 */
```

### A.4 Commit Format Summary

```
{type}({phase}-{task}): {description}

Refs: #{task-id}
Epic: #{epic-id}
```

---

## Appendix B: Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-23 | Initial specification |

---

*Specification v1.0.0 - Deterministic Agent Contract*
*Author: Requirements Analyst Subagent*
*Status: DRAFT*
