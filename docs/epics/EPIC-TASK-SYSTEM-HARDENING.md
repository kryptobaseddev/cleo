# Epic: CLEO Task System Hardening - Mandatory AC, Gates & Pipeline Enforcement

**Epic ID:** T056  
**Status:** Draft  
**Priority:** CRITICAL  
**Phase:** CORE  
**Size:** Large  
**Created:** 2026-03-20  
**Driver:** CLEO Core Team  

---

## 🎯 Vision Statement

Transform CLEO from an **optional-discipline** task system into a **mandatory-governance** work orchestration platform. Every unit of work MUST flow through RCASD-IVTR+C pipeline with enforced acceptance criteria, verification gates, and provenance tracking. This is not red tape—this is **anti-hallucination infrastructure**.

> **"No work exists without an Epic. No Epic exists without a Task. No Task completes without passing Gates."**

---

## 🚨 Problem Statement

### Current State (Broken)

```
┌─────────────────────────────────────────────────────────────┐
│                    CURRENT REALITY                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ❌ 28 tasks created with ZERO acceptance criteria          │
│  ❌ Tasks marked "done" without verification gates          │
│  ❌ AC enforcement: opt-in (default: warn)                  │
│  ❌ Verification gates: opt-in (default: disabled)          │
│  ❌ Session tracking: optional (autoStart: false)           │
│  ❌ No pipeline stage enforcement on task creation          │
│  ❌ Epic creation doesn't require lifecycle pipeline        │
│  ❌ Agents not forced into opinionated workflow             │
│                                                             │
│  Result: LLM agents work around the system, not through it  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Systemic Failures Discovered

#### Key Findings from Investigation
**The AC/Gate System EXISTS But Is BROKEN**

Current `config.json` lacks explicit enforcement declarations:
```json
{
  "lifecycle": { "mode": "strict" }
  // Missing: enforcement.acceptance, verification.enabled, etc.
}
```

What's actually enforced (from `packages/core/src/tasks/complete.ts:151-164`):
```typescript
if (
  enforcement.acceptanceMode === 'block' &&
  enforcement.acceptanceRequiredForPriorities.includes(task.priority)
) {
  if (!task.acceptance || task.acceptance.length === 0) {
    throw new CleoError(...);  // This BLOCKS completion
  }
}
```

**The Core Problems:**
1. **Config Defaults**: Defaults are too permissive (`warn` not `block`)
2. **AC Timing**: AC is not required at creation time
3. **Verification**: Verification is disabled by default
4. **Sessions**: Sessions are not enforced
5. **Pipeline Binding**: No pipeline stage enforcement on task creation
6. **Gate Bypass**: No enforcement that gates must be set before completion
7. **Epic Abstraction**: Epics don't enforce that children follow pipeline

**The Solution (T056 Epic):**
- **Block mode by default**
- **Require AC on creation**
- **Auto-initialize verification**
- **Mandatory sessions**
- **Pipeline binding**

---

## 🏗️ Solution Architecture

### The Iron Triangle of CLEO Work

```
                    EPIC
                     │
                     │ 1:*
                     ▼
        ┌──────────────────────────┐
        │    RCASD-IVTR+C          │
        │    Pipeline Stage        │
        └──────────────────────────┘
                     │
                     │ 1:*
                     ▼
                  SESSION
                     │
                     │ 1:*
                     ▼
        ┌──────────────────────────┐
        │         TASK             │
        │  ┌────────────────────┐  │
        │  │ Acceptance Criteria │  │
        │  └────────────────────┘  │
        │  ┌────────────────────┐  │
        │  │ Verification Gates  │  │
        │  │ ✓ Implemented       │  │
        │  │ ✓ Tests Passed      │  │
        │  │ ✓ QA Passed         │  │
        │  │ ✓ Security Passed   │  │
        │  │ ✓ Documented        │  │
        │  └────────────────────┘  │
        └──────────────────────────┘
