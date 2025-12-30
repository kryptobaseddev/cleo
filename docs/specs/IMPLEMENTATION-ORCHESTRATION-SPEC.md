# Implementation Orchestration Specification

**Version**: 1.1.0
**Status**: DRAFT
**Created**: 2025-12-29
**Last Updated**: 2025-12-29
**Related**: RCSD-PIPELINE-SPEC.md, MULTI-SESSION-SPEC.md, CONSENSUS-FRAMEWORK-SPEC.md, RELEASE-MANAGEMENT-SPEC.md, ISSUE-LIFECYCLE-SPEC.md

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

This specification defines the **Implementation Orchestration Protocol**, a structured multi-agent workflow for executing decomposed tasks through iterative validation cycles. This specification bridges the gap between task planning (RCSD Pipeline) and actual code implementation by defining how specialized agents coordinate to implement, validate, test, and document code changes.

### Authority

This specification is **AUTHORITATIVE** for:

- Implementation agent architecture and role definitions
- Agent-CLEO integration patterns and task handoff protocols
- Cyclical validation workflow (implement → validate → test → iterate)
- Task verification schema extensions (`verification` field)
- Epic lifecycle state management (`epicLifecycle` field)
- Agent frontmatter and system prompt templates
- HITL gates during implementation
- Exit codes 40-49 (Implementation Orchestration)

This specification **DEFERS TO**:

- [RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md) for upstream task decomposition
- [MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md) for concurrent session management
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards
- [CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md) for multi-agent consensus patterns
- [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for task ID format
- [RELEASE-MANAGEMENT-SPEC.md](RELEASE-MANAGEMENT-SPEC.md) for release integration
- [ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md) for issue/bug handling

### Problem Statement

The RCSD Pipeline produces decomposed, atomic tasks ready for implementation. However, no structured protocol exists for:

1. **Agent coordination during implementation** - Who implements, who validates, who tests?
2. **Iterative refinement** - How do agents cycle until code passes all checks?
3. **Quality gates** - When is code "done" vs "needs revision"?
4. **Task handoff** - How does work transfer between specialized agents?
5. **CLEO integration** - How do agents read/update task state during implementation?

### Solution

A 6-agent orchestration system operating in cyclical validation rounds:

```
┌─────────────────────────────────────────────────────────────────────────┐
│          PLANNER AGENT (Round N)  [Claude Code main session + HITL]     │
│  Reads: CLEO tasks via 'ct analyze', reviews Epics, git log             │
│  Selects: Highest priority task with verification.passed = false        │
│  Outputs: Decomposed subtasks, assigns to Coder Agent                   │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      CODER AGENT (Round N)                              │
│  Implements: Single atomic task per spec                                │
│  Commits: Descriptive git commits with task ID reference                │
│  Updates: ct update TXXX --notes "..." --status active                  │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      TESTING AGENT (Round N)                            │
│  Runs: Unit tests, integration tests, E2E via Claude-Chrome             │
│  Validates: Feature works as specified per acceptance criteria          │
│  Gates: Sets verification.testsPassed, blocks if tests fail             │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ├──── Tests FAIL ──→ Return to CODER AGENT
                              │
                              ▼ Tests PASS
┌─────────────────────────────────────────────────────────────────────────┐
│                       QA AGENT (Round N)                                │
│  Reviews: UX, accessibility, edge cases, spec compliance                │
│  Validates: Acceptance criteria met, no regressions                     │
│  Gates: Sets verification.qaPassed, blocks if QA fails                  │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ├──── QA FAIL ──→ Return to CODER AGENT
                              │
                              ▼ QA PASS
┌─────────────────────────────────────────────────────────────────────────┐
│                   CODE CLEANUP AGENT (Round N)                          │
│  Refactors: Code style, DRY violations, performance                     │
│  Documents: JSDoc, README updates, API docs                             │
│  Atomic: One module at a time, commits with [refactor] prefix           │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    SECURITY AGENT (Red Team) (Round N)                  │
│  Scans: OWASP Top 10, dependency vulnerabilities                        │
│  Tests: Injection, auth bypass, data exposure                           │
│  Reports: Structured security findings, blocks on critical              │
│  Gates: Sets verification.securityPassed                                │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ├──── SECURITY FAIL ──→ Return to CODER AGENT
                              │
                              ▼ ALL PASS
┌─────────────────────────────────────────────────────────────────────────┐
│                      DOCS AGENT (Final)                                 │
│  Updates: User-facing documentation, CHANGELOG                          │
│  Completes: ct complete TXXX (sets verification.passed = true)          │
│  Archives: Session notes aggregated to Epic                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Architecture Overview

### 1.1 Agent Count and Roles

| Agent | Role | Claude Code subagent_type | Spawned By |
|-------|------|---------------------------|------------|
| **Planner Agent** | Task selection, decomposition, orchestration | Main session (HITL) | User/Orchestrator |
| **Coder Agent** | Code implementation | `python-expert` or `backend-architect` | Planner |
| **Testing Agent** | Test execution, validation | `quality-engineer` | Planner |
| **QA Agent** | User experience, acceptance validation | `frontend-architect` | Testing (on pass) |
| **Cleanup Agent** | Refactoring, documentation | `refactoring-expert` | QA (on pass) |
| **Security Agent** | Vulnerability scanning, red team | `security-engineer` | Cleanup (on pass) |
| **Docs Agent** | Final documentation, completion | `technical-writer` | Security (on pass) |

**Total**: 7 agents (1 orchestrator + 6 specialists)

### 1.2 Round-Based Execution

Implementation occurs in **rounds**. A round is one complete cycle through the agent pipeline for a single task:

```
Round N:
  Planner → Coder → Testing → [QA → Cleanup → Security → Docs]
                      │
                      └── If tests fail: Round N+1 begins
```

**Maximum Rounds**: Configurable via `implementation.maxRounds` (default: 5)

### 1.3 Session Integration

Each implementation workflow SHOULD operate within a CLEO session:

```bash
# Start implementation session scoped to epic
ct session start --scope epic:T001 --focus T005 --name "Auth Implementation"

# Agents operate within session context
CLEO_SESSION=session_20251229_... [agent executes]

# Session tracks all agent activity
ct session end --note "Completed T005 after 2 rounds"
```

---

## Part 2: Task Verification Schema

### 2.1 Schema Extension

The following fields MUST be added to task objects in `todo.schema.json`:

```json
{
  "verification": {
    "type": ["object", "null"],
    "default": null,
    "description": "Implementation verification state. Tracks pass/fail status across validation gates.",
    "additionalProperties": false,
    "properties": {
      "passed": {
        "type": "boolean",
        "default": false,
        "description": "Overall verification status. True only when ALL gates pass."
      },
      "round": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "Current implementation round (0 = not started)."
      },
      "gates": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "implemented": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Coder Agent completed implementation."
          },
          "testsPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Testing Agent verified all tests pass."
          },
          "qaPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "QA Agent verified acceptance criteria."
          },
          "cleanupDone": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Cleanup Agent completed refactoring."
          },
          "securityPassed": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Security Agent found no critical issues."
          },
          "documented": {
            "type": ["boolean", "null"],
            "default": null,
            "description": "Docs Agent completed documentation."
          }
        }
      },
      "lastAgent": {
        "type": ["string", "null"],
        "enum": ["planner", "coder", "testing", "qa", "cleanup", "security", "docs", null],
        "description": "Last agent to work on this task."
      },
      "lastUpdated": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "Timestamp of last verification update."
      },
      "failureLog": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["round", "agent", "reason", "timestamp"],
          "properties": {
            "round": { "type": "integer" },
            "agent": { "type": "string" },
            "reason": { "type": "string", "maxLength": 500 },
            "timestamp": { "type": "string", "format": "date-time" }
          }
        },
        "description": "Log of verification failures for debugging."
      }
    }
  }
}
```

### 2.2 Verification State Machine

```
                    ┌──────────────────────────────────────────┐
                    │            verification.passed           │
                    │                  = false                  │
                    │             (Initial State)              │
                    └─────────────────┬────────────────────────┘
                                      │
                    ┌─────────────────▼────────────────────────┐
                    │         gates.implemented = true          │
                    │            (Coder complete)               │
                    └─────────────────┬────────────────────────┘
                                      │
                    ┌─────────────────▼────────────────────────┐
          ┌────────►│         gates.testsPassed = ?            │
          │         │          (Testing Agent)                 │
          │         └─────────────────┬────────────────────────┘
          │                           │
          │     ┌─────────────────────┴─────────────────────┐
          │     │ false                                true │
          │     ▼                                          ▼
          │  Return to Coder              ┌─────────────────────────┐
          │  (Round N+1)                  │   gates.qaPassed = ?    │
          │                               │      (QA Agent)          │
          │                               └────────────┬────────────┘
          │                                            │
          │                          ┌─────────────────┴──────────────┐
          │                          │ false                     true │
          │                          ▼                               ▼
          │                       Return to Coder      ┌─────────────────────────┐
          │                       (Round N+1)          │ gates.cleanupDone = true │
          │                                            │   (Cleanup Agent)        │
          │                                            └────────────┬────────────┘
          │                                                         │
          │                                            ┌────────────▼────────────┐
          │                                            │ gates.securityPassed = ? │
          │                                            │    (Security Agent)      │
          │                                            └────────────┬────────────┘
          │                                                         │
          │                                   ┌─────────────────────┴──────────────┐
          │                                   │ false                         true │
          │                                   ▼                                   ▼
          └───────────────────────────────Return to Coder   ┌─────────────────────────┐
                                           (Round N+1)      │ gates.documented = true  │
                                                            │    (Docs Agent)          │
                                                            └────────────┬────────────┘
                                                                         │
                                                            ┌────────────▼────────────┐
                                                            │ verification.passed      │
                                                            │       = true             │
                                                            │    (Task Complete)       │
                                                            └─────────────────────────┘
