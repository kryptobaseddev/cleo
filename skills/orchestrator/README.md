# Orchestrator Skill

Activate orchestrator mode for managing complex multi-agent workflows.

## Quick Start

1. **Activate**: Say "activate orchestrator mode" or use Skill tool
2. **Operate**: Follow ORC-001 through ORC-005 constraints
3. **Delegate**: Use Task tool to spawn subagents for all work

## Installation

### Option A: On-Demand (Recommended)

Simply invoke the skill when needed:
```
# Natural language
"activate orchestrator mode"
"run as orchestrator"
"orchestrate this workflow"

# Or Skill tool
Skill: orchestrator
```

### Option B: Project Installation

Install to your project for persistent availability:
```bash
cleo orchestrator skill --install    # Copy to .cleo/skills/
cleo orchestrator skill --verify     # Verify installation
```

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Main skill definition (loaded by Claude Code) |
| `INSTALL.md` | Detailed installation instructions |
| `README.md` | This file |
| `references/` | Additional documentation and templates |

## Key Principle

**Only YOU (the HITL-facing session) become an orchestrator.**

Your subagents do NOT inherit this skill and operate normally as task executors.
This is the critical difference from CLAUDE.md injection, which affected all agents.

## Constraints (ORC)

| ID | Rule | Enforcement |
|----|------|-------------|
| ORC-001 | Stay high-level | NO implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries ONLY |
| ORC-004 | Dependency order | No overlapping agents |
| ORC-005 | Context budget | Stay under 10K tokens |

## Why Skill-Based?

| Problem with CLAUDE.md injection | Skill-based solution |
|----------------------------------|---------------------|
| ALL agents read CLAUDE.md | Skills load ON-DEMAND |
| Subagents ALSO try to orchestrate | Subagents do NOT inherit skills |
| Breaks delegation pattern | Only HITL session operates as orchestrator |
| Always loaded (context overhead) | Loaded when activated |

## Related Documentation

- [Orchestrator Protocol Guide](../../docs/guides/ORCHESTRATOR-PROTOCOL.md)
- [CLI Reference](../../docs/commands/orchestrator.md)
- [Subagent Protocol Block](references/SUBAGENT-PROTOCOL-BLOCK.md)