```

### Enforcement Hierarchy

| Level | Enforcement | Behavior |
|-------|-------------|----------|
| **Block** (Strict) | Hard stop | Operation rejected, error returned |
| **Warn** | Soft guidance | Operation succeeds, warning attached |
| **Advisory** | Suggestion | Operation succeeds, note in output |
| **Off** | No checking | Operation proceeds silently |

---

## 📋 Task Breakdown

### Wave 0: Foundation - Config Schema & Defaults (T057-T059)

#### T057: Harden config.schema.json with Strict Defaults
**Type:** Task  
**Priority:** Critical  
**Parent:** T056  
**Dependencies:** None  

**Description:**  
Update `schemas/config.schema.json` to enforce strict defaults for all governance settings.

**Current State:**
```json
{
  "enforcement": {
    "acceptance": {
      "mode": "warn",  // ❌ Too permissive
      "requiredForPriorities": ["critical", "high"]
    }
  },
  "verification": {
    "enabled": false,  // ❌ Opt-in
    "requiredGates": [...]
  }
}
```

**Required Changes:**
```json
{
  "enforcement": {
    "acceptance": {
      "mode": {
        "type": "string",
        "enum": ["off", "warn", "block"],
        "default": "block"  // ✅ Force AC
      },
      "requiredForPriorities": {
        "type": "array",
        "items": {"type": "string"},
        "default": ["critical", "high", "medium", "low"]  // ✅ All tasks
      },
      "minimumCriteria": {
        "type": "integer",
        "default": 3,  // ✅ At least 3 AC items
        "minimum": 1
      }
    },
    "session": {
      "requiredForMutate": {
        "type": "boolean",
        "default": true  // ✅ Must have session
      }
    },
    "pipeline": {
      "bindTasksToStage": {
        "type": "boolean",
        "default": true  // ✅ Tasks tied to RCASD-IVTR+C
      }
    }
  },
  "verification": {
    "enabled": {
      "type": "boolean",
      "default": true  // ✅ Always on
    },
    "requiredForTypes": {
      "type": "array",
      "items": {"type": "string"},
      "default": ["epic", "task", "subtask"]  // ✅ All types
    },
    "autoInitialize": {
      "type": "boolean",
      "default": true  // ✅ Auto-create verification on task add
    }
  }
}
```

**Acceptance Criteria:**
1. [ ] Schema updated with strict defaults
2. [ ] Migration guide for existing configs
3. [ ] Documentation updated
4. [ ] Tests pass with new defaults

**Files:**
- `schemas/config.schema.json`
- `docs/guides/config-migration.md`

---

#### T058: Implement Acceptance Criteria Enforcement Layer
**Type:** Task  
**Priority:** Critical  
**Parent:** T056  
**Dependencies:** T057  

**Description:**  
Create a middleware/enforcement layer that validates AC before task operations succeed.

**Implementation Points:**

1. **Task Creation (`tasks.add`)**:
   - Check `enforcement.acceptance.mode`
   - If `block`: Require `--acceptance` flag with minimum criteria
   - If `warn`: Allow creation but emit warning
   - Auto-initialize verification metadata

2. **Task Update (`tasks.update`)**:
   - If adding AC to existing task: validate format
   - If removing AC: check if task already in progress (block if so)

3. **Task Completion (`tasks.complete`)**:
   - Verify all AC items are marked complete
   - Verify all verification gates passed
   - Block completion if any gate fails

**Code Changes:**
```typescript
// packages/core/src/tasks/enforcement.ts
export interface AcceptanceEnforcement {
  validateCreation(options: AddTaskOptions): ValidationResult;
  validateUpdate(taskId: string, updates: TaskUpdate): ValidationResult;
  validateCompletion(task: Task): ValidationResult;
  checkMinimumCriteria(criteria: string[]): boolean;
}

