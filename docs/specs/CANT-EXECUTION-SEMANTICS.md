# CANT Execution Semantics & Domain Event Protocol

**Version**: 1.0.0-draft
**Status**: Normative specification — companion to CANT-DSL-SPEC.md Section 7
**Author**: @cleo-historian (Canon), @cleo-core (Implementation)
**Date**: 2026-03-27
**Canonical Location**: `docs/specs/CANT-EXECUTION-SEMANTICS.md`
**Implementation**: `packages/core/src/cant/workflow-executor.ts`

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Conventions](#2-conventions)
3. [Sequential Execution](#3-sequential-execution)
4. [Parallel Execution](#4-parallel-execution)
5. [Session Blocking](#5-session-blocking)
6. [Approval Suspension](#6-approval-suspension)
7. [Error Propagation](#7-error-propagation)
   - 7.6 [Throw Statement Execution](#76-throw-statement-execution)
   - 7A. [Choice Execution](#7a-choice-execution)
   - 7B. [Reusable Block Execution](#7b-reusable-block-execution)
8. [Output Collection and Provenance](#8-output-collection-and-provenance)
9. [Generic Domain Event Protocol](#9-generic-domain-event-protocol)
10. [CLEO Domain Events (First Implementation)](#10-cleo-domain-events-first-implementation)
11. [CANT Event Syntax Integration](#11-cant-event-syntax-integration)
12. [Domain-to-Canon Mapping](#12-domain-to-canon-mapping)
13. [Implementation Requirements](#13-implementation-requirements)

---

## 1. Purpose and Scope

This document specifies formal execution semantics for the CANT workflow executor
(`packages/core/src/cant/workflow-executor.ts`) and defines the Generic Domain Event Protocol
that extends CAAMP's canonical event taxonomy from provider-only events to domain-sourced events.

### 1.1 Relationship to Existing Specifications

| Specification | Relationship |
|---|---|
| CANT-DSL-SPEC.md Section 7 | This document expands Section 7 with formal semantics |
| CANT-DSL-SPEC.md Section 5 | This document extends the CAAMP event table with domain events |
| CANT-DSL-SPEC.md Section 8 | Approval Token Protocol is referenced; suspension model is formalized here |
| CLEO-OPERATION-CONSTITUTION.md | Domain events map to the 10 canonical domains and CQRS gateways |
| VERB-STANDARDS.md | All operation references use canonical verbs |
| hook-mappings.json | Domain event additions to the canonical event taxonomy are specified here |

### 1.2 Canon Alignment

The execution model maps to CLEO's workshop vocabulary:

| Execution Semantic | Canon Concept | Domain Owner |
|---|---|---|
| Sequential execution | Warp — protocol chains holding Threads under tension | pipeline (The Weavers) |
| Parallel execution | Wave coordination by The Conductors | orchestrate (The Conductors) |
| Session blocking | The Hearth — terminal surface where sessions stay live | session (The Scribes) |
| Approval suspension | Crown Layer — human sovereignty over irreversible actions | Human-in-the-Loop |
| Error propagation | The Wardens — validation before crossing thresholds | check (The Wardens) |
| Output collection | Cascade artifacts feeding Tome and BRAIN | pipeline + memory (The Weavers + The Archivists) |

---

## 2. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

---

## 3. Sequential Execution

### 3.1 Definition

Sequential execution is the default execution mode for workflow bodies. Statements are
processed in source order. Each statement completes before the next begins.

### 3.2 Formal Model

```
FUNCTION execute_sequential(statements: Statement[], scope: ExecutionScope) -> ExecutionResult:

  FOR EACH statement IN statements IN SOURCE ORDER:
    1. PRE-STEP GATE (optional):
       - IF statement declares a `condition:` property:
         - Evaluate condition against current scope
         - IF false: record StepResult{success: true, skipped: true}, CONTINUE
       - IF a domain event listener is registered for the operation this step maps to:
         - Fire the pre-phase event (e.g., tasks:complete:pre)
         - IF the event handler returns block=true AND event.canBlock=true: HALT with E_GATE_BLOCKED

    2. DISPATCH:
       - Determine statement type via detectStatementType()
       - Dispatch to the appropriate handler (see Sections 4-6 for non-trivial handlers)
       - Record wall-clock duration

    3. POST-STEP:
       - Record StepResult with name, type, success, output, duration, error
       - IF step produced a CANT directive with an actionable verb:
         - Map directive to CQRS operation via the directive-to-operation table
         - Fire the corresponding domain event (post-phase)
       - IF step failed:
         - IF inside a try block: propagate to catch handler (see Section 7)
         - ELSE: set workflow success=false, BREAK sequential loop

    4. SCOPE UPDATE:
       - IF step produced output bindings, merge into current scope
       - IF step was a `let` binding, add to scope

  RETURN ExecutionResult{success, outputs, steps, duration}
```

### 3.3 Invariants

- **S-SEQ-1**: Statements MUST execute in source order. No reordering is permitted.
- **S-SEQ-2**: A statement MUST NOT begin execution until the preceding statement has completed.
- **S-SEQ-3**: Sequential failure halts the workflow unless inside a `try` block.
- **S-SEQ-4**: Each step MUST record a `StepResult` in the `steps[]` array, even if skipped.
- **S-SEQ-5**: Duration timing MUST use monotonic clock (not wall clock) where available.

### 3.4 Gate Verification Between Steps

When a workflow defines explicit lifecycle stage references (via `@stage` annotations or
frontmatter `lifecycle:` fields), the executor SHOULD verify that LOOM gate preconditions
are satisfied before each step that advances the lifecycle stage.

Gate verification is controlled by the project's lifecycle mode:

| Mode | Behavior |
|---|---|
| `strict` | Gate failure halts execution with exit code 80 |
| `advisory` | Gate failure emits a warning StepResult, execution continues |
| `off` | Gate verification is skipped |

---

## 4. Parallel Execution

### 4.1 Definition

Parallel blocks spawn multiple concurrent arms. The join strategy determines when the block
completes and how results are collected.

### 4.2 Join Strategies

| Strategy | CANT Syntax | Completion Condition | Failure Behavior |
|---|---|---|---|
| `all` (default) | `parallel:` | ALL arms complete | First failure fails the block |
| `race` | `parallel race:` | FIRST arm completes | Winner succeeds; losers are cancelled |
| `settle` | `parallel settle:` | ALL arms complete | Collects successes and failures separately |

### 4.3 Formal Model

```
FUNCTION execute_parallel(arms: ParallelArm[], strategy: JoinStrategy, parentScope: ExecutionScope) -> ParallelResult:

  1. ARM INITIALIZATION:
     - FOR EACH arm IN arms:
       - Create a child scope: childScope = createChildScope(parentScope)
       - Create an AbortController for the arm
       - IF arm declares `context: other_arm_name`:
         - Mark arm as DEPENDENT on other_arm_name
         - arm MUST NOT start until its dependency completes
         - The dependency's output is injected into the arm's child scope

  2. DEPENDENCY RESOLUTION:
     - Build a directed acyclic graph from context: declarations
     - Topologically sort arms into execution waves
     - Arms with no dependencies form Wave 0 (start immediately)
     - Arms depending on Wave 0 results form Wave 1, etc.
     - IF the graph contains a cycle: REJECT with validation error S-PAR-1

  3. EXECUTION:
     - FOR EACH wave IN topological order:
       - Launch all arms in the wave concurrently
       - Apply join strategy WITHIN each wave (not across waves)

  4. JOIN (per wave):

     STRATEGY all:
       - result = Promise.all(wave arms)
       - IF any arm rejects: signal abort to remaining arms, fail the block
       - Bind all arm outputs to parent scope by arm name

     STRATEGY race:
       - result = Promise.race(wave arms)
       - Signal abort to all non-winning arms
       - Bind ONLY the winner's output to parent scope
       - Record non-winning arms as StepResult{success: true, cancelled: true}

     STRATEGY settle:
       - results = Promise.allSettled(wave arms)
       - Partition into successes[] and failures[]
       - Bind successful arm outputs to parent scope
       - Block success = (failures.length === 0)
       - ALWAYS return SettleResult{successes, failures}

  5. SCOPE MERGE:
     - After ALL waves complete, merge final arm outputs into parent scope
     - Arm name collisions across waves: later wave OVERWRITES earlier wave

  RETURN ParallelResult{success, results, steps, settleResult?}
```

### 4.4 Cancellation Protocol

- **S-PAR-2**: When a `race` strategy determines a winner, the executor MUST signal cancellation to all remaining arms via `AbortController.abort()`.
- **S-PAR-3**: Arm implementations SHOULD check `signal.aborted` at yield points (before session dispatch, before pipeline step execution, before discretion evaluation).
- **S-PAR-4**: A cancelled arm MUST be recorded as `StepResult{success: true, cancelled: true}`. Cancellation is not failure.
- **S-PAR-5**: When an `all` strategy arm fails, the executor MUST signal cancellation to all remaining arms before returning the failure.

### 4.5 Arm-to-Arm Dependencies

The `context:` property on a parallel arm creates a data dependency:

```cant
parallel:
  research = session "Analyze auth bugs"
  fixes = session "Write auth patches"
    context: research
```

In this example:
- `research` starts immediately (Wave 0)
- `fixes` waits for `research` to complete (Wave 1)
- `fixes` receives `research`'s output in its child scope
- The join strategy applies per-wave, not across waves

### 4.6 Invariants

- **S-PAR-1**: The arm dependency graph MUST be acyclic. Circular `context:` references are a validation error.
- **S-PAR-6**: Maximum concurrent arms per block is configurable (default: 32, rule W09).
- **S-PAR-7**: Arm names MUST be unique within a parallel block (rule S07/W02).

---

## 5. Session Blocking

### 5.1 Definition

A `session` statement in a CANT workflow invokes the CLEO session machinery. The workflow
executor MUST block until the session completes or times out.

### 5.2 Formal Model

```
FUNCTION execute_session(statement: SessionStmt, scope: ExecutionScope, ctx: WorkflowContext) -> StepResult:

  1. TARGET RESOLUTION:
     - IF statement.target is Prompt (string):
       - prompt = evaluateExpression(statement.target.prompt, scope)
       - session_target = { type: "prompt", prompt }
     - IF statement.target is Agent (name):
       - agent = resolveAgent(statement.target.agent, scope)
       - session_target = { type: "agent", agentId: agent.id }

  2. CONTEXT INJECTION:
     - IF statement declares `context:` property:
       - Resolve context references against the current scope
       - Build a context payload from resolved values
       - These become the session's initial variables

  3. SESSION DISPATCH:
     - Determine transport mode:
       a. Local agent target: dispatch via SignalDock Local daemon
       b. Remote agent target: dispatch via SignalDock Cloud (api.signaldock.io)
       c. Prompt target (no agent): dispatch to CLEO session.start

     - Create child session:
       - mutate session.start { scope: workflow.currentTaskRef, parentSessionId: ctx.sessionId }
       - Inject context payload into child session

     - BLOCK:
       - The workflow executor yields control
       - Execution suspends until the child session reaches a terminal state:
         a. session.end — session completed normally
         b. session timeout — configurable, default 1 hour
         c. session.suspend — session was suspended (treated as incomplete)

  4. RESULT COLLECTION:
     - Extract session output from the child session's handoff data
     - IF statement has a binding name (e.g., `result = session "..."`)
       - Bind session output to the name in parent scope

  5. RETURN:
     - success: true if session ended normally
     - output: session handoff data
     - error: timeout message or session error if applicable

  ON TIMEOUT:
     - Record StepResult{success: false, error: "Session timed out after {duration}"}
     - The executor MUST NOT kill the child session — it persists independently
     - The workflow proceeds to error handling (Section 7)
```

### 5.3 SignalDock Transport Selection

Session dispatch MUST respect the dual-mode SignalDock architecture:

| Target | Transport | Rationale |
|---|---|---|
| Local agent (same machine) | SignalDock Local daemon | No cloud dependency; lowest latency |
| Remote agent (cross-machine) | SignalDock Cloud (api.signaldock.io) | NEXUS-routed via Conduit |
| Prompt (no agent) | CLEO session machinery directly | No relay needed |

The `ConduitClient` in `packages/core/src/conduit/conduit-client.ts` abstracts transport
selection. The `HttpTransport` in `packages/core/src/conduit/http-transport.ts` handles both
local and cloud endpoints.

### 5.4 Invariants

- **S-SES-1**: A session statement MUST block the workflow until the session reaches a terminal state.
- **S-SES-2**: The child session MUST inherit the parent workflow's task references for provenance.
- **S-SES-3**: Session dispatch MUST use Conduit for agent targets, never direct function call.
- **S-SES-4**: Session timeout MUST NOT kill the child session. The session persists independently.
- **S-SES-5**: Session output MUST be available for binding in the parent scope after completion.

---

## 6. Approval Suspension

### 6.1 Definition

An `approve:` gate suspends workflow execution until a human or authorized agent provides
explicit approval via a `/approve {token}` CANT directive. This is the Crown Layer asserting
sovereignty over irreversible actions.

### 6.2 Formal Model

```
FUNCTION execute_approval_gate(statement: ApprovalGate, scope: ExecutionScope, ctx: WorkflowContext) -> StepResult:

  1. TOKEN GENERATION:
     - message = evaluateExpression(statement.message, scope)
     - expires = statement.expires ?? "24h"
     - workflowHash = SHA-256(serialize(ctx.currentWorkflow))
     - token = ApprovalManager.generateToken(
         sessionId: ctx.sessionId,
         workflowName: ctx.workflowName,
         gateName: statement.label ?? "approval-gate",
         message: message,
         workflowHash: workflowHash,
         requestedBy: ctx.agentId,
         expiresInMs: parseDuration(expires)
       )

  2. STATE SERIALIZATION:
     - Capture suspended state:
       suspendedState = {
         statementIndex: current index in workflow.body,
         scope: serializeScope(scope),
         outputs: current outputs record,
         steps: steps collected so far,
         workflowHash: workflowHash,
         tokenId: token.token
       }
     - Persist to session: UPDATE sessions SET
         approvalTokensJson = appendToken(approvalTokensJson, token),
         suspendedWorkflowState = JSON.stringify(suspendedState),
         status = 'suspended'
       WHERE id = ctx.sessionId

  3. NOTIFICATION:
     - Emit CANT directive via Conduit:
       /review @human "{message}. Approve with: /approve {token.token}"
     - Fire domain event: ApprovalRequested (see Section 10)

  4. SUSPENSION:
     - The workflow executor MUST halt
     - It MUST NOT poll, spin, or sleep
     - Control returns to the caller with a partial ExecutionResult:
       { success: null, suspended: true, tokenId: token.token, steps: [...] }

  5. RESUMPTION (triggered externally by /approve {token}):
     - Validate token via ApprovalManager.validateToken(tokenId, sessionId, currentWorkflowHash)
     - IF valid:
       a. Transition token: pending -> approved (atomic CAS)
       b. Load suspendedWorkflowState from session
       c. Deserialize scope, outputs, steps
       d. Resume execution from statementIndex + 1
       e. Fire domain event: ApprovalGranted
     - IF invalid:
       a. Return validation error to the approver
       b. Workflow remains suspended

  6. TIMEOUT:
     - IF token expires while workflow is suspended:
       a. Transition token: pending -> expired (atomic CAS)
       b. Emit CANT directive via Conduit:
         /blocked @{ctx.agentId} "Approval token expired for gate '{gateName}'"
       c. Fire domain event: ApprovalExpired
       d. Workflow transitions from suspended to blocked
```

### 6.3 Invariants

- **S-APR-1**: The executor MUST persist the complete workflow state before suspension.
- **S-APR-2**: The executor MUST NOT poll or spin while suspended. Resumption is event-driven.
- **S-APR-3**: Token validation MUST verify workflowHash for TOCTOU protection.
- **S-APR-4**: Expired tokens MUST emit a `/blocked` directive, not silently fail.
- **S-APR-5**: Token values MUST NOT appear in audit logs, session summaries, or error messages.
- **S-APR-6**: Approval tokens are scoped to their originating session. Cross-session approval is invalid.

---

## 7. Error Propagation

### 7.1 Error Classification

Errors in CANT workflow execution fall into three categories with distinct propagation rules:

| Category | Description | Catch-able | Propagation |
|---|---|---|---|
| **Recoverable** | Statement failures, pipeline exit codes, session errors | YES | Caught by `try/catch`, or halts sequential execution |
| **Suspension** | Approval gates, session timeouts requiring external intervention | NO | Leaves the workflow domain entirely; cannot be caught |
| **Fatal** | Resource exhaustion (W08-W11), security violations (P06-P07), scope errors | NO | Immediately terminates the workflow with a diagnostic |

### 7.2 Recoverable Error Propagation

```
FUNCTION propagate_recoverable(error: Error, context: ErrorContext):

  1. IF inside a try block:
     - Halt try_body execution at the failing statement
     - IF catch clause exists:
       a. Create catch scope with error bound to catch variable name
       b. Execute catch_body statements sequentially
       c. IF catch_body succeeds: the try/catch block succeeds
       d. IF catch_body fails: propagate the NEW error upward
     - IF finally clause exists:
       a. Execute finally_body statements regardless of try/catch outcome
       b. finally errors DO NOT mask the original error
     - The try/catch/finally block's success = try succeeded OR catch recovered

  2. IF NOT inside a try block:
     - Record StepResult{success: false, error: error.message}
     - Set workflow success = false
     - Break sequential execution
     - Return partial ExecutionResult
```

### 7.3 Error Context by Statement Type

| Statement Type | Error Source | StepResult.error Content |
|---|---|---|
| Pipeline step | Non-zero exit code | `"Pipeline step '{name}' exited with code {code}: {stderr}"` |
| Session | Session timeout or failure | `"Session '{target}' failed: {reason}"` or `"Session timed out after {duration}"` |
| Discretion | Evaluator failure (not false result) | `"Discretion evaluation failed: {reason}"` |
| Directive | CQRS operation failure | `"Directive /{verb} failed: {lafs_error.message} (code {lafs_error.code})"` |
| Parallel arm | Arm-level failure | `"Parallel arm '{name}' failed: {reason}"` |
| Binding | Expression evaluation error | `"Failed to evaluate binding '{name}': {reason}"` |

### 7.4 Suspension vs. Recoverable Distinction

A `try` block MUST NOT catch suspension events:

```cant
# This is correct CANT — but the try does NOT catch the approval suspension
workflow deploy:
  try:
    session "Prepare deployment"
    approve:
      message: "Deploy to production?"
    # ^ This suspends the ENTIRE workflow, not just the try block
    session "Execute deployment"
  catch err:
    /blocked @lead "Deployment failed: ${err}"
```

The `approve:` gate suspends the workflow. If the approval is later rejected, the workflow
transitions to failed state — it does NOT resume into the catch block. The catch block
handles recoverable errors from the session or pipeline steps, not suspension outcomes.

### 7.5 Invariants

- **S-ERR-1**: Recoverable errors MUST be catch-able by `try/catch`.
- **S-ERR-2**: Suspension events MUST NOT be catch-able. They exit the workflow domain.
- **S-ERR-3**: Fatal errors MUST terminate the workflow immediately with a diagnostic.
- **S-ERR-4**: `finally` blocks MUST execute regardless of try/catch outcome.
- **S-ERR-5**: `finally` errors MUST NOT mask the original error. Both are recorded.
- **S-ERR-6**: A false discretion result is NOT an error. It is a `false` condition.

### 7.6 Throw Statement Execution

```
FUNCTION execute_throw(statement: ThrowStmt, scope: ExecutionScope) -> NEVER:

  1. EVALUATE:
     - IF statement.value is present:
       - error_value = evaluateExpression(statement.value, scope)
     - ELSE:
       - error_value = "Workflow error (no message)"

  2. PROPAGATE:
     - Create CantError { message: error_value, source: "throw", span: statement.span }
     - Propagate as a recoverable error (Section 7.2)
     - IF inside a try block: caught by catch clause
     - IF NOT inside a try block: halts the workflow

  3. INVARIANTS:
     - Throw is ONLY permitted in workflow bodies, NEVER in pipelines (P08)
     - The error value is available as the catch variable binding
```

---

## 7A. Choice Execution

### 7A.1 Definition

A `choice` block presents N named options to the AI evaluator and lets it select the
best one based on the discretion criteria. Unlike `if/elif` which evaluates serial boolean
conditions, `choice` is a single-shot multi-option decision.

### 7A.2 Formal Model

```
FUNCTION execute_choice(block: ChoiceBlock, scope: ExecutionScope, ctx: WorkflowContext) -> StepResult:

  1. BUILD EVALUATION CONTEXT:
     - criteria_prose = block.criteria.prose
     - option_labels = block.options.map(o => o.label)
     - context_payload = {
         criteria: criteria_prose,
         options: option_labels,
         scope_variables: extractVisibleBindings(scope)
       }

  2. EVALUATE:
     - selected = ctx.discretionEvaluator.selectOption(criteria_prose, option_labels, context_payload)
     - The evaluator MUST return exactly one label from option_labels
     - IF evaluator returns a label not in option_labels: REJECT with error
     - IF evaluator returns multiple labels: REJECT with error

  3. EXECUTE SELECTED BRANCH:
     - Find the ChoiceOption where label == selected
     - Execute the option's body statements sequentially (Section 3)

  4. RECORD:
     - StepResult includes: selected_option, criteria_prose, available_options

  RETURN StepResult{success, output, selectedOption: selected}
```

### 7A.3 Discretion Evaluator Interface Extension

The `DiscretionEvaluator` interface gains a new method:

```typescript
interface DiscretionEvaluator {
  /** Evaluate a boolean condition (existing). */
  evaluate(condition: string, context: DiscretionContext): Promise<boolean>;
  /** Select one option from N alternatives (new). */
  selectOption(criteria: string, options: string[], context: DiscretionContext): Promise<string>;
}
```

### 7A.4 Invariants

- **S-CHO-1**: A choice block MUST contain at least 2 options (W12).
- **S-CHO-2**: The evaluator MUST return exactly one label from the provided options.
- **S-CHO-3**: Choice blocks are forbidden in pipelines (P02 — contains discretion).
- **S-CHO-4**: Option labels MUST be unique within a choice block.

---

## 7B. Reusable Block Execution

### 7B.1 Definition

A `block` definition creates a reusable group of statements callable by name. Blocks
inherit the caller's scope and execute their body in that scope. They are CANT's
equivalent of a function/macro.

### 7B.2 Formal Model

```
FUNCTION execute_block_call(call: BlockCall, scope: ExecutionScope, ctx: WorkflowContext) -> StepResult:

  1. RESOLVE BLOCK:
     - block_def = resolveBlock(call.name, scope)
     - IF not found: REJECT with error S01 (unresolved reference)

  2. BIND ARGUMENTS:
     - IF call.args.length != block_def.params.length:
       - REJECT with error "Block '{name}' expects {expected} arguments, got {actual}"
     - Create child scope from caller's scope
     - FOR EACH (param, arg) IN zip(block_def.params, call.args):
       - value = evaluateExpression(arg, scope)
       - childScope.bind(param.name, value)

  3. EXECUTE BODY:
     - result = execute_sequential(block_def.body, childScope)
     - Block body follows all sequential execution rules (Section 3)

  4. SCOPE MERGE:
     - Bindings created inside the block body are NOT visible to the caller
     - Only the StepResult (success, error) propagates back

  RETURN result
```

### 7B.3 Invariants

- **S-BLK-1**: Block names MUST be unique within a file (S05).
- **S-BLK-2**: Block bodies MUST NOT contain `output` bindings (W13).
- **S-BLK-3**: Block definitions are visible to all statements after the definition in the same scope.
- **S-BLK-4**: Recursive block calls are permitted but MUST respect the nesting depth limit (W11).
- **S-BLK-5**: Block arguments are evaluated in the caller's scope, not the block's scope.

---

## 8. Output Collection and Provenance

### 8.1 Definition

Workflow outputs are the Cascade's final artifacts. They feed the pipeline manifest and
BRAIN observations for durable knowledge capture.

### 8.2 Output Binding

`output` statements in a workflow declare named result values:

```cant
workflow review(pr_url):
  # ... execution ...
  output verdict = "approve"
  output confidence = 0.92
```

### 8.3 Output Record Structure

```typescript
interface WorkflowOutput {
  /** Output name from the `output name = expr` statement. */
  name: string;
  /** Evaluated output value. */
  value: unknown;
  /** Provenance metadata. */
  provenance: {
    /** The workflow that produced this output. */
    workflowName: string;
    /** The step index that produced this output. */
    stepIndex: number;
    /** The session ID of the execution context. */
    sessionId: string;
    /** The agent that executed the workflow. */
    agentId: string;
    /** Task references in scope at output time. */
    taskRefs: string[];
    /** ISO 8601 timestamp of output production. */
    timestamp: string;
    /** LOOM lifecycle stage if applicable. */
    lifecycleStage?: string;
  };
}
```

### 8.4 Manifest Integration

After a workflow completes, the executor SHOULD append a manifest entry to `MANIFEST.jsonl`
via `mutate pipeline.manifest.append`:

```json
{
  "type": "workflow-output",
  "workflowName": "review",
  "outputs": {
    "verdict": "approve",
    "confidence": 0.92
  },
  "taskId": "T1234",
  "sessionId": "ses_abc123",
  "agentId": "cleo-core",
  "timestamp": "2026-03-27T14:00:00Z",
  "duration": 45200,
  "steps": 7,
  "success": true
}
```

This is the bridge from Cascade to Tome — workflow results become manifest artifacts that
can be distilled into BRAIN observations during session.end or manual distillation.

### 8.5 ExecutionResult Structure

```typescript
interface ExecutionResult {
  /** Whether the workflow completed without errors. */
  success: boolean;
  /** Whether the workflow is suspended (approval gate pending). */
  suspended?: boolean;
  /** The approval token ID if suspended. */
  tokenId?: string;
  /** Named output bindings with provenance. */
  outputs: Record<string, WorkflowOutput>;
  /** Step results in execution order. */
  steps: StepResult[];
  /** Total wall-clock duration in milliseconds. */
  duration: number;
  /** Manifest-compatible entry for pipeline.manifest.append. */
  manifestEntry?: ManifestEntry;
}
```

### 8.6 Invariants

- **S-OUT-1**: Every `output` statement MUST produce a `WorkflowOutput` with provenance metadata.
- **S-OUT-2**: Workflow completion SHOULD append a manifest entry to `MANIFEST.jsonl`.
- **S-OUT-3**: Provenance MUST include taskRefs, sessionId, agentId, and timestamp.
- **S-OUT-4**: Output values are immutable after binding. Subsequent outputs with the same name MUST NOT overwrite.

---

## 9. Generic Domain Event Protocol

### 9.1 Purpose

CAAMP's canonical event taxonomy (Section 5 of CANT-DSL-SPEC.md) currently defines 16
provider-sourced events. These events originate from AI coding tool providers (Claude Code,
Cursor, Gemini CLI, etc.) and describe lifecycle moments in the provider's runtime.

The Generic Domain Event Protocol extends this taxonomy to support **domain-sourced events**:
events that originate from application-level systems (CLEO, SignalDock, third-party integrations)
rather than from providers.

### 9.2 Analogy: HTTP and REST

The relationship between the Generic Domain Event Protocol and CLEO Domain Events is analogous
to the relationship between HTTP and REST:

- **HTTP** defines verbs (GET, POST, PUT) as a generic protocol
- **REST** is the first major implementation pattern on HTTP
- You do not pick one — REST uses HTTP

Similarly:

- **Layer 1 — Generic Domain Event Protocol** defines the framework:
  naming convention, payload structure, registration mechanism
- **Layer 2 — CLEO Domain Events** is the first implementation:
  CLEO registers as a domain source and declares its events

### 9.3 Event Source Types

| Source Type | Origin | Examples | Existing |
|---|---|---|---|
| `provider` | AI coding tool runtime | PreToolUse, SessionStart, SubagentStop | YES (16 events) |
| `domain` | Application-level system | TaskCompleted, MemoryObserved, PipelineStageCompleted | NEW |

### 9.4 Event Naming Convention

All events use **PascalCase** names. This is the CANT-facing identifier used in `on Event:` blocks.

Behind each domain event, the **D:O:P pattern** (Domain:Operation:Phase) provides machine-readable
metadata that explains what triggered the event and enables programmatic event generation:

```
D:O:P = {domain}:{operation}:{phase}

domain    = one of the 10 canonical CLEO domains (tasks, session, memory, ...)
operation = the canonical verb from VERB-STANDARDS.md (complete, add, observe, ...)
phase     = "pre" | "post"
```

The D:O:P pattern is **metadata**, not the event name. It is stored in the event definition's
`operationMapping` and used for:
- Programmatic event generation from CQRS operations
- Reverse lookups (given a CQRS operation, which domain events fire?)
- Registration of new domain sources without code changes

The human-facing name stays PascalCase for CANT consistency.

### 9.5 Event Definition Schema

```typescript
interface DomainEventDefinition {
  /** PascalCase event name used in CANT `on Event:` blocks. */
  name: string;
  /** Event category for filtering and grouping. */
  category: string;
  /** Event source type. */
  source: "provider" | "domain";
  /** Whether a hook handler can block the associated action. */
  canBlock: boolean;
  /** Human-readable description. */
  description: string;
  /** D:O:P mapping metadata (domain events only). */
  operationMapping?: {
    /** The canonical domain (tasks, session, memory, etc.). */
    domain: string;
    /** The canonical operation verb (complete, add, observe, etc.). */
    operation: string;
    /** Pre or post phase. */
    phase: "pre" | "post";
  };
}
```

### 9.6 Domain Source Registration Schema

A domain source declares which system is emitting events and what events it provides:

```typescript
interface DomainSource {
  /** Semver version of the domain source declaration. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Event categories this source emits. */
  categories: string[];
  /** Map of PascalCase event names to their D:O:P metadata. */
  operationMapping: Record<string, {
    domain: string;
    operation: string;
    phase: "pre" | "post";
  }>;
}
```

### 9.7 hook-mappings.json Schema Extension

The existing `hook-mappings.json` gains two additions:

1. Each `canonicalEvents` entry gains a `source` field (`"provider"` or `"domain"`)
2. A new top-level `domainSources` section registers domain event sources

```json
{
  "canonicalEvents": {
    "PreToolUse": {
      "category": "tool",
      "source": "provider",
      "canBlock": true,
      "description": "Before a tool call executes (can block/modify)"
    },
    "TaskCompleted": {
      "category": "task",
      "source": "domain",
      "canBlock": false,
      "description": "A CLEO task has been marked complete via tasks.complete"
    }
  },
  "providerMappings": { },
  "domainSources": {
    "cleo": {
      "version": "1.0.0",
      "description": "CLEO task management and memory system",
      "categories": ["task", "memory", "pipeline", "session"],
      "operationMapping": {
        "TaskCompleted":           { "domain": "tasks",    "operation": "complete", "phase": "post" },
        "TaskCreated":             { "domain": "tasks",    "operation": "add",      "phase": "post" },
        "TaskStarted":             { "domain": "tasks",    "operation": "start",    "phase": "post" },
        "TaskBlocked":             { "domain": "tasks",    "operation": "update",   "phase": "post" },
        "MemoryObserved":          { "domain": "memory",   "operation": "observe",  "phase": "post" },
        "MemoryPatternStored":     { "domain": "memory",   "operation": "store",    "phase": "post" },
        "MemoryLearningStored":    { "domain": "memory",   "operation": "store",    "phase": "post" },
        "MemoryDecisionStored":    { "domain": "memory",   "operation": "store",    "phase": "post" },
        "PipelineStageCompleted":  { "domain": "pipeline", "operation": "validate", "phase": "post" },
        "PipelineManifestAppended":{ "domain": "pipeline", "operation": "append",   "phase": "post" },
        "SessionStarted":          { "domain": "session",  "operation": "start",    "phase": "post" },
        "SessionEnded":            { "domain": "session",  "operation": "end",      "phase": "post" },
        "ApprovalRequested":       { "domain": "session",  "operation": "suspend",  "phase": "post" },
        "ApprovalGranted":         { "domain": "session",  "operation": "resume",   "phase": "post" },
        "ApprovalExpired":         { "domain": "session",  "operation": "suspend",  "phase": "post" }
      }
    }
  }
}
```

### 9.8 Extensibility

The `domainSources` section is designed for future domain sources beyond CLEO:

```json
{
  "domainSources": {
    "cleo": { },
    "signaldock": {
      "version": "1.0.0",
      "description": "SignalDock agent communication service",
      "categories": ["conduit", "relay"],
      "operationMapping": {
        "MessageReceived":    { "domain": "conduit",  "operation": "receive", "phase": "post" },
        "MessageDelivered":   { "domain": "conduit",  "operation": "deliver", "phase": "post" },
        "AgentConnected":     { "domain": "relay",    "operation": "connect", "phase": "post" },
        "AgentDisconnected":  { "domain": "relay",    "operation": "disconnect", "phase": "post" }
      }
    }
  }
}
```

### 9.9 Invariants

- **S-EVT-1**: All events MUST have PascalCase names for CANT `on Event:` block consistency.
- **S-EVT-2**: The D:O:P pattern is metadata, not the event name. Agents and `.cant` files never reference D:O:P directly.
- **S-EVT-3**: Domain events MUST use canonical verbs from VERB-STANDARDS.md in their `operation` field.
- **S-EVT-4**: Domain events with `source: "domain"` MUST NOT appear in `providerMappings`. They are not provider-native events.
- **S-EVT-5**: Existing provider events (`source: "provider"`) MUST NOT be modified by this extension. The 16 provider events are unchanged.
- **S-EVT-6**: The `domainSources` section MUST be additive. Adding a new domain source MUST NOT change any existing event definition.

---

## 10. CLEO Domain Events (First Implementation)

### 10.1 Event Taxonomy

CLEO registers as the first domain source. Its events map to CQRS operations across four
of the ten canonical domains:

#### 10.1.1 Task Events (The Smiths)

| Event | Fires When | D:O:P | canBlock |
|---|---|---|---|
| `TaskCreated` | `mutate tasks.add` succeeds | `tasks:add:post` | false |
| `TaskStarted` | `mutate tasks.start` succeeds | `tasks:start:post` | false |
| `TaskCompleted` | `mutate tasks.complete` succeeds | `tasks:complete:post` | false |
| `TaskBlocked` | `mutate tasks.update` sets status=blocked | `tasks:update:post` | false |

#### 10.1.2 Memory Events (The Archivists)

| Event | Fires When | D:O:P | canBlock |
|---|---|---|---|
| `MemoryObserved` | `mutate memory.observe` succeeds | `memory:observe:post` | false |
| `MemoryPatternStored` | `mutate memory.pattern.store` succeeds | `memory:store:post` | false |
| `MemoryLearningStored` | `mutate memory.learning.store` succeeds | `memory:store:post` | false |
| `MemoryDecisionStored` | `mutate memory.decision.store` succeeds | `memory:store:post` | false |

#### 10.1.3 Pipeline Events (The Weavers)

| Event | Fires When | D:O:P | canBlock |
|---|---|---|---|
| `PipelineStageCompleted` | Lifecycle gate passes validation | `pipeline:validate:post` | false |
| `PipelineManifestAppended` | `mutate pipeline.manifest.append` succeeds | `pipeline:append:post` | false |

#### 10.1.4 Session Events (The Scribes)

| Event | Fires When | D:O:P | canBlock |
|---|---|---|---|
| `SessionStarted` | `mutate session.start` succeeds | `session:start:post` | false |
| `SessionEnded` | `mutate session.end` succeeds | `session:end:post` | false |
| `ApprovalRequested` | Workflow approval gate suspends | `session:suspend:post` | false |
| `ApprovalGranted` | `/approve {token}` resumes workflow | `session:resume:post` | false |
| `ApprovalExpired` | Approval token expires | `session:suspend:post` | false |

### 10.2 Event Payload Structure

All domain events carry a payload conforming to the LAFS envelope:

```typescript
interface DomainEventPayload {
  /** The PascalCase event name. */
  event: string;
  /** Event source identifier. */
  source: string;
  /** D:O:P metadata. */
  dop: {
    domain: string;
    operation: string;
    phase: "pre" | "post";
  };
  /** Event-specific data. */
  data: Record<string, unknown>;
  /** ISO 8601 timestamp of event emission. */
  timestamp: string;
  /** Session ID if applicable. */
  sessionId?: string;
  /** Agent ID that triggered the event. */
  agentId?: string;
  /** Task references involved. */
  taskRefs?: string[];
}
```

### 10.3 Event Emission Points

Domain events are emitted at the **core business logic layer** (`packages/core/src/`), not at
the dispatch or adapter layer. This ensures events fire regardless of whether the operation
was triggered via MCP, CLI, or direct API call.

```
User Input
  -> CLI / MCP Adapter
    -> Dispatch
      -> Core Business Logic
        -> [EMIT domain event here]   <-- fires inside core
        -> Store Layer
```

---

## 11. CANT Event Syntax Integration

### 11.1 Unified Syntax

In CANT, provider events and domain events use the SAME `on Event:` syntax:

```cant
---
kind: agent
version: 1
---

agent ops-lead:
  model: opus

  # Provider event (existing — source: provider)
  on PreToolUse:
    if tool.name == "dangerous-tool":
      deny "This tool is not permitted"
    else:
      allow

  # Domain event (new — source: domain, same syntax)
  on TaskCompleted:
    /checkin @lead "Task done"
    session "Update sprint board"

  # Domain event (memory)
  on MemoryObserved:
    /info @all "New observation recorded"
```

### 11.2 Domain Event Context Variables

Within a domain event hook body, event-specific context variables are available:

| Variable | Available In | Type | Description |
|---|---|---|---|
| `event.name` | All domain events | string | PascalCase event name |
| `event.source` | All domain events | string | Domain source identifier |
| `event.dop` | All domain events | object | D:O:P metadata |
| `task` | Task events | object | The task that triggered the event |
| `task.id` | Task events | string | Task ID (e.g., "T1234") |
| `task.title` | Task events | string | Task title |
| `task.status` | Task events | string | New task status |
| `memory` | Memory events | object | The memory entry that triggered the event |
| `memory.id` | Memory events | string | Observation/pattern/learning/decision ID |
| `memory.type` | Memory events | string | Memory type (observation, pattern, learning, decision) |
| `pipeline` | Pipeline events | object | Pipeline context |
| `pipeline.stage` | Pipeline events | string | Current lifecycle stage |
| `session` | Session events | object | Session context |
| `approval` | Approval events | object | Approval token metadata (NOT the token value) |
| `approval.gateName` | Approval events | string | The approval gate label |
| `approval.message` | Approval events | string | The approval message |

### 11.3 Validation Rule Extension

Rule S06/H01 MUST be extended to accept domain event names in addition to the existing 16
provider event names.

The valid event name set becomes: the 16 provider events PLUS all events registered in
`hook-mappings.json` `canonicalEvents` with `source: "domain"`.

Updated diagnostic for S06/H01:

```
S06: Unknown event '{event}' at line {line}. Must be one of the canonical events
defined in hook-mappings.json (16 provider events + registered domain events).
```

### 11.4 CanonicalEvent Rust Enum Extension

The `CanonicalEvent` enum in `cant-core` (Section 3.5 of CANT-DSL-SPEC.md) MUST be extended:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CanonicalEvent {
    // Provider events (existing 16)
    SessionStart,
    SessionEnd,
    PromptSubmit,
    ResponseComplete,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    SubagentStart,
    SubagentStop,
    PreModel,
    PostModel,
    PreCompact,
    PostCompact,
    Notification,
    ConfigChange,

    // CLEO domain events (task)
    TaskCreated,
    TaskStarted,
    TaskCompleted,
    TaskBlocked,

    // CLEO domain events (memory)
    MemoryObserved,
    MemoryPatternStored,
    MemoryLearningStored,
    MemoryDecisionStored,

    // CLEO domain events (pipeline)
    PipelineStageCompleted,
    PipelineManifestAppended,

    // CLEO domain events (session)
    SessionStarted,
    SessionEnded,
    ApprovalRequested,
    ApprovalGranted,
    ApprovalExpired,
}
```

### 11.5 TypeScript Types Extension

The `CANONICAL_HOOK_EVENTS` tuple in `packages/caamp/src/core/hooks/types.ts` and the
`HOOK_CATEGORIES` tuple MUST be extended:

```typescript
export const HOOK_CATEGORIES = [
  'session', 'prompt', 'tool', 'agent', 'context',
  // Domain event categories
  'task', 'memory', 'pipeline'
] as const;

export const CANONICAL_HOOK_EVENTS = [
  // ... existing 16 provider events ...
  // CLEO domain events
  'TaskCreated', 'TaskStarted', 'TaskCompleted', 'TaskBlocked',
  'MemoryObserved', 'MemoryPatternStored', 'MemoryLearningStored', 'MemoryDecisionStored',
  'PipelineStageCompleted', 'PipelineManifestAppended',
  'SessionStarted', 'SessionEnded',
  'ApprovalRequested', 'ApprovalGranted', 'ApprovalExpired',
] as const;
```

---

## 12. Domain-to-Canon Mapping

Complete cross-reference from CLEO CQRS operations to domain events to CANT syntax:

| CQRS Operation | Domain Event | CANT Hook | Circle House |
|---|---|---|---|
| `mutate tasks.add` | `TaskCreated` | `on TaskCreated:` | The Smiths |
| `mutate tasks.start` | `TaskStarted` | `on TaskStarted:` | The Smiths |
| `mutate tasks.complete` | `TaskCompleted` | `on TaskCompleted:` | The Smiths |
| `mutate tasks.update` (blocked) | `TaskBlocked` | `on TaskBlocked:` | The Smiths |
| `mutate memory.observe` | `MemoryObserved` | `on MemoryObserved:` | The Archivists |
| `mutate memory.pattern.store` | `MemoryPatternStored` | `on MemoryPatternStored:` | The Archivists |
| `mutate memory.learning.store` | `MemoryLearningStored` | `on MemoryLearningStored:` | The Archivists |
| `mutate memory.decision.store` | `MemoryDecisionStored` | `on MemoryDecisionStored:` | The Archivists |
| `mutate pipeline.stage.validate` | `PipelineStageCompleted` | `on PipelineStageCompleted:` | The Weavers |
| `mutate pipeline.manifest.append` | `PipelineManifestAppended` | `on PipelineManifestAppended:` | The Weavers |
| `mutate session.start` | `SessionStarted` | `on SessionStarted:` | The Scribes |
| `mutate session.end` | `SessionEnded` | `on SessionEnded:` | The Scribes |
| Approval gate fires | `ApprovalRequested` | `on ApprovalRequested:` | The Scribes |
| `/approve {token}` accepted | `ApprovalGranted` | `on ApprovalGranted:` | The Scribes |
| Token expiration | `ApprovalExpired` | `on ApprovalExpired:` | The Scribes |

---

## 13. Implementation Requirements

### 13.1 Files to Modify

| File | Change |
|---|---|
| `packages/caamp/providers/hook-mappings.json` | Add `source` field to existing events, add `domainSources` section, add domain events to `canonicalEvents` |
| `packages/caamp/src/core/hooks/types.ts` | Extend `HOOK_CATEGORIES` and `CANONICAL_HOOK_EVENTS` tuples, add `DomainEventDefinition` and `DomainSource` interfaces, add `source` field to `CanonicalEventDefinition` |
| `packages/caamp/src/core/hooks/normalizer.ts` | Handle domain-sourced events in normalization logic |
| `crates/cant-core/src/ast.rs` | Extend `CanonicalEvent` enum with domain events |
| `crates/cant-core/src/validate.rs` | Update S06/H01 validation to accept domain events |
| `packages/core/src/cant/workflow-executor.ts` | Implement formal execution semantics (Sections 3-8) |
| `packages/core/src/cant/types.ts` | Add `WorkflowOutput`, `ManifestEntry`, suspended state types |
| `packages/core/src/cant/parallel-runner.ts` | Add cancellation protocol, arm dependency resolution |

### 13.2 Files to Create

| File | Purpose |
|---|---|
| `packages/core/src/cant/domain-events.ts` | Domain event emitter, payload construction, D:O:P resolution |
| `packages/core/src/cant/suspension.ts` | Workflow state serialization/deserialization for approval suspension |

### 13.3 Backward Compatibility

- All 16 existing provider events are unchanged.
- Existing `.cant` files using only provider events require no modification.
- The `source` field on existing events defaults to `"provider"` — additive, not breaking.
- The `domainSources` section is new and does not affect existing `providerMappings`.

---

## References

- `docs/specs/CANT-DSL-SPEC.md` — Base language specification
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — 10 domains, canonical verbs, CQRS gateways
- `docs/specs/VERB-STANDARDS.md` — Canonical verb matrix
- `docs/concepts/CLEO-VISION.md` — Four canonical systems, workshop vocabulary
- `docs/concepts/NEXUS-CORE-ASPECTS.md` — Workshop language (Thread, Loom, Cascade, etc.)
- `docs/concepts/CLEO-CANT.md` — CANT conversation + response protocol
- `packages/caamp/providers/hook-mappings.json` — Canonical event taxonomy SSoT
- `packages/core/src/cant/workflow-executor.ts` — Workflow executor implementation
- `packages/core/src/cant/parallel-runner.ts` — Parallel execution implementation
- `packages/core/src/cant/approval.ts` — Approval token manager
