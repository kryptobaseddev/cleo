# Installing the Orchestrator Skill

## For Claude Code Plugin Projects

1. Copy `skills/orchestrator/` directory to your project's skills directory
2. Skill will be auto-discovered by Claude Code plugin system
3. Invoke via `/orchestrator` command or Skill tool

## Manual Invocation

Use the Skill tool directly:

```
Skill: orchestrator
```

Or natural language triggers:
- "activate orchestrator mode"
- "run as orchestrator"
- "orchestrate this workflow"
- "delegate to subagents"

## Verification

After activation, you should see the Orchestrator Protocol constraints loaded.
Test by asking Claude to explain ORC-001 through ORC-005:

```
What are the ORC constraints for orchestrator mode?
```

Expected response should include:
- ORC-001: Stay high-level
- ORC-002: Delegate ALL work
- ORC-003: No full file reads
- ORC-004: Dependency order
- ORC-005: Context budget

## Why Skill-Based Delivery?

The skill approach is preferred over CLAUDE.md injection because:

1. **Selective Activation**: Only the HITL orchestrator agent receives the protocol
2. **Subagent Isolation**: Subagents spawn without orchestrator constraints
3. **On-Demand Loading**: Reduces context overhead when not in orchestrator mode
4. **Clean Separation**: Orchestrator vs worker roles are architecturally distinct

## Directory Structure

```
skills/
  orchestrator/
    SKILL.md      # Main skill definition with frontmatter
    INSTALL.md    # This file
```

## Dependencies

- CLEO task management (`cleo` CLI)
- Research manifest system (`docs/claudedocs/research-outputs/MANIFEST.jsonl`)
- Task tool for subagent spawning