export function createAcceptanceEnforcement(
  config: CleoConfig
): AcceptanceEnforcement {
  return {
    validateCreation(options) {
      if (config.enforcement.acceptance.mode === 'block') {
        if (!options.acceptance || options.acceptance.length < config.enforcement.acceptance.minimumCriteria) {
          return {
            valid: false,
            error: `Task requires at least ${config.enforcement.acceptance.minimumCriteria} acceptance criteria`,
            fix: `Add --acceptance "criterion 1" --acceptance "criterion 2" --acceptance "criterion 3"`
          };
        }
      }
      return { valid: true };
    },
    // ...
  };
}
```

**Acceptance Criteria:**
1. [ ] Enforcement layer created in `packages/core/src/tasks/enforcement.ts`
2. [ ] Integrated into `tasks.add` flow
3. [ ] Integrated into `tasks.update` flow
4. [ ] Integrated into `tasks.complete` flow
5. [ ] Unit tests for all enforcement modes
6. [ ] Integration tests for end-to-end flow

**Files:**
- `packages/core/src/tasks/enforcement.ts` (new)
- `packages/core/src/tasks/add.ts` (modify)
- `packages/core/src/tasks/update.ts` (modify)
- `packages/core/src/tasks/complete.ts` (modify)
- `packages/core/src/tasks/__tests__/enforcement.test.ts` (new)

---

#### T059: Implement Mandatory Session Binding
**Type:** Task  
**Priority:** Critical  
**Parent:** T056  
**Dependencies:** T057  

**Description:**  
Enforce that all task mutations occur within an active session context.

**Current State:**
```typescript
// Any agent can complete a task without a session
cleo complete T123  // Works without session
```

**Required State:**
```typescript
// Must have active session
session start --scope epic:T100  // Initialize context
cleo start T123                  // Work on task
cleo complete T123               // Complete within session
session end                      // Close context
```

**Implementation:**

1. **Session Context Middleware**:
   - Check for active session before mutate operations
   - Inject session context into task audit logs
   - Track task-to-session relationships

2. **Task-to-Session Binding**:
   - Add `sessionId` field to task metadata
   - Record which session completed each task
   - Enable "show me all tasks from session S123"

**Code Changes:**
```typescript
// packages/core/src/sessions/session-middleware.ts
export async function requireSessionForMutation(
  cwd: string,
  operation: string
): Promise<Session> {
  const config = await loadConfig(cwd);
  
  if (config.enforcement.session?.requiredForMutate) {
    const session = await getActiveSession(cwd);
    if (!session) {
      throw new CleoError(
        ExitCode.SESSION_REQUIRED,
        `Operation '${operation}' requires an active session.`,
        {
          fix: `Start a session: cleo session start --scope epic:T###`,
          hint: `Sessions provide provenance and context tracking`
        }
      );
    }
    return session;
  }
  
  // Return null session if enforcement off
  return await getActiveSession(cwd);
}
```

**Acceptance Criteria:**
1. [ ] Session middleware created
2. [ ] Integrated into all mutate operations
3. [ ] Session ID tracked in task audit logs
4. [ ] CLI commands updated to show session context
5. [ ] Tests for session enforcement

**Files:**
- `packages/core/src/sessions/session-middleware.ts` (new)
- `packages/core/src/tasks/add.ts` (modify)
- `packages/core/src/tasks/complete.ts` (modify)
- `packages/core/src/tasks/update.ts` (modify)
- All mutate operations updated

---

### Wave 1: Pipeline Integration - RCASD-IVTR+C Binding (T060-T062)

#### T060: Bind Tasks to Pipeline Stages
**Type:** Task  
**Priority:** High  
**Parent:** T056  
**Dependencies:** T058, T059  

**Description:**  
Automatically associate every task with a specific RCASD-IVTR+C pipeline stage.

**Pipeline Stages:**
```
RCASD (Research)
  └── Tasks: Literature review, discovery, context gathering

C (Consensus)
  └── Tasks: Stakeholder alignment, decision validation

A (Architecture Decision)
  └── Tasks: ADR creation, technical design

S (Specification)
  └── Tasks: Requirements writing, RFC 2119 specs

D (Decomposition)
  └── Tasks: Break epics into atomic tasks

I (Implementation)
  └── Tasks: Code, configuration, documentation

V (Validation)
  └── Tasks: Testing, verification, gate passing

T (Testing)
  └── Tasks: Test suites, QA, coverage

R (Release)
  └── Tasks: Versioning, shipping, deployment

+C (Contribution)
  └── Cross-cutting: Provenance, attribution
