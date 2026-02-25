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

See [SKILL.md](SKILL.md) for quick reference or [ORCHESTRATOR-PROTOCOL-SPEC.md](../../docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md#21-core-constraints) for full specification.

**Summary**: ORC-001 (high-level) | ORC-002 (delegate) | ORC-003 (no full reads) | ORC-004 (dependency order) | ORC-005 (10K budget)

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
