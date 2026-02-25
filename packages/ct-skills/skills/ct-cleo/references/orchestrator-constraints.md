# Orchestrator Constraints (Detailed)

## ORC Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| ORC-001 | Stay high-level | NO implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries ONLY |
| ORC-004 | Dependency order | Sequential spawning per wave |
| ORC-005 | Context budget | Stay under 10K tokens |
| ORC-006 | Max 3 files per agent | Scope limit per spawn |
| ORC-007 | All work traced to Epic | No orphaned work |
| ORC-008 | Zero architectural decisions | Must be pre-decided by HITL |

## Spawn Pipeline

### MCP Spawn Operations

```
# Analyze dependency waves
cleo_query({ domain: "orchestrate", operation: "analyze", params: { epicId: "T001" }})

# Get ready tasks
cleo_query({ domain: "orchestrate", operation: "ready", params: { epicId: "T001" }})

# Get next task suggestion
cleo_query({ domain: "orchestrate", operation: "next", params: { epicId: "T001" }})
```

### CLI Spawn Operations

```bash
cleo orchestrator start --epic T001
cleo orchestrator analyze T001
cleo orchestrator ready --epic T001
cleo orchestrator next --epic T001
cleo orchestrator spawn T002
```

### Spawn Workflow

1. Select skill protocol for task (auto-dispatch or explicit)
2. Prepare spawn context (resolve ALL tokens)
3. Verify `tokenResolution.fullyResolved == true`
4. Spawn `cleo-subagent` with resolved prompt via Task tool

### Token Pre-Resolution

**CRITICAL**: Orchestrator MUST resolve ALL tokens before spawn. Verify:
- All `@` references resolved
- All `{{TOKEN}}` placeholders substituted
- `tokenResolution.fullyResolved == true`
- Task exists (`cleo exists T####`)
- Output directory exists
