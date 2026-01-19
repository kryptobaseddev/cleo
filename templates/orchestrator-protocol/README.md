# Orchestrator Protocol Templates

Reusable templates for the CLEO Orchestrator Protocol.

## Quick Start

### 1. Enable Protocol (Skill-Based - Recommended)

```bash
# Option A: On-demand activation
# Say "activate orchestrator mode" or use Skill tool

# Option B: Install to project for persistent availability
cleo orchestrator skill --install
```

### 2. Initialize Research Directory

```bash
cleo research init
```

### 3. Start Orchestrating

```bash
cleo orchestrator start --epic T001
cleo orchestrator spawn T002
```

## Activation Methods

| Method | When to Use | How |
|--------|-------------|-----|
| Skill (recommended) | Most workflows | `Skill: orchestrator` or natural language |
| CLI install | Persistent project setup | `cleo orchestrator skill --install` |
| CLAUDE.md injection | **DEPRECATED** | Do not use |

**Why skill-based?** See [migration notes](#legacy-claudemd-injection-deprecated) below.

## Directory Structure

```
orchestrator-protocol/
  ORCHESTRATOR-INJECT.md    # DEPRECATED - Reference only
  README.md                  # This file
  subagent-prompts/          # Spawn templates
    BASE-SUBAGENT-PROMPT.md  # Core protocol block
    TASK-EXECUTOR.md         # General task execution
    RESEARCH-AGENT.md        # Research and investigation
    EPIC-CREATOR.md          # Epic planning
    VALIDATOR.md             # Testing and validation
```

## Templates

### ORCHESTRATOR-INJECT.md (DEPRECATED)

> **WARNING**: This file is deprecated. Use skill-based activation instead.
> Kept for reference only.

Historical injection block for CLAUDE.md. Contains:
- 5 immutable ORC constraints
- Session startup protocol
- Subagent spawning rules
- Manifest query patterns
- Context protection rules

**Size**: ~1.8K tokens

### Subagent Prompts

| Template | Use Case | Size |
|----------|----------|------|
| BASE-SUBAGENT-PROMPT | Protocol block only | ~500 tokens |
| TASK-EXECUTOR | General task work | ~800 tokens |
| RESEARCH-AGENT | Research tasks | ~700 tokens |
| EPIC-CREATOR | Planning epics | ~900 tokens |
| VALIDATOR | Testing/validation | ~700 tokens |

### Placeholders

Templates use `{PLACEHOLDER}` syntax:

| Placeholder | Description |
|-------------|-------------|
| `{TASK_ID}` | CLEO task ID (e.g., T1586) |
| `{TASK_TITLE}` | Task title |
| `{TASK_NAME}` | Slugified task name |
| `{EPIC_ID}` | Parent epic ID |
| `{EPIC_TITLE}` | Parent epic title |
| `{SESSION_ID}` | Current session ID |
| `{DATE}` | Today's date (YYYY-MM-DD) |
| `{OUTPUT_DIR}` | Research output directory |
| `{TOPIC_SLUG}` | Slugified topic name |
| `{DEPENDS_LIST}` | Comma-separated dependencies |
| `{MANIFEST_SUMMARIES}` | Key findings from prior agents |
| `{TASK_INSTRUCTIONS}` | Task description |

## Usage

### CLI (Recommended)

```bash
# Auto-fills all placeholders
cleo orchestrator spawn T1586

# With specific template
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
```

### Manual

1. Read template:
```bash
cat templates/orchestrator-protocol/subagent-prompts/TASK-EXECUTOR.md
```

2. Replace placeholders manually

3. Spawn via Task tool

## Customization

### Add New Template

1. Copy `BASE-SUBAGENT-PROMPT.md` to new file
2. Add task-specific sections
3. Use standard placeholders
4. Keep under 1K tokens

### Modify Existing

Edit templates in `subagent-prompts/`. Changes take effect on next spawn.

## Legacy: CLAUDE.md Injection (DEPRECATED)

> **Do NOT use CLAUDE.md injection for the orchestrator protocol.**

**Why deprecated?**

CLAUDE.md injection affects ALL agents including subagents, breaking the orchestrator pattern:

| Problem | Impact |
|---------|--------|
| Subagents read CLAUDE.md | They also try to orchestrate |
| Context overhead | Orchestrator rules loaded in every agent |
| Role confusion | Workers try to delegate instead of execute |
| Protocol violations | Nested orchestration breaks dependency tracking |

**Migration steps:**

1. Remove any `<!-- ORCHESTRATOR:START -->` blocks from your CLAUDE.md
2. Run: `cleo orchestrator skill --install`
3. Activate skill when orchestrator mode is needed

## Documentation

- [Orchestrator Protocol Guide](../../docs/guides/ORCHESTRATOR-PROTOCOL.md)
- [CLI Reference](../../docs/commands/orchestrator.md)
- [Example Session](../../docs/examples/orchestrator-example-session.md)
- [Skill Directory](../../skills/orchestrator/README.md)