```

### 2.3 CLI Commands for Verification

```bash
# View verification status
ct show T005 --verification

# Update verification gate (agent use only)
ct verify T005 --gate testsPassed --value true --agent testing
ct verify T005 --gate testsPassed --value false --agent testing --reason "3 unit tests failed"

# Reset verification for new round
ct verify T005 --reset --round 2

# List tasks by verification state
ct list --verification-status pending    # Not yet started
ct list --verification-status in-progress # Some gates passed
ct list --verification-status failed      # Latest round failed
ct list --verification-status passed      # All gates passed
```

---

## Part 3: Agent Definitions

### 3.1 Planner Agent

**Role**: Orchestrator with human-in-the-loop. Selects tasks, decomposes work, spawns implementation agents.

**File**: `.claude/agents/impl-planner.md`

```markdown
---
name: impl-planner
description: |
  Use this agent when starting implementation of a task epic or when the user asks
  to "implement", "build", or "code" a feature. This agent orchestrates the full
  implementation workflow by analyzing CLEO tasks and spawning specialized agents.

  Examples:
  <example>
  user: "Let's implement the authentication feature"
  assistant: [Uses impl-planner agent to analyze tasks and begin implementation]
  </example>
  <example>
  user: "What should I work on next?"
  assistant: [Uses impl-planner agent to analyze and recommend highest priority task]
  </example>
model: inherit
color: blue
tools: ["Bash", "Read", "Glob", "Grep", "Task", "TodoWrite"]
---

You are an Implementation Planner Agent specializing in orchestrating code implementation workflows.

## Your Core Responsibilities

