# SKILL.md Frontmatter Schema

## Required Fields

```yaml
name: string           # hyphen-case, max 64 chars, must match directory name
description: string    # max 1024 chars, no < or >, use quoted strings not >-/| multiline
```

## Optional Fields

```yaml
argument-hint: string            # max 100 chars; shown in /name autocomplete
disable-model-invocation: bool   # true = user-only invoke; description removed from context
user-invocable: bool             # false = hidden from /menu; Claude still sees description
allowed-tools: string | list     # pre-approved tools; Bash(pattern) for restricted bash
model: string                    # model ID override for this skill
context: "fork"                  # isolated subagent; no conversation history
agent: string                    # Explore | Plan | general-purpose | <custom>
hooks: dict                      # PreToolUse | PostToolUse | Stop handlers
license: string                  # e.g. MIT
```

## FORBIDDEN in SKILL.md (belongs in manifest.json)

```
version, tier, core, category, protocol, dependencies, sharedResources,
compatibility, token_budget, capabilities, constraints, metadata, tags, triggers
```

## Copy-Paste Template

```yaml
---
name: skill-name
description: "What this skill does and WHEN to use it. Max 1024 chars. Third person."
# argument-hint: "[optional-arg]"
# disable-model-invocation: true
# user-invocable: false
# allowed-tools: Read, Grep, Glob
# model: claude-sonnet-4-6
# context: fork
# agent: Explore
# hooks:
#   PreToolUse:
#     - matcher: Bash
#       command: "echo 'invoked' >> /tmp/audit.log"
# license: MIT
---
```

## Invocation Matrix

| Config | User /slash | Claude auto | Description in ctx |
|--------|------------|-------------|-------------------|
| (default) | Yes | Yes | Yes |
| `disable-model-invocation: true` | Yes | No | No |
| `user-invocable: false` | No | Yes | Yes |
| Both above | No | No | No |

## YAML Pitfalls

**Use quoted strings for description** — `>-` and `|` fold/preserve newlines unexpectedly:
```yaml
# BAD
description: >-
  Deploy applications to staging
  with pre-flight checks.

# GOOD
description: "Deploy applications to staging with pre-flight checks."
```

**Booleans must be unquoted:**
```yaml
disable-model-invocation: true    # correct
disable-model-invocation: "true"  # wrong — this is a string
```

**Quote strings with special chars** (`:` followed by space, `#`, `>`):
```yaml
description: "Note: handles edge cases"   # needs quotes due to colon
```