```

**Implementation:**

1. **Add `pipelineStage` field to Task schema**:
   ```typescript
   interface Task {
     // ... existing fields
     pipelineStage?: PipelineStage;
     stageEntryDate?: string;
     stageCompletionDate?: string;
     stageGates?: StageGate[];
   }
   ```

2. **Auto-assign stage on task creation**:
   - Infer from task type, parent epic, or labels
   - Allow explicit `--stage` flag
   - Default to "Implementation" if unclear

3. **Stage transition validation**:
   - Tasks can only move forward through stages
   - Must complete current stage gates before advancing
   - Audit log tracks all stage transitions

**Acceptance Criteria:**
1. [ ] Task schema updated with pipeline fields
2. [ ] Migration for existing tasks (default to "Implementation")
3. [ ] Auto-assignment logic for new tasks
4. [ ] Stage transition validation
5. [ ] CLI commands: `cleo task set-stage`, `cleo task stage-status`
6. [ ] Tests for stage binding

**Files:**
- `packages/contracts/src/task.ts` (modify)
- `packages/core/src/store/tasks-schema.ts` (modify)
- `packages/core/src/tasks/pipeline-binding.ts` (new)
- `packages/core/src/lifecycle/stage-transitions.ts` (modify)

---

#### T061: Implement Automatic Verification Gate Initialization
**Type:** Task  
**Priority:** High  
**Parent:** T056  
**Dependencies:** T058  

**Description:**  
Auto-create verification metadata when tasks are created, not when they're completed.

**Current State:**
```typescript
// Verification metadata added manually or at completion time
// Many tasks have null verification field
```

**Required State:**
```typescript
// Every task has verification initialized on creation
{
  verification: {
    enabled: true,
    round: 1,
    gates: {
      implemented: false,
      testsPassed: false,
      qaPassed: false,
      securityPassed: false,
      documented: false
    },
    passed: false,
    initializedAt: "2026-03-20T10:00:00Z"
  }
}
```

**Implementation:**

1. **Auto-initialize on task creation**:
   ```typescript
   // packages/core/src/tasks/add.ts
   if (config.verification.autoInitialize) {
     task.verification = {
       enabled: true,
       round: 1,
       gates: {},
       passed: false,
       initializedAt: new Date().toISOString()
     };
     
     // Set all required gates to false
     for (const gate of config.verification.requiredGates) {
       task.verification.gates[gate] = false;
     }
   }
   ```

2. **Gate Management CLI**:
   ```bash
   cleo verification set-gate T123 implemented true
   cleo verification status T123
   cleo verification reset T123
   ```

**Acceptance Criteria:**
1. [ ] Auto-initialization on task creation
2. [ ] All tasks in DB have verification metadata
3. [ ] CLI commands for gate management
4. [ ] Integration with task completion flow
5. [ ] Tests for auto-initialization

**Files:**
- `packages/core/src/tasks/add.ts` (modify)
- `packages/core/src/verification/gate-management.ts` (new)
- `packages/cleo/src/cli/commands/verification.ts` (new)

---

#### T062: Epic Lifecycle Pipeline Enforcement
**Type:** Task  
**Priority:** High  
**Parent:** T056  
**Dependencies:** T060  

**Description:**  
Epics MUST follow RCASD-IVTR+C and enforce that children follow the pipeline.

**Epic Lifecycle Rules:**

1. **Epic Creation Requirements**:
   - Must specify pipeline stage
   - Must have AC (more stringent than regular tasks)
   - Must have verification gates
   - Must define completion criteria

2. **Child Task Requirements**:
   - All children must be bound to pipeline stages
   - Children stages must be compatible with epic stage
   - Epic cannot advance stage until all children complete current stage

3. **Epic Completion**:
   - All children must be done
   - All verification gates passed
   - Stage completion recorded
   - Provenance captured

**Acceptance Criteria:**
1. [ ] Epic creation enforces stricter requirements
2. [ ] Child tasks inherit epic pipeline context
3. [ ] Epic stage advancement blocked by incomplete children
4. [ ] Epic completion requires all gates
5. [ ] Tests for epic lifecycle enforcement

**Files:**
- `packages/core/src/tasks/epic-lifecycle.ts` (new)
- `packages/core/src/tasks/add.ts` (modify for epic path)
- `packages/core/src/tasks/complete.ts` (modify for epic path)

---

### Wave 2: Agent Workflow - LLM Integration (T063-T065)

#### T063: Update All Skills with Mandatory Workflow
**Type:** Task  
**Priority:** High  
**Parent:** T056  
**Dependencies:** T058, T059, T061  

**Description:**  
Rewrite all CLEO skills to enforce the opinionated workflow.

**Skills to Update:**
1. `ct-cleo/SKILL.md` - Core protocol
2. `ct-orchestrator/SKILL.md` - Multi-agent coordination
3. `ct-memory/SKILL.md` - Brain operations
4. `ct-task-executor/SKILL.md` - Task execution
5. `_shared/task-system-integration.md` - Common patterns

**Required Workflow in Skills:**

```markdown
## Agent Mandatory Workflow

### Before ANY Work
1. **Start Session** (REQUIRED):
   ```
   mutate session start --scope epic:T###
   ```
   Failure to start session blocks all mutations.