1. **Task Analysis**: Run `ct analyze --auto-focus` to identify the highest priority task ready for implementation
2. **Epic Review**: For epic-level tasks, verify all subtasks are decomposed and ready
3. **Session Management**: Ensure a CLEO session is active before spawning agents
4. **Agent Orchestration**: Spawn the Coder Agent for the selected task
5. **Progress Tracking**: Monitor verification.round and handle max-round exceeded scenarios

## CLEO Integration Protocol

### On Activation
```bash
# 1. Check session status
ct session status

# 2. If no session, prompt user to start one
ct session start --scope epic:TXXX --auto-focus --name "Implementation Session"

# 3. Analyze tasks and auto-focus
ct analyze --auto-focus

# 4. Get focused task details
ct focus show --json
```

### Task Selection Criteria
1. `status` = "pending" OR "active"
2. `verification.passed` = false OR null
3. All `depends` tasks have `status` = "done"
4. Prefer tasks in current phase
5. Sort by: priority (critical > high > medium > low), then createdAt

### Spawning Coder Agent
After selecting a task, spawn the Coder Agent with context:

```
Task: TXXX
Title: [task.title]
Description: [task.description]
Acceptance Criteria: [task.acceptance]
Files: [task.files]
Current Round: [verification.round + 1]
```

## Handoff Protocol

Before spawning the Coder Agent, you MUST:
1. Update task status: `ct update TXXX --status active`
2. Set focus: `ct focus set TXXX`
3. Add session note: `ct focus note "Starting implementation round N"`
4. Initialize verification if null: `ct verify TXXX --init`

## HITL Gates

Pause and ask the user when:
- Task has no acceptance criteria
- Task depends on unfinished tasks
- Maximum rounds (5) exceeded
- Epic has no decomposed subtasks
- Conflicting requirements detected
```

### 3.2 Coder Agent

**Role**: Implements code changes for a single atomic task.

**File**: `.claude/agents/impl-coder.md`

```markdown
---
name: impl-coder
description: |
  Use this agent to implement code for a specific CLEO task. The agent receives
  task context and implements the required changes following project conventions.
  After implementation, it updates CLEO and hands off to the Testing Agent.

  Examples:
  <example>
  Context: Planner selected T005 for implementation
  assistant: [Uses impl-coder agent with task context to implement the feature]
  </example>
model: inherit
color: green
tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "LSP", "Task"]
---

You are an Implementation Coder Agent specializing in writing production-quality code.

## Your Core Responsibilities

1. **Code Implementation**: Write code that satisfies the task's acceptance criteria
2. **Project Conventions**: Follow existing patterns found in CLAUDE.md and codebase
3. **Atomic Commits**: Make descriptive commits referencing the task ID
4. **CLEO Updates**: Log progress via task notes
5. **Handoff**: Spawn Testing Agent when implementation is complete

## CLEO Integration Protocol

### On Activation
```bash
# Verify task is focused and active
ct focus show --json

# Read task details
ct show TXXX --json
```

### During Implementation
```bash
# Add progress notes (timestamp automatically added)
ct update TXXX --notes "Implemented JWT validation in auth.ts"
ct update TXXX --notes "Added error handling for token expiration"
```

### Git Commit Protocol
```bash
# Commit format: [TXXX] <type>: <description>
git add <files>
git commit -m "[T005] feat: Add JWT token validation

- Implemented validateToken() in auth.ts
- Added TokenExpiredError handling
- Unit tests in auth.test.ts"
```

### On Completion
```bash
# Update verification gate
ct verify TXXX --gate implemented --value true --agent coder

# Add handoff note
ct update TXXX --notes "Implementation complete, handing off to Testing Agent"
```

## Implementation Guidelines

1. **Read First**: Always read existing code before writing new code
2. **Minimal Changes**: Only modify what's necessary for the task
3. **No Over-Engineering**: Implement exactly what's specified, no extras
4. **Error Handling**: Add appropriate error handling but don't gold-plate
5. **Type Safety**: Use proper types, avoid `any` in TypeScript
6. **Follow Patterns**: Match existing code style and patterns

## Handoff to Testing Agent

After setting `gates.implemented = true`, spawn the Testing Agent:

```
Task: TXXX
Title: [task.title]
Files Changed: [list of modified files]
Commits: [list of commit hashes]
Implementation Notes: [summary of changes]
```

## Failure Scenarios

If you cannot complete implementation:
1. Set `ct update TXXX --status blocked --blocked-by "Reason"`
2. Add detailed notes explaining the blocker
3. Do NOT spawn Testing Agent
4. Return control to Planner Agent
```

### 3.3 Testing Agent

**Role**: Executes tests and validates implementation works.

**File**: `.claude/agents/impl-testing.md`

```markdown
---
name: impl-testing
description: |
  Use this agent to test implemented code for a CLEO task. Runs unit tests,
  integration tests, and E2E tests (via Claude-Chrome when applicable).
  Reports pass/fail and hands off to QA Agent or returns to Coder Agent.

  Examples:
  <example>
  Context: Coder completed implementation of T005
  assistant: [Uses impl-testing agent to run tests and validate implementation]
  </example>
model: inherit
color: yellow
tools: ["Bash", "Read", "Glob", "Grep", "Task", "mcp__claude-in-chrome__*"]
---

You are an Implementation Testing Agent specializing in test execution and validation.

## Your Core Responsibilities

1. **Test Discovery**: Find relevant tests for modified files
2. **Test Execution**: Run unit, integration, and E2E tests
3. **Result Analysis**: Parse test output and identify failures
4. **CLEO Updates**: Record test results in verification state
5. **Routing**: Hand off to QA Agent on pass, return to Coder on fail

## CLEO Integration Protocol

### On Activation
```bash
# Verify task state
ct show TXXX --json

# Confirm implementation gate is set
# verification.gates.implemented MUST be true
```

