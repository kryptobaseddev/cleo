# Invocation Control

This reference covers how to control when and how skills are triggered, including the interaction between `disable-model-invocation`, `user-invocable`, `allowed-tools`, and context budgets.

## Invocation Matrix

The combination of `disable-model-invocation` and `user-invocable` determines how a skill can be triggered:

| Frontmatter | User `/slash` invoke | Claude auto-trigger | Description in context | Body loaded |
|---|---|---|---|---|
| (defaults -- neither set) | Yes | Yes | Always | When invoked |
| `disable-model-invocation: true` | Yes | No | Never | When user invokes |
| `user-invocable: false` | No | Yes | Always | When Claude auto-triggers |
| Both set (`true` + `false`) | Error | Error | -- | Invalid combination |

Key observations:
- **Default behavior** is the most common: the skill appears in the slash menu, Claude can auto-trigger it, and the description is always in context for trigger evaluation.
- `disable-model-invocation: true` completely hides the skill from Claude. It cannot see the description, cannot reason about it, and cannot trigger it.
- `user-invocable: false` removes the slash command but keeps the description visible to Claude, allowing autonomous triggering.
- Setting both is contradictory (hidden from users AND hidden from Claude) and should not be done.

## disable-model-invocation: true

Use this for skills that perform side effects requiring explicit user intent. When set, the skill's description is removed from Claude's context entirely -- Claude does not know the skill exists.

**When to use**:
- Deployment workflows (staging, production pushes)
- Git operations with external effects (force push, tag creation)
- Communication actions (sending emails, Slack messages, creating PRs)
- Database mutations (migrations, data backfixes)
- Billing or payment operations
- Any destructive or hard-to-reverse operation

**Example**:

```yaml
---
name: deploy-production
description: "Deploy the current branch to production with rolling updates, health checks, and automatic rollback on failure. Use for production deployments only."
disable-model-invocation: true
argument-hint: "<service-name> [--canary] [--skip-tests]"
allowed-tools:
  - Bash(kubectl *)
  - Bash(helm *)
---
```

The user must explicitly type `/deploy-production api-gateway` to trigger this skill. Claude will never suggest or auto-trigger it, because Claude cannot see that it exists.

## user-invocable: false

Use this for background knowledge that Claude should apply autonomously. The skill has no slash command, but Claude reads the description and auto-loads the body when the conversation context matches.

**When to use**:
- Project coding standards and conventions
- API schemas and domain models that inform code generation
- Style guides that should be applied to all generated content
- Security policies and compliance rules
- Architecture patterns specific to the project

**Example**:

```yaml
---
name: project-conventions
description: "Project coding conventions including naming standards, import ordering, error handling patterns, and test structure. Apply these conventions when generating or modifying code in this project."
user-invocable: false
---
```

Claude sees the description, recognizes that a code generation task matches, and loads the skill body automatically. No `/project-conventions` slash command exists.

## allowed-tools

Pre-approves specific tools for use during skill execution, bypassing per-use permission prompts. Reduces friction without giving blanket permissions.

### String Format

Comma-separated list of tool names:

```yaml
allowed-tools: "Read, Write, Edit, Bash(python3 *)"
```

### List Format

YAML list for clearer multi-tool specifications:

```yaml
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash(npm test *)
  - Bash(npx vitest *)
```

### Bash Pattern Restriction

`Bash(pattern)` pre-approves only bash commands matching the glob pattern. The pattern is matched against the full command string.

```yaml
# Only allow git and npm commands
allowed-tools:
  - Bash(git *)
  - Bash(npm *)

# Only allow Python scripts in the skill's scripts directory
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/*)
```

Without a pattern, bare `Bash` pre-approves all bash commands -- use with caution.

## Context Budget

Skills consume context window space at two levels, and understanding the budget is critical for designing skills that coexist well.

### Description Budget

Every trigger-eligible skill's `description` field is loaded into Claude's context at all times. Each description consumes roughly 100-200 tokens. With 15 skills, that is 1,500-3,000 tokens of always-on context.

Implication: keep descriptions concise and trigger-focused. Every word costs tokens across every single conversation.

### Body Budget

When a skill is triggered, its body (everything below the frontmatter) is loaded into context. The body is capped at 2% of the context window, which is approximately 16,000 characters by default.

This cap can be overridden via the `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable:

```bash
# Increase body budget to 32k chars
export SLASH_COMMAND_TOOL_CHAR_BUDGET=32000
```

**Practical limit**: keep skill bodies under 500 lines. Use the progressive disclosure pattern -- put core workflow in SKILL.md and detailed reference material in `references/` files that Claude loads on demand.

### Budget-Aware Design

```
Always loaded (~200 tokens each):
  skill-1 description
  skill-2 description
  ...
  skill-N description

Loaded on trigger (~2% of context):
  SKILL.md body

Loaded on demand (no fixed limit):
  references/detail-a.md
  references/detail-b.md
  scripts/tool.py (executed, not loaded)
```

## Skill Types Summary

| Type | Frontmatter | Use Case |
|---|---|---|
| **Task** | (defaults) | Interactive workflows users invoke by name -- code analysis, deployment, file processing |
| **Background** | `user-invocable: false` | Domain knowledge Claude applies autonomously -- coding standards, schemas, policies |
| **Protected** | `disable-model-invocation: true` | Side-effect workflows requiring explicit user intent -- deploys, sends, mutations |
| **Subagent** | `context: fork` | Self-contained tasks that run in isolation -- research, analysis, generation from scratch |