2. **Verify Context**:
   ```
   query session status
   query tasks current
   ```

### Task Creation Protocol
Every task MUST include:
- `--acceptance "Criteria 1" --acceptance "Criteria 2" --acceptance "Criteria 3"`
  Minimum 3 acceptance criteria required.
- `--stage implementation` (or appropriate RCASD-IVTR+C stage)
- Parent epic specified

Example:
```bash
cleo add "Fix login bug" \
  --type task \
  --parent T100 \
  --stage implementation \
  --acceptance "Unit tests pass" \
  --acceptance "Integration tests pass" \
  --acceptance "Security review complete" \
  --acceptance "Documentation updated"
```

### During Work
1. **Start Task**:
   ```
   cleo start T###
   ```

2. **Update Progress**:
   ```
   cleo update T### --notes "Progress update..."
   ```

3. **Set Verification Gates** (as completed):
   ```
   cleo verification set-gate T### implemented true
   cleo verification set-gate T### testsPassed true
   ```

### Task Completion Protocol
Before `cleo complete`:
1. All acceptance criteria must be checked off
2. All verification gates must be passed
3. Session must be active
4. Task must be in scope

Command:
```bash
# Check status first
cleo verification status T###

# Complete if all gates pass
cleo complete T### --note "Completed as per AC"
```

### Anti-Patterns (FORBIDDEN)
- ❌ Creating tasks without acceptance criteria
- ❌ Completing tasks without setting verification gates
- ❌ Working outside an active session
- ❌ Bypassing `cleo complete` with `cleo update --status done`
```

**Acceptance Criteria:**
1. [ ] All skills updated with mandatory workflow
2. [ ] Skills include specific examples
3. [ ] Anti-patterns clearly marked
4. [ ] Token efficiency maintained
5. [ ] Skills tested with real agents

**Files:**
- `packages/skills/skills/ct-cleo/SKILL.md` (rewrite)
- `packages/skills/skills/ct-orchestrator/SKILL.md` (update)
- `packages/skills/skills/ct-memory/SKILL.md` (update)
- `packages/skills/skills/ct-task-executor/SKILL.md` (update)
- `packages/skills/skills/_shared/task-system-integration.md` (update)

---

#### T064: Create ct-validator Skill for Gate Enforcement
**Type:** Task  
**Priority:** Medium  
**Parent:** T056  
**Dependencies:** T063  

**Description:**  
Create a dedicated skill that validates task compliance before operations proceed.

**Skill Capabilities:**

1. **Pre-flight Checks**:
   - Verify task has AC before starting work
   - Verify session is active
   - Verify task is in correct pipeline stage

2. **Gate Validation**:
   - Check which gates are set
   - Verify gate dependencies (e.g., testsPassed requires implemented)
   - Suggest next gates to set

3. **Compliance Report**:
   - Generate compliance summary for task
   - Show missing AC items
   - List incomplete gates
   - Suggest fixes

**Usage in Agents:**
```markdown
Before completing task T###, run:
query tools skill.dispatch ct-validator validate-task {taskId: "T###"}

If validation fails, fix issues before completing.
```

**Acceptance Criteria:**
1. [ ] Skill created at `packages/skills/skills/ct-validator/`
2. [ ] Pre-flight validation functions
3. [ ] Gate validation logic
4. [ ] Compliance reporting
5. [ ] Integration with task completion flow

**Files:**
- `packages/skills/skills/ct-validator/SKILL.md` (new)
- `packages/core/src/validation/task-compliance.ts` (new)

---

#### T065: Implement Agent Workflow Telemetry
**Type:** Task  
**Priority:** Medium  
**Parent:** T056  
**Dependencies:** T063  

**Description:**  
Track how agents use CLEO to identify workflow violations and compliance gaps.

**Metrics to Track:**
1. Tasks created without AC (violation count)
2. Tasks completed outside sessions (violation count)
3. Average gates set per task
4. Stage transition timing
5. Session-to-task completion ratio

**Implementation:**

```typescript
// packages/core/src/telemetry/agent-workflow.ts
export interface WorkflowTelemetry {
  recordViolation(type: ViolationType, details: ViolationDetails): void;
  recordCompliance(taskId: string, checks: ComplianceCheck[]): void;
  generateReport(period: string): WorkflowReport;
}