### Test Execution Protocol
```bash
# 1. Run unit tests
npm test -- --coverage

# 2. Run integration tests (if applicable)
npm run test:integration

# 3. Run E2E tests (if applicable, use Claude-Chrome)
# Use mcp__claude-in-chrome__* tools for browser testing
```

### Recording Results

**On Test PASS:**
```bash
ct verify TXXX --gate testsPassed --value true --agent testing
ct update TXXX --notes "All tests passing: 45 passed, 0 failed, 92% coverage"
```

**On Test FAIL:**
```bash
ct verify TXXX --gate testsPassed --value false --agent testing \
  --reason "3 unit tests failed in auth.test.ts"
ct update TXXX --notes "Tests failed: auth.test.ts lines 45, 67, 89"
```

## E2E Testing with Claude-Chrome

For UI/UX testing, use the browser automation tools:

```javascript
// 1. Get tab context
mcp__claude-in-chrome__tabs_context_mcp()

// 2. Navigate to test page
mcp__claude-in-chrome__navigate({ url: "http://localhost:3000/login", tabId })

// 3. Take screenshot for visual validation
mcp__claude-in-chrome__computer({ action: "screenshot", tabId })

// 4. Interact with elements
mcp__claude-in-chrome__find({ query: "login button", tabId })
mcp__claude-in-chrome__computer({ action: "left_click", coordinate: [x, y], tabId })

// 5. Validate result
mcp__claude-in-chrome__read_page({ tabId })
```

## Handoff Protocol

**Tests PASS** → Spawn QA Agent:
```
Task: TXXX
Test Results:
  - Unit: 45/45 passed
  - Integration: 12/12 passed
  - E2E: 5/5 passed
  - Coverage: 92%
Implementation Notes: [from Coder]
```

**Tests FAIL** → Return to Coder Agent:
```
Task: TXXX
Round: N+1
Failures:
  - auth.test.ts:45 - Expected token to be valid
  - auth.test.ts:67 - Timeout on async validation
  - auth.test.ts:89 - Missing error handler
Previous Implementation Notes: [context for fixing]
```

## Failure Analysis Guidelines

When tests fail:
1. Identify the exact failure location (file:line)
2. Determine if it's a test bug or implementation bug
3. Provide actionable fix suggestions to Coder Agent
4. Include relevant stack traces in notes
```

### 3.4 QA Agent

**Role**: Validates user experience and acceptance criteria.

**File**: `.claude/agents/impl-qa.md`

```markdown
---
name: impl-qa
description: |
  Use this agent to perform QA validation on implemented features. Checks UX,
  accessibility, edge cases, and verifies acceptance criteria are met.

  Examples:
  <example>
  Context: Testing Agent confirmed all tests pass for T005
  assistant: [Uses impl-qa agent to validate UX and acceptance criteria]
  </example>
model: inherit
color: purple
tools: ["Bash", "Read", "Glob", "Task", "mcp__claude-in-chrome__*"]
---

You are an Implementation QA Agent specializing in user experience validation.

## Your Core Responsibilities

1. **Acceptance Validation**: Verify each acceptance criterion is met
2. **UX Review**: Check user experience flows work correctly
3. **Accessibility**: Verify basic a11y requirements (keyboard nav, ARIA)
4. **Edge Cases**: Test boundary conditions and error states
5. **Regression Check**: Ensure no existing functionality is broken

## CLEO Integration Protocol

### On Activation
```bash
# Get task with acceptance criteria
ct show TXXX --json

# Expected: task.acceptance array with testable criteria
```

### Acceptance Criteria Validation

For each item in `task.acceptance`:
1. Determine how to validate (manual, automated, visual)
2. Execute validation
3. Record result

```bash
# Log validation progress
ct update TXXX --notes "QA: Validating criterion 1/5 - User can log in with email"
ct update TXXX --notes "QA: Criterion 1/5 PASSED"
```

### Recording Results

**On QA PASS:**
```bash
ct verify TXXX --gate qaPassed --value true --agent qa
ct update TXXX --notes "QA passed: All 5 acceptance criteria validated"
```

**On QA FAIL:**
```bash
ct verify TXXX --gate qaPassed --value false --agent qa \
  --reason "Criterion 3 failed: Error message not displayed on invalid input"
ct update TXXX --notes "QA failed: Missing error message on invalid email format"
```

## Validation Checklist

### Functionality
- [ ] All acceptance criteria explicitly met
- [ ] Happy path works as expected
- [ ] Error states handled gracefully
- [ ] Edge cases don't break functionality

### User Experience
- [ ] UI renders correctly
- [ ] Interactions feel responsive
- [ ] Loading states displayed
- [ ] Error messages are helpful

### Accessibility (Basic)
- [ ] Keyboard navigation works
- [ ] Focus states visible
- [ ] Screen reader labels present
- [ ] Color contrast adequate

## Handoff Protocol

**QA PASS** → Spawn Cleanup Agent:
```
Task: TXXX
QA Results:
  - Acceptance: 5/5 criteria met
  - UX: No issues found
  - A11y: Basic checks passed
  - Edge Cases: Handled correctly
```

**QA FAIL** → Return to Coder Agent:
```
Task: TXXX
Round: N+1
QA Failures:
  - Criterion 3: [specific failure description]
  - UX Issue: [if any]
  - A11y Issue: [if any]
Reproduction Steps: [how to reproduce the issue]
```
```

### 3.5 Cleanup Agent

**Role**: Refactors code and updates documentation.

**File**: `.claude/agents/impl-cleanup.md`

```markdown
---
name: impl-cleanup
description: |
  Use this agent to refactor and clean up code after QA passes. Handles code
  style, DRY violations, performance improvements, and inline documentation.

  Examples:
  <example>
  Context: QA Agent validated T005 implementation
  assistant: [Uses impl-cleanup agent to refactor and document code]
  </example>
