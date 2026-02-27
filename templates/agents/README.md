# Agent Templates

Parameterized prompts for subagent spawning via the Task tool.

---

## Overview

These templates are **NOT skills**. They are prompt templates with dynamic tokens
that the orchestrator injects into subagent spawn calls.

| File | Purpose |
|------|---------|
| `BASE-SUBAGENT-PROTOCOL.md` | Core protocol block for all subagents |
| `RESEARCH-AGENT.md` | Research and information gathering |
| `TASK-EXECUTOR.md` | Generic task execution |
| `VALIDATOR.md` | Compliance and validation checks |
| `DOCUMENTOR.md` | Documentation writing agent |

---

## Skills vs Templates

| Aspect | Skills | Templates |
|--------|--------|-----------|
| Location | `skills/{name}/SKILL.md` | `templates/agents/*.md` |
| Invocation | Skill tool | Task tool with injected prompt |
| Context load | On activation (~5K tokens) | On every spawn |
| Has frontmatter | Yes (name, description) | No |
| Reusable | Yes (capability) | Yes (pattern) |

**Use Skills** when:
- Complex, reusable capability
- HITL interaction needed
- Language/framework specific

**Use Templates** when:
- Parameterized at spawn time
- Pure data gathering
- Context varies per invocation

---

## Token System

Templates use `{{TOKEN}}` placeholders replaced at spawn time.

### Required Tokens

```
{{TASK_ID}}       - The task being worked on
{{DATE}}          - Current date (YYYY-MM-DD)
{{TOPIC_SLUG}}    - URL-safe identifier for output files
```

### Context Tokens

```
{{EPIC_ID}}       - Parent epic (optional)
{{SESSION_ID}}    - Session identifier (optional)
{{OUTPUT_DIR}}    - Output directory (default: .cleo/agent-outputs)
{{MANIFEST_PATH}} - Manifest file (default: {{OUTPUT_DIR}}/MANIFEST.jsonl)
```

### Task System Tokens

```
{{TASK_SHOW_CMD}}     - Show task details (default: cleo show)
{{TASK_START_CMD}}    - Start task (default: cleo start)
{{TASK_COMPLETE_CMD}} - Complete task (default: cleo complete)
{{TASK_LINK_CMD}}     - Link research (default: cleo research link)
```

---

## Usage: Orchestrator Token Injection

### Step 1: Load Template

```bash
template=$(cat templates/agents/RESEARCH-AGENT.md)
```

### Step 2: Replace Tokens

```bash
# Replace task context
template="${template//\{\{TASK_ID\}\}/$TASK_ID}"
template="${template//\{\{EPIC_ID\}\}/$EPIC_ID}"
template="${template//\{\{DATE\}\}/$(date +%Y-%m-%d)}"
template="${template//\{\{TOPIC_SLUG\}\}/$TOPIC_SLUG}"

# Replace task system tokens (CLEO defaults)
template="${template//\{\{TASK_SHOW_CMD\}\}/cleo show}"
template="${template//\{\{TASK_START_CMD\}\}/cleo start}"
template="${template//\{\{TASK_COMPLETE_CMD\}\}/cleo complete}"
template="${template//\{\{TASK_LINK_CMD\}\}/cleo research link}"

# Replace output tokens
template="${template//\{\{OUTPUT_DIR\}\}/.cleo/agent-outputs}"
template="${template//\{\{MANIFEST_PATH\}\}/.cleo/agent-outputs/MANIFEST.jsonl}"
```

### Step 3: Spawn Subagent

Pass the resolved template to the Task tool:

```markdown
<Task>
  subagent_type: general-purpose
  prompt: |
    $template
</Task>
```

---

## Template Structure

Each template follows this structure:

```markdown
# {Agent Name} Template

You are the {ROLE} subagent for {CONTEXT}.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

[Include BASE-SUBAGENT-PROTOCOL.md content]

## CONTEXT

- Epic: {{EPIC_ID}}
- Task: {{TASK_ID}}
- Session: {{SESSION_ID}}

## YOUR TASK

{Task-specific instructions}

## OUTPUT FORMAT

{Template for output file}

## COMPLETION

1. Write output file
2. Append manifest entry
3. Complete task: {{TASK_COMPLETE_CMD}} {{TASK_ID}}
4. Return: "Research complete. See MANIFEST.jsonl for summary."

BEGIN.
```

---

## Non-CLEO Usage

Override task system tokens for other systems:

### Linear

```bash
template="${template//\{\{TASK_SHOW_CMD\}\}/linear issue view}"
template="${template//\{\{TASK_START_CMD\}\}/linear issue update --status in-progress}"
template="${template//\{\{TASK_COMPLETE_CMD\}\}/linear issue update --status done}"
```

### Jira

```bash
template="${template//\{\{TASK_SHOW_CMD\}\}/jira issue view}"
template="${template//\{\{TASK_START_CMD\}\}/jira issue move --status 'In Progress'}"
template="${template//\{\{TASK_COMPLETE_CMD\}\}/jira issue move --status Done}"
```

---

## Migration from Old Location (COMPLETED)

**MIGRATION COMPLETE**: The old `templates/orchestrator-protocol/subagent-prompts/` directory has been removed. All content migrated to `skills/`.

Files promoted to Skills:

| Old Location | New Location |
|--------------|--------------|
| `SPEC-WRITER.md` | `skills/spec-writer/SKILL.md` |
| `EPIC-ARCHITECT.md` | `skills/epic-architect/SKILL.md` |
| `TEST-WRITER-BATS.md` | `skills/test-writer-bats/SKILL.md` |
| `LIBRARY-IMPLEMENTER.md` | `skills/library-implementer-bash/SKILL.md` |
| `RESEARCH-AGENT.md` | `skills/research-agent/SKILL.md` |
| `TASK-EXECUTOR.md` | `skills/task-executor/SKILL.md` |
| `VALIDATOR.md` | `skills/validator/SKILL.md` |

Shared content in `skills/_shared/`:
- `subagent-protocol-base.md` - Base protocol (replaces BASE-SUBAGENT-PROMPT.md)
- `task-system-integration.md` - Task system integration
