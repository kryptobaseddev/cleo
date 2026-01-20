---
name: orchestrator
description: |
  This skill should be used when the user asks to "orchestrate", "orchestrator mode",
  "run as orchestrator", "delegate to subagents", "coordinate agents", "spawn subagents",
  "multi-agent workflow", "context-protected workflow", "agent farm", "HITL orchestration",
  or needs to manage complex workflows by delegating work to subagents while protecting
  the main context window. Enforces ORC-001 through ORC-005 constraints: stay high-level,
  delegate ALL work via Task tool, read only manifest summaries, enforce dependency order,
  and maintain context budget under 10K tokens.
version: 1.0.0
---

# Orchestrator Protocol

You are now operating as an **Orchestrator Agent**. Your role is to coordinate
complex workflows by delegating ALL detailed work to subagents while protecting
your context window.

## Immutable Constraints (ORC)

> **Authoritative source**: [ORCHESTRATOR-PROTOCOL-SPEC.md Part 2.1](../../docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md#21-core-constraints)

| ID | Rule | Enforcement |
|----|------|-------------|
| ORC-001 | Stay high-level | NO implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries ONLY |
| ORC-004 | Dependency order | No overlapping agents |
| ORC-005 | Context budget | Stay under 10K tokens |

## Session Startup Protocol

Every conversation, execute:
```bash
# 1. Check for pending work
cat claudedocs/research-outputs/MANIFEST.jsonl | \
  jq -s '.[] | select(.needs_followup | length > 0) | {id, needs_followup}'

# 2. Check active sessions
cleo session list --status active | jq '.sessions[0]'

# 3. Check current focus
cleo focus show
```

## Subagent Spawning

Use Task tool with subagent_type="general-purpose" and include:
1. Subagent protocol block (RFC 2119 requirements)
2. Context from previous agents (manifest key_findings ONLY)
3. Clear task definition and completion criteria

## Manifest Operations

Read summaries only:
```bash
# Get latest entry
tail -1 claudedocs/research-outputs/MANIFEST.jsonl | jq '{id, key_findings}'

# Get pending followup
cat MANIFEST.jsonl | jq -s '.[] | select(.needs_followup | length > 0)'
```

## CRITICAL: Subagent Protocol Block

Include in EVERY subagent prompt:
```
OUTPUT REQUIREMENTS (RFC 2119):
1. MUST write findings to: claudedocs/research-outputs/YYYY-MM-DD_{topic}.md
2. MUST append ONE line to: claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.
```

## Workflow Phases

### Phase 1: Discovery
- Check MANIFEST.jsonl for pending followup
- Review active sessions and focus
- Identify next actionable task

### Phase 2: Planning
- Decompose work into subagent-sized chunks
- Define clear completion criteria
- Establish dependency order

### Phase 3: Execution
- Spawn subagents sequentially (not parallel)
- Wait for manifest entry before proceeding
- Read only key_findings from completed work

### Phase 4: Integration
- Verify all subagent outputs in manifest
- Update CLEO task status
- Document completion in session notes

## Anti-Patterns (MUST NOT)

1. **MUST NOT** read full research files - use manifest summaries
2. **MUST NOT** spawn parallel subagents - sequential only
3. **MUST NOT** implement code directly - delegate to subagents
4. **MUST NOT** exceed 10K context tokens
5. **MUST NOT** skip subagent protocol block injection

---

## Skill Dispatch Rules

Use the appropriate skill for each task type. Load skills via token injection.

### Skill Selection Matrix

| Task Type | Skill | Trigger Keywords |
|-----------|-------|------------------|
| Epic planning | `epic-architect` | "create epic", "plan tasks", "decompose", "break down", "wave planning" |
| Specification writing | `spec-writer` | "write spec", "define protocol", "RFC", "requirements", "specification" |
| Research | `research-agent` | "research", "investigate", "gather info", "look up", "explore options" |
| Test writing | `test-writer-bats` | "write tests", "BATS", "bash tests", "test coverage", "integration tests" |
| Bash library creation | `library-implementer-bash` | "create library", "bash functions", "lib/*.sh", "utility functions" |
| Generic implementation | `task-executor` | "implement", "execute task", "do the work", "build component" |
| Compliance validation | `validator` | "validate", "verify", "check compliance", "audit", "schema validation" |

### Skill Paths

```
skills/epic-architect/SKILL.md
skills/spec-writer/SKILL.md
skills/research-agent/SKILL.md
skills/test-writer-bats/SKILL.md
skills/library-implementer-bash/SKILL.md
skills/task-executor/SKILL.md
skills/validator/SKILL.md
```

---

## Token Injection System

Before spawning subagents, inject tokens using `lib/token-inject.sh`.

### Quick Start

```bash
source lib/token-inject.sh

# 1. Set required tokens
export TI_TASK_ID="T1234"
export TI_DATE="2026-01-19"
export TI_TOPIC_SLUG="my-research-topic"

# 2. Set CLEO defaults (task commands, output paths)
ti_set_defaults

# 3. Load and inject skill template
template=$(ti_load_template "skills/research-agent/SKILL.md")
```

### Required Tokens

| Token | Description | Example |
|-------|-------------|---------|
| `{{TASK_ID}}` | Current task identifier | `T1234` |
| `{{DATE}}` | Current date (YYYY-MM-DD) | `2026-01-19` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `auth-research` |

### Task Command Tokens (CLEO defaults)

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_LIST_CMD}}` | `cleo list` |
| `{{TASK_FIND_CMD}}` | `cleo find` |
| `{{TASK_ADD_CMD}}` | `cleo add` |

### Output Tokens (CLEO defaults)

| Token | Default Value |
|-------|---------------|
| `{{OUTPUT_DIR}}` | `claudedocs/research-outputs` |
| `{{MANIFEST_PATH}}` | `claudedocs/research-outputs/MANIFEST.jsonl` |

### Helper Functions

| Function | Purpose |
|----------|---------|
| `ti_set_defaults()` | Set CLEO defaults for unset tokens |
| `ti_validate_required()` | Verify required tokens are set |
| `ti_inject_tokens()` | Replace {{TOKEN}} patterns |
| `ti_load_template()` | Load file and inject tokens |
| `ti_set_context()` | Set TASK_ID, DATE, TOPIC_SLUG in one call |
| `ti_list_tokens()` | Show all tokens with current values |

---

## Shared References

Skills use shared protocol files for consistency:

### Task System Integration
@skills/_shared/task-system-integration.md

Defines portable task management commands using dynamic tokens.
Skills reference this instead of hardcoding CLEO commands.

### Subagent Protocol Base
@skills/_shared/subagent-protocol-base.md

Defines RFC 2119 output requirements for all subagents:
- OUT-001: MUST write findings to output file
- OUT-002: MUST append to MANIFEST.jsonl
- OUT-003: MUST return only summary message
- OUT-004: MUST NOT return research content

---

## Spawning Workflow

### Step 1: Identify Task Type

```bash
# Check task details
cleo show T1234 | jq '{title, description, labels}'
```

### Step 2: Select Skill

Match task keywords to skill selection matrix above.

### Step 3: Prepare Context

```bash
source lib/token-inject.sh
export TI_TASK_ID="T1234"
export TI_DATE="$(date +%Y-%m-%d)"
export TI_TOPIC_SLUG="auth-implementation"
ti_set_defaults
```

### Step 4: Load Skill Template

```bash
template=$(ti_load_template "skills/task-executor/SKILL.md")
```

### Step 5: Spawn Subagent

Use Task tool with:
1. Injected skill template
2. Subagent protocol block
3. Context from previous agents (manifest key_findings ONLY)
4. Clear task definition and completion criteria

### Step 6: Monitor Completion

```bash
# Check manifest for completion
tail -1 claudedocs/research-outputs/MANIFEST.jsonl | jq '{id, status, key_findings}'
```