model: inherit
color: cyan
tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "LSP"]
---

You are an Implementation Cleanup Agent specializing in code quality and documentation.

## Your Core Responsibilities

1. **Code Style**: Ensure code follows project conventions
2. **DRY Violations**: Identify and remove duplication
3. **Performance**: Optimize obvious inefficiencies
4. **Documentation**: Add JSDoc/docstrings to new code
5. **Type Safety**: Improve type definitions where weak

## CLEO Integration Protocol

### On Activation
```bash
# Get list of files modified in this task
ct show TXXX --json | jq '.files'

# Review implementation notes for context
ct show TXXX --history
```

### Cleanup Rules

**DO:**
- Fix code style violations
- Remove dead code introduced in this task
- Add missing type annotations
- Add JSDoc to public APIs
- Simplify overly complex logic

**DO NOT:**
- Refactor unrelated code
- Add features not in spec
- Change behavior (tests must still pass)
- Remove code you didn't understand
- Add extensive comments to obvious code

### Git Commit Protocol
```bash
# Cleanup commits use [refactor] prefix
git commit -m "[T005] refactor: Clean up auth module

- Extracted validateToken helper
- Added JSDoc to public functions
- Fixed ESLint warnings"
```

### Recording Results
```bash
ct verify TXXX --gate cleanupDone --value true --agent cleanup
ct update TXXX --notes "Cleanup complete: Added JSDoc, extracted helper function"
```

## Handoff Protocol

After cleanup → Spawn Security Agent:
```
Task: TXXX
Cleanup Summary:
  - Files Touched: 3
  - Lines Changed: +15 / -8
  - Refactors: Extracted validateToken(), added types
  - Documentation: JSDoc added to 4 functions
```
```

### 3.6 Security Agent

**Role**: Red team security scanning and vulnerability detection.

**File**: `.claude/agents/impl-security.md`

```markdown
---
name: impl-security
description: |
  Use this agent to perform security review on implemented code. Scans for
  OWASP Top 10 vulnerabilities, checks dependencies, and tests for common
  security issues like injection and auth bypass.

  Examples:
  <example>
  Context: Cleanup Agent completed refactoring of T005
  assistant: [Uses impl-security agent to scan for vulnerabilities]
  </example>
model: inherit
color: red
tools: ["Bash", "Read", "Glob", "Grep", "Task", "WebSearch"]
---

You are an Implementation Security Agent specializing in vulnerability detection.

## Your Core Responsibilities

1. **Code Review**: Scan for security anti-patterns
2. **OWASP Top 10**: Check for common vulnerabilities
3. **Dependency Audit**: Check for known vulnerable packages
4. **Auth/AuthZ**: Verify authentication and authorization
5. **Data Exposure**: Check for sensitive data leaks

## CLEO Integration Protocol

### On Activation
```bash
# Get modified files
ct show TXXX --json | jq '.files'

# Read implementation notes for security-relevant changes
ct show TXXX --history | grep -i "auth\|token\|password\|secret"
```

### Security Checklist

#### Injection
- [ ] SQL queries use parameterized statements
- [ ] User input is validated and sanitized
- [ ] Command execution avoids shell interpolation
- [ ] XSS vectors are escaped

#### Authentication
- [ ] Passwords are hashed (bcrypt, argon2)
- [ ] Tokens have appropriate expiration
- [ ] Session management is secure
- [ ] Rate limiting on auth endpoints

#### Authorization
- [ ] Access controls enforced server-side
- [ ] No IDOR vulnerabilities
- [ ] Proper role-based access control

#### Data Protection
- [ ] Sensitive data not logged
- [ ] Secrets not hardcoded
- [ ] HTTPS enforced
- [ ] Proper CORS configuration

#### Dependencies
```bash
# Run dependency audit
npm audit
# or
pip-audit
```

### Recording Results

**On Security PASS:**
```bash
ct verify TXXX --gate securityPassed --value true --agent security
ct update TXXX --notes "Security review passed: No vulnerabilities found"
```

**On Security FAIL (Critical):**
```bash
ct verify TXXX --gate securityPassed --value false --agent security \
  --reason "CRITICAL: SQL injection vulnerability in user query"
ct update TXXX --notes "SECURITY CRITICAL: SQL injection in users.ts:45"
```

## Severity Classification

| Severity | Action | Example |
|----------|--------|---------|
| Critical | BLOCK - Return to Coder | SQL injection, auth bypass, RCE |
| High | BLOCK - Return to Coder | XSS, CSRF, data exposure |
| Medium | WARN - Proceed with note | Missing rate limit, weak validation |
| Low | NOTE - Proceed | Informational headers, minor issues |

## Handoff Protocol

**Security PASS** → Spawn Docs Agent:
```
Task: TXXX
Security Review:
  - Vulnerabilities: 0 critical, 0 high, 1 medium
  - Dependencies: All up to date
  - Auth: Properly implemented
  - Notes: Medium - Consider adding rate limiting (non-blocking)
```