export enum ViolationType {
  MISSING_AC = 'missing_acceptance_criteria',
  NO_SESSION = 'no_active_session',
  INCOMPLETE_GATES = 'incomplete_verification_gates',
  INVALID_STAGE_TRANSITION = 'invalid_stage_transition'
}
```

**Acceptance Criteria:**
1. [ ] Telemetry system created
2. [ ] Violation tracking implemented
3. [ ] Dashboard for workflow compliance
4. [ ] Alerting for high violation rates
5. [ ] Tests for telemetry

**Files:**
- `packages/core/src/telemetry/agent-workflow.ts` (new)
- `packages/core/src/admin/workflow-dashboard.ts` (new)
- `docs/metrics/workflow-compliance.md` (new)

---

### Wave 3: Migration & Rollout (T066-T068)

#### T066: Backfill Existing Tasks with AC
**Type:** Task  
**Priority:** High  
**Parent:** T056  
**Dependencies:** T058, T061  

**Description:**  
Retroactively add AC and verification metadata to all existing tasks.

**Migration Strategy:**

1. **Audit Existing Tasks**:
   ```bash
   cleo find --status pending,active --format json > audit.json
   ```

2. **Auto-generate AC from description**:
   - Use LLM to extract implied acceptance criteria
   - Generate 3-5 criteria per task
   - Mark as "auto-generated - needs review"

3. **Initialize Verification**:
   - Set all gates to false
   - Set round to 1
   - Add migration note

**Script:**
```typescript
// scripts/backfill-task-metadata.ts
export async function backfillTasks(cwd: string): Promise<void> {
  const tasks = await findTasks({ status: ['pending', 'active'] }, cwd);
  
  for (const task of tasks) {
    const updates: TaskFieldUpdates = {};
    
    // Add auto-generated AC if missing
    if (!task.acceptance || task.acceptance.length === 0) {
      updates.acceptance = await generateACFromDescription(task);
    }
    
    // Initialize verification if missing
    if (!task.verification) {
      updates.verification = {
        enabled: true,
        round: 1,
        gates: {},
        passed: false,
        initializedAt: new Date().toISOString(),
        migrated: true
      };
    }
    
    await updateTaskFields(task.id, updates, cwd);
  }
}
```

**Acceptance Criteria:**
1. [ ] Audit script created
2. [ ] AC generation from descriptions
3. [ ] Verification initialization
4. [ ] Dry-run mode
5. [ ] Rollback capability
6. [ ] All existing tasks updated

**Files:**
- `scripts/backfill-task-metadata.ts` (new)
- `docs/migrations/task-metadata-backfill.md` (new)

---

#### T067: Create Project-Level Strictness Presets
**Type:** Task  
**Priority:** Medium  
**Parent:** T056  
**Dependencies:** T057  

**Description:**  
Create preset configuration profiles for different project strictness levels.

**Presets:**

```json
// .cleo/config.json - "strict" preset
{
  "preset": "strict",
  "enforcement": {
    "acceptance": { "mode": "block", "minimumCriteria": 3 },
    "session": { "requiredForMutate": true },
    "pipeline": { "bindTasksToStage": true }
  },
  "verification": {
    "enabled": true,
    "autoInitialize": true,
    "requiredForTypes": ["epic", "task", "subtask"]
  },
  "lifecycle": { "mode": "strict" }
}
```

```json
// .cleo/config.json - "standard" preset
{
  "preset": "standard",
  "enforcement": {
    "acceptance": { "mode": "warn", "minimumCriteria": 1 },
    "session": { "requiredForMutate": false },
    "pipeline": { "bindTasksToStage": true }
  },
  "verification": {
    "enabled": true,
    "autoInitialize": true,
    "requiredForTypes": ["epic", "task"]
  },
  "lifecycle": { "mode": "advisory" }
}
```

```json
// .cleo/config.json - "minimal" preset
{
  "preset": "minimal",
  "enforcement": {
    "acceptance": { "mode": "off" },
    "session": { "requiredForMutate": false },
    "pipeline": { "bindTasksToStage": false }
  },
  "verification": {
    "enabled": false
  },
  "lifecycle": { "mode": "off" }
}
```

**Acceptance Criteria:**
1. [ ] Three preset profiles defined
2. [ ] CLI command: `cleo config set-preset strict`
3. [ ] Documentation for each preset
4. [ ] Migration guide between presets
5. [ ] Tests for preset application

**Files:**
- `packages/core/src/config/presets.ts` (new)
- `docs/config/presets.md` (new)
- `schemas/config-presets.schema.json` (new)

---

#### T068: Documentation & Training Materials
**Type:** Task  
**Priority:** Medium  
**Parent:** T056  
**Dependencies:** All Wave 0-2  

**Description:**  
Create comprehensive documentation for the hardened task system.

**Documentation:**

1. **User Guide**: `docs/guides/task-system-hardening.md`
   - Why strict mode exists
   - How to work with AC
   - Gate management
   - Troubleshooting

2. **Agent Guide**: `docs/guides/agent-mandatory-workflow.md`
   - Step-by-step workflow
   - Common mistakes
   - Token-efficient patterns

3. **Migration Guide**: `docs/migrations/to-strict-mode.md`
   - Backfilling existing work
   - Config changes
   - Team training

4. **Reference**: `docs/reference/acceptance-criteria-patterns.md`
   - Good AC examples
   - Anti-patterns
   - Industry standards

**Acceptance Criteria:**
1. [ ] User guide complete
2. [ ] Agent guide complete
3. [ ] Migration guide complete
4. [ ] AC patterns reference
5. [ ] All docs reviewed

**Files:**
- `docs/guides/task-system-hardening.md` (new)
- `docs/guides/agent-mandatory-workflow.md` (new)
- `docs/migrations/to-strict-mode.md` (new)
- `docs/reference/acceptance-criteria-patterns.md` (new)

---

## 🎯 Success Criteria

### Epic Completion Criteria

- [ ] **Config Schema**: Strict defaults enforced
- [ ] **AC Enforcement**: Block mode prevents AC-less tasks
- [ ] **Session Binding**: All mutations require active session
- [ ] **Pipeline Binding**: Every task tied to RCASD-IVTR+C stage
- [ ] **Verification**: Auto-initialized on all tasks
- [ ] **Skills Updated**: All CLEO skills enforce mandatory workflow
- [ ] **Existing Tasks**: Backfilled with AC and verification
- [ ] **Documentation**: Complete guides for users and agents

### Quality Gates

1. **No AC Bypass**: Cannot create task without acceptance criteria in strict mode
2. **No Session Bypass**: Cannot mutate without active session
3. **No Gate Bypass**: Cannot complete without all verification gates
4. **100% Compliance**: All existing tasks have AC and verification
5. **Zero Violations**: Agents follow mandatory workflow

---

## 📊 Dependency Graph

```
T056 (Epic: Task System Hardening)
│
├── Wave 0: Foundation
│   ├── T057: Config Schema (No deps)
│   ├── T058: AC Enforcement (→ T057)
│   └── T059: Session Binding (→ T057)
│
├── Wave 1: Pipeline
│   ├── T060: Pipeline Binding (→ T058, T059)
│   ├── T061: Verification Auto-Init (→ T058)
│   └── T062: Epic Enforcement (→ T060)
│
├── Wave 2: Agent Workflow
│   ├── T063: Skills Update (→ T058, T059, T061)
│   ├── T064: Validator Skill (→ T063)
│   └── T065: Telemetry (→ T063)
│
└── Wave 3: Rollout
    ├── T066: Backfill (→ T058, T061)
    ├── T067: Presets (→ T057)
    └── T068: Documentation (All above)
```

---

## 🔗 Related Epics

- **T029**: Schema Architecture Review (complementary)
- **T038**: Drift Remediation (some tasks now complete)
- **T002**: Monorepo Stabilization (foundation complete)

---

## 📝 Notes

### Design Principles

1. **Opt-out, not Opt-in**: Strict mode is default. Teams must consciously choose to relax.
2. **Fail Fast**: Block at creation time, not completion time.
3. **Agent-First**: Skills and instructions are primary interface.
4. **Provenance**: Every action tracked to session and agent.
5. **Gradual Rollout**: Presets allow teams to adopt at their own pace.

### Why This Matters

From the DRIFT-ASSESSMENT:
> "Agents are essentially stateless with no recovery, monitoring, or learning. Same mistakes repeated."

This epic fixes that by:
- **Forcing structure**: No work without AC
- **Enforcing provenance**: Every task tied to session
- **Tracking quality**: Gates measure completion quality
- **Enabling learning**: Telemetry shows agent patterns

**This is CLEO's anti-hallucination immune system.**