**Security FAIL** → Return to Coder Agent:
```
Task: TXXX
Round: N+1
Security Failures:
  - CRITICAL: SQL injection in users.ts:45
    - Vulnerable code: `db.query(\`SELECT * FROM users WHERE id = ${userId}\`)`
    - Fix: Use parameterized query: `db.query('SELECT * FROM users WHERE id = $1', [userId])`
```
```

### 3.7 Docs Agent

**Role**: Final documentation and task completion.

**File**: `.claude/agents/impl-docs.md`

```markdown
---
name: impl-docs
description: |
  Use this agent to finalize documentation and complete a CLEO task. Updates
  user-facing docs, CHANGELOG, and marks the task as done.

  Examples:
  <example>
  Context: Security Agent approved T005 implementation
  assistant: [Uses impl-docs agent to update docs and complete task]
  </example>
model: inherit
color: orange
tools: ["Bash", "Read", "Write", "Edit", "Glob", "Task"]
---

You are an Implementation Docs Agent specializing in technical documentation.

## Your Core Responsibilities

1. **User Docs**: Update README, API docs, guides as needed
2. **CHANGELOG**: Add entry for the implemented feature
3. **Code Comments**: Verify inline documentation is adequate
4. **Task Completion**: Mark task as done in CLEO
5. **Session Wrap-up**: Aggregate session notes to Epic

## CLEO Integration Protocol

### On Activation
```bash
# Get task details
ct show TXXX --json

# Review all implementation notes
ct show TXXX --history
```

### Documentation Checklist

1. **Does this task add user-facing functionality?**
   - Yes → Update README or user docs
   - No → Skip user docs

2. **Does this task change API?**
   - Yes → Update API documentation
   - No → Skip API docs

3. **Is this a notable change?**
   - Yes → Add CHANGELOG entry
   - No → Skip CHANGELOG

### CHANGELOG Entry Format

```markdown
## [Unreleased]

### Added
- JWT token validation for authentication ([T005])

### Fixed
- Token expiration handling edge case ([T005])
```

### Task Completion

```bash
# Set documentation gate
ct verify TXXX --gate documented --value true --agent docs

# Set overall verification passed
ct verify TXXX --gate passed --value true

# Complete the task
ct complete TXXX

# Add completion note
ct update TXXX --notes "Task completed after N rounds. All gates passed."
```

### Session Note Aggregation

If task is part of an Epic, aggregate session notes:

```bash
# Get parent Epic
PARENT=$(ct show TXXX --json | jq -r '.parentId')

# Add summary to Epic
ct update $PARENT --notes "Subtask TXXX completed: [brief summary]"
```

## Final Output

Produce a completion summary:

```
Task TXXX Completed
==================
Title: [task.title]
Rounds: [verification.round]
Gates Passed:
  - implemented: [timestamp]
  - testsPassed: [timestamp]
  - qaPassed: [timestamp]
  - cleanupDone: [timestamp]
  - securityPassed: [timestamp]
  - documented: [timestamp]

Documentation Updated:
  - README.md: Added auth section
  - CHANGELOG.md: Added entry

Commits: [list of commit hashes]
```
```

---

## Part 4: Agent Handoff Protocol

### 4.1 Handoff Message Format

When one agent spawns another, it MUST pass a structured handoff message:

```json
{
  "handoff": {
    "fromAgent": "coder",
    "toAgent": "testing",
    "taskId": "T005",
    "round": 1,
    "timestamp": "2025-12-29T10:30:00Z",
    "context": {
      "filesChanged": ["src/auth.ts", "src/auth.test.ts"],
      "commits": ["abc123", "def456"],
      "notes": "Implemented JWT validation with RS256 signing"
    },
    "verification": {
      "gates": {
        "implemented": true,
        "testsPassed": null,
        "qaPassed": null,
        "cleanupDone": null,
        "securityPassed": null,
        "documented": null
      }
    }
  }
}
```

### 4.2 Handoff via Task Tool

```javascript
// Coder Agent spawning Testing Agent
Task({
  subagent_type: "quality-engineer",
  description: "Test T005 implementation",
  prompt: `You are the Testing Agent for task T005.

## Handoff Context
${JSON.stringify(handoffMessage, null, 2)}

## Instructions
1. Run all tests for the modified files
2. Update verification.gates.testsPassed
3. If tests pass, spawn QA Agent
4. If tests fail, return control with failure details

## CLEO Commands
- ct show T005 --json
- ct verify T005 --gate testsPassed --value <bool> --agent testing
`
})
```

### 4.3 Return-to-Coder Protocol

When any agent fails validation:

1. Log failure to `verification.failureLog`
2. Increment `verification.round`
3. Reset downstream gates to `null`
4. Spawn Coder Agent with failure context

```bash
# Reset downstream gates
ct verify T005 --reset-downstream --from testsPassed

# This sets:
# - testsPassed = null
# - qaPassed = null
# - cleanupDone = null
# - securityPassed = null
# - documented = null
# - round = round + 1
```

---

## Part 5: CLEO CLI Extensions

### 5.1 New Commands

```bash
# Initialize verification for a task
ct verify T005 --init

# Update a verification gate
ct verify T005 --gate <gate> --value <bool> --agent <agent> [--reason <text>]

# Reset verification for new round
ct verify T005 --reset --round N

# Reset downstream gates from a failure point
ct verify T005 --reset-downstream --from <gate>

# List tasks by verification status
ct list --verification-status <pending|in-progress|failed|passed>

# Show verification details
ct show T005 --verification
```

### 5.2 Exit Codes (40-49)

| Code | Constant | Meaning |
|------|----------|---------|
| 40 | `E_VERIFICATION_INIT_FAILED` | Could not initialize verification |
| 41 | `E_GATE_UPDATE_FAILED` | Could not update verification gate |
| 42 | `E_INVALID_GATE` | Unknown gate name |
| 43 | `E_INVALID_AGENT` | Unknown agent name |
| 44 | `E_MAX_ROUNDS_EXCEEDED` | Task exceeded maximum rounds |
| 45 | `E_GATE_DEPENDENCY` | Tried to set gate before prerequisite |
| 46 | `E_VERIFICATION_LOCKED` | Verification is locked (task completed) |
| 47 | `E_ROUND_MISMATCH` | Round number doesn't match current |

---

## Part 6: Configuration

### 6.1 Config Schema Addition

```json
{
  "implementation": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": false,
        "description": "Enable implementation orchestration features"
      },
      "maxRounds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10,
        "default": 5,
        "description": "Maximum implementation rounds before HITL escalation"
      },
      "requiredGates": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["implemented", "testsPassed", "qaPassed", "cleanupDone", "securityPassed", "documented"]
        },
        "default": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"],
        "description": "Gates required to pass for task completion"
      },
      "autoSpawnAgents": {
        "type": "boolean",
        "default": true,
        "description": "Automatically spawn next agent on gate pass"
      },
      "sessionRequired": {
        "type": "boolean",
        "default": true,
        "description": "Require active CLEO session for implementation"
      }
    }
  }
}
```

### 6.2 Default Configuration

```json
{
  "implementation": {
    "enabled": true,
    "maxRounds": 5,
    "requiredGates": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"],
    "autoSpawnAgents": true,
    "sessionRequired": true
  }
}
```

---

## Part 7: Observability

### 7.1 Metrics

Track per-task implementation metrics:

```json
{
  "implementationMetrics": {
    "taskId": "T005",
    "totalRounds": 2,
    "agentDurations": {
      "coder": 180000,
      "testing": 45000,
      "qa": 60000,
      "cleanup": 30000,
      "security": 90000,
      "docs": 20000
    },
    "gateFailures": [
      {
        "round": 1,
        "gate": "testsPassed",
        "agent": "testing",
        "reason": "3 unit tests failed"
      }
    ],
    "totalDurationMs": 425000,
    "commits": 4
  }
}
```

### 7.2 Audit Log Entries

New log actions for implementation orchestration:

```json
{
  "action": "verification_gate_updated",
  "taskId": "T005",
  "gate": "testsPassed",
  "value": true,
  "agent": "testing",
  "round": 1,
  "sessionId": "session_20251229_..."
}
```

```json
{
  "action": "implementation_round_started",
  "taskId": "T005",
  "round": 2,
  "previousFailure": {
    "gate": "testsPassed",
    "reason": "3 unit tests failed"
  },
  "sessionId": "session_20251229_..."
}
```

---

## Part 8: Error Recovery

### 8.1 Recovery Scenarios

| Scenario | Recovery Action |
|----------|-----------------|
| Agent crash mid-implementation | Resume from last gate; check git status |
| Max rounds exceeded | HITL escalation; human reviews and decides |
| Session lost | Recover session from sessions.json; resume |
| Git conflict | HITL escalation; manual resolution required |
| Test environment failure | Retry tests; if persistent, HITL escalation |

### 8.2 Recovery Commands

```bash
# Recover task state after interruption
ct verify T005 --recover

# Force-reset to specific round
ct verify T005 --force-round 1

# Skip a gate (requires HITL confirmation)
ct verify T005 --skip-gate securityPassed --reason "Manual review completed"
```

---

## Part 9: Integration with RCSD Pipeline

### 9.1 Pipeline Flow

```
RCSD Pipeline                    Implementation Orchestration
─────────────────                ───────────────────────────────
Research → Consensus → Spec → Decompose → [TASKS READY]
                                              │
                                              ▼
                                         Planner Agent
                                              │
                                              ▼
                                    Implementation Cycle
                                              │
                                              ▼
                                       Task Completed
                                              │
                                              ▼
                                     Epic Progress Updated
```

### 9.2 Task State Transitions

```
RCSD: decomposed
       │
       ▼
status: pending, verification: null
       │
       ▼ (Planner selects)
status: active, verification.round: 1
       │
       ▼ (Agents iterate)
status: active, verification.gates: [updating]
       │
       ▼ (All gates pass)
status: done, verification.passed: true
```

---

## Part 10: Conformance

### 10.1 Conformance Requirements

A conforming implementation MUST:

- Implement all 7 agents as specified in Part 3
- Support the verification schema extension (Part 2)
- Implement all CLEO CLI extensions (Part 5)
- Follow the handoff protocol (Part 4)
- Support configuration options (Part 6)
- Use exit codes 40-49 for implementation errors

A conforming implementation SHOULD:

- Track observability metrics (Part 7)
- Implement error recovery commands (Part 8)
- Integrate with RCSD pipeline (Part 9)

A conforming implementation MAY:

- Use alternative subagent_type mappings with documented rationale
- Add additional verification gates beyond the required set
- Customize agent system prompts for project-specific needs

---

## Part 11: Epic Lifecycle Integration

### 11.1 Epic Lifecycle States

Epics have their own lifecycle independent of task statuses. The `epicLifecycle` field tracks the Epic's journey:

```json
{
  "epicLifecycle": {
    "type": ["string", "null"],
    "enum": ["backlog", "planning", "active", "review", "released", "archived", null],
    "default": null,
    "description": "Epic lifecycle state. Only applicable when type=epic."
  }
}
```

### 11.2 State Definitions

| State | Description | Trigger |
|-------|-------------|---------|
| `backlog` | Epic identified but not planned | Initial state |
| `planning` | RCSD pipeline in progress | `ct research` started |
| `active` | Implementation in progress | First task goes active |
| `review` | All tasks complete, awaiting release | All tasks `done` |
| `released` | Shipped in a release | `ct release ship` |
| `archived` | End of lifecycle | Manual or post-deprecation |

### 11.3 Epic Lifecycle State Machine

```
                    ┌───────────────────────────────────────────────────────────┐
                    │                    EPIC LIFECYCLE                          │
                    └───────────────────────────────────────────────────────────┘

                              ct add --type epic
                    ┌───────────┐ ─────────────────► ┌─────────────┐
                    │ (none)    │                    │   BACKLOG   │
                    └───────────┘                    └──────┬──────┘
                                                           │
                                            ct research TXXX (RCSD starts)
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │  PLANNING   │
                                                    └──────┬──────┘
                                                           │
                                            First task goes active
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │   ACTIVE    │◄────────────┐
                                                    └──────┬──────┘             │
                                                           │                    │
                                               All tasks done                   │
                                                           │              Bug found
                                                           ▼                    │
                                                    ┌─────────────┐             │
                                                    │   REVIEW    │─────────────┘
                                                    └──────┬──────┘
                                                           │
                                                    ct release ship
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │  RELEASED   │
                                                    └──────┬──────┘
                                                           │
                                                    ct epic archive
                                                           │
                                                           ▼
                                                    ┌─────────────┐
                                                    │  ARCHIVED   │
                                                    └─────────────┘
```

### 11.4 Automatic State Transitions

The following transitions happen automatically:

| Transition | Trigger | Condition |
|------------|---------|-----------|
| backlog → planning | `ct research TXXX` | Task is type=epic |
| planning → active | First child task status=active | At least one task active |
| active → review | Last task completed | All children status=done |
| review → released | `ct release ship vX.Y.Z` | Epic in release.epics[] |

### 11.5 Manual State Commands

```bash
# Set epic lifecycle manually
ct epic lifecycle T998 active

# Show epic lifecycle
ct show T998 --lifecycle

# List epics by lifecycle
ct list --type epic --lifecycle review

# Get epic ready for release
ct epic ready T998    # Validates all tasks done, moves to review
```

### 11.6 Implementation Orchestration Integration

The Planner Agent MUST check `epicLifecycle` when selecting tasks:

```python
def select_next_task(epic_id: str) -> Task:
    epic = get_task(epic_id)

    # Epic must be in planning or active state
    if epic.epicLifecycle not in ["planning", "active"]:
        raise InvalidEpicState(f"Epic {epic_id} is {epic.epicLifecycle}, not workable")

    # Get pending tasks in epic
    tasks = get_children(epic_id)
    pending_tasks = [t for t in tasks if t.status == "pending"]

    # Sort by phase, then wave, then priority
    pending_tasks.sort(key=lambda t: (
        phase_order(t.phase),
        compute_wave(t),
        priority_order(t.priority)
    ))

    if not pending_tasks:
        # All tasks done, transition epic to review
        update_epic_lifecycle(epic_id, "review")
        return None

    return pending_tasks[0]
```

### 11.7 Verification and Epic Lifecycle

When all tasks in an Epic have `verification.passed = true`:

1. Epic automatically transitions to `epicLifecycle = "review"`
2. Epic can be added to a release
3. On release ship, Epic transitions to `epicLifecycle = "released"`

```bash
# Check epic verification status
ct epic verify T998

# Output:
# Epic T998: Multi-Session Support
# Lifecycle: active
#
# Tasks: 15 total
#   Done:    14 (93%)
#   Active:   1 (7%)
#   Pending:  0
#
# Verification Gates:
#   All implemented: ✓ (14/14)
#   All tests pass:  ✓ (14/14)
#   All QA pass:     ✗ (13/14) - T1022 pending
#   All secure:      ✓ (14/14)
#   All documented:  ✗ (12/14) - T1020, T1021 pending
#
# Status: NOT READY for review
```

---

## Part 12: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[RCSD-PIPELINE-SPEC.md](RCSD-PIPELINE-SPEC.md)** | **Upstream**: Produces decomposed tasks for implementation |
| **[MULTI-SESSION-SPEC.md](MULTI-SESSION-SPEC.md)** | **Related**: Session management for concurrent implementation |
| **[CONSENSUS-FRAMEWORK-SPEC.md](CONSENSUS-FRAMEWORK-SPEC.md)** | **Pattern Source**: Multi-agent architecture patterns |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE**: JSON output and error handling |
| **[TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md)** | **Upstream**: Task atomicity criteria |
| **[RELEASE-MANAGEMENT-SPEC.md](RELEASE-MANAGEMENT-SPEC.md)** | **Downstream**: Releases aggregate completed Epics |
| **[ISSUE-LIFECYCLE-SPEC.md](ISSUE-LIFECYCLE-SPEC.md)** | **Related**: Bugs affecting Epic functionality |

---

## Appendix A: Quick Reference

### Agent Workflow

```
Planner → Coder → Testing → QA → Cleanup → Security → Docs
            ↑         │       │                │
            └─────────┴───────┴────────────────┘
                     (on failure)
```

### CLEO Commands for Agents

```bash
# Initialize
ct session start --scope epic:TXXX --auto-focus
ct verify TXXX --init

# Implementation
ct update TXXX --notes "Progress..."
ct verify TXXX --gate implemented --value true --agent coder

# Testing
ct verify TXXX --gate testsPassed --value true --agent testing

# Failure Loop
ct verify TXXX --gate testsPassed --value false --agent testing --reason "..."
ct verify TXXX --reset-downstream --from testsPassed

# Completion
ct verify TXXX --gate passed --value true
ct complete TXXX
```

### Verification Gates

| Gate | Agent | Required |
|------|-------|----------|
| `implemented` | Coder | Yes |
| `testsPassed` | Testing | Yes |
| `qaPassed` | QA | Yes |
| `cleanupDone` | Cleanup | No |
| `securityPassed` | Security | Yes |
| `documented` | Docs | Yes |

---

## Appendix B: Version History

### Version 1.1.0 (2025-12-29)

- Added Part 11: Epic Lifecycle Integration
- Added `epicLifecycle` schema field
- Defined epic state machine (backlog → planning → active → review → released → archived)
- Added automatic state transitions
- Added `ct epic lifecycle`, `ct epic verify`, `ct epic ready` commands
- Updated Related Specifications with Release and Issue specs

### Version 1.0.0 (2025-12-29)

- Initial specification
- 7-agent implementation orchestration architecture
- Task verification schema with gates
- Cyclical validation workflow
- CLEO CLI extensions for verification
- Exit codes 40-49
- Integration with RCSD Pipeline and Multi-Session specs

---

*End of Specification*